import {
  CoreV1,
  AppsV1,
  MetaV1,
  CheckStatus,
} from '../deps.ts';
import { KubeWatcher } from "../lib/kube-watcher.ts";
import {
  AsyncMetricGen,
  SyncMetricGen,
  makeLoopErrorPoint,
  MonotonicMemory,
} from '../lib/metrics.ts';

// upstream's sources per kind:
// https://github.com/kubernetes/kube-state-metrics/tree/master/internal/store

export async function* buildKubeStateMetrics(baseTags: string[], watcher: KubeWatcher): AsyncMetricGen {
  try {
    yield* grabKubeStateMetrics(baseTags, watcher);
  } catch (err: unknown) {
    yield makeLoopErrorPoint(err, [ ...baseTags,
      `source:openmetrics`,
    ]);
  }
}

const metric_type = 'gauge';
const interval = 30;

function* makeControllerMetrics(opts: {
  baseTags: string[];
  kind: string;
  metadata: MetaV1.ObjectMeta;
  desiredReplicas: number;
  availableReplicas: number;
  unavailableReplicas?: number;
}): SyncMetricGen {

  const tags = [ ...opts.baseTags,
    `kube_kind:${opts.kind}`,
    `kube_namespace:${opts.metadata.namespace}`,
    `kube_name:${opts.metadata.name}`,
  ];

  yield { tags, metric_type, interval,
    metric_name: 'kube_state.controller.desired_replicas',
    points: [{value: opts.desiredReplicas}],
  };
  yield { tags, metric_type, interval,
    metric_name: 'kube_state.controller.available_replicas',
    points: [{value: opts.availableReplicas}],
  };
  if (opts.unavailableReplicas != null) {
    yield { tags, metric_type, interval,
      metric_name: 'kube_state.controller.unavailable_replicas',
      points: [{value: opts.unavailableReplicas}],
    };
  }
}

const podMemories = new Map<string,MonotonicMemory>();

export async function* grabKubeStateMetrics(baseTags: string[], watcher: KubeWatcher): AsyncMetricGen {

  for (const contr of watcher.daemonsetReflector.listCached()) {
    yield* observeDaemonset(contr, baseTags);
  }

  for (const contr of watcher.deploymentReflector.listCached()) {
    yield* observeDeployment(contr, baseTags);
  }

  for (const contr of watcher.statefulsetReflector.listCached()) {
    yield* observeStatefulset(contr, baseTags);
  }

  for (const node of watcher.nodeReflector.listCached()) {
    yield* observeNode(node, baseTags);
  }

  for (const pod of watcher.podReflector.listCached()) {
    yield* observePod(pod, baseTags);
  }

}

function observeDaemonset(contr: AppsV1.DaemonSet, baseTags: string[]) {
  return makeControllerMetrics({
    baseTags,
    kind: 'daemonset',
    metadata: contr.metadata!,
    desiredReplicas: contr.status?.desiredNumberScheduled ?? 0,
    availableReplicas: contr.status?.numberAvailable ?? 0,
    unavailableReplicas: contr.status?.numberUnavailable ?? 0,
  });
}

function observeDeployment(contr: AppsV1.Deployment, baseTags: string[]) {
  return makeControllerMetrics({
    baseTags,
    kind: 'deployment',
    metadata: contr.metadata!,
    desiredReplicas: contr.spec?.replicas ?? 0,
    availableReplicas: contr.status?.availableReplicas ?? 0,
    unavailableReplicas: contr.status?.unavailableReplicas ?? 0,
  });
}

function observeStatefulset(contr: AppsV1.StatefulSet, baseTags: string[]) {
  return makeControllerMetrics({
    baseTags,
    kind: 'statefulset',
    metadata: contr.metadata!,
    desiredReplicas: contr.spec?.replicas ?? 0,
    availableReplicas: contr.status?.readyReplicas ?? 0,
    // there is no unavailable...
  });
}

function* observeNode(node: CoreV1.Node, baseTags: string[]): SyncMetricGen {
  const tags = [ ...baseTags,
    `kube_node:${node.metadata!.name}`
  ];

  for (const condition of node.status?.conditions ?? []) {
    let value = 0.5;
    let status = CheckStatus.Unknown;
    const isReadyCondition = condition.type === 'Ready';
    if (condition.status === (isReadyCondition ? 'True' : 'False')) {
      value = 1;
      status = CheckStatus.Ok;
    }
    if (condition.status === (isReadyCondition ? 'False' : 'True')) {
      value = -1;
      status = CheckStatus.Critical;
    }
    if (condition.status === 'Unknown') {
      value = (0.5 - Math.random()) / 2;
    }

    yield { metric_type, interval,
      metric_name: 'kube_state.node.condition',
      tags: [ ...tags,
        `kube_condition:${condition.type}`,
      ],
      points: [{value}]};

    if (isReadyCondition) {
      yield {
        metric_type: 'check',
        metric_name: 'kube_state.node.ready',
        host_name: node.metadata!.name!,
        message: condition.message ?? undefined,
        status, tags,
      };
      // datadog.v1ServiceChecks.submit({
      //   check_name: 'kube_state.node.ready',
      //   host_name: node.metadata!.name!,
      //   message: condition.message ?? undefined,
      //   status, tags,
      // });
    }
  }

  yield { tags, metric_type, interval,
    metric_name: 'kube_state.node.unschedulable',
    points: [{value: node.spec?.unschedulable ? 1 : 0}]};

  // TODO: kube_node_status_capacity
  // TODO: kube_node_status_allocatable
}

function* observePod(pod: CoreV1.Pod, baseTags: string[]): SyncMetricGen {
  const tags = [ ...baseTags,
    `kube_namespace:${pod.metadata!.namespace}`,
    `kube_pod:${pod.metadata!.name}`
  ];

  if (pod.spec?.nodeName) {
    tags.push(`kube_node:${pod.spec.nodeName}`);
  }

  for (const x of pod.metadata!.ownerReferences ?? []) {
    if (!x.controller) continue;
    tags.push(`kube_${x.kind}:${x.name}`);
    if (x.kind === 'ReplicaSet') {
      tags.push(`kube_deployment:${x.name.slice(0, x.name.lastIndexOf('-'))}`);
    }
  }

  for (const condition of pod.status?.conditions ?? []) {
    let value = 0.5;
    if (condition.status === 'True') {
      value = 1;
    }
    if (condition.status === 'False') {
      value = -1;
    }
    if (condition.status === 'Unknown') {
      value = (0.5 - Math.random()) / 2;
    }

    if (condition.type === 'Ready') {
      yield { tags, metric_type, interval,
        metric_name: 'kube_state.pod.ready',
        points: [{value}]};

    } else if (condition.type === 'PodScheduled') {
      yield { tags, metric_type, interval,
        metric_name: 'kube_state.pod.ready',
        points: [{value}]};
    }
  }

  let memory = podMemories.get(pod.metadata!.uid!);
  if (!memory) {
    memory = new MonotonicMemory();
    podMemories.set(pod.metadata!.uid!, memory);
  }

  for (const container of pod.status?.containerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:regular`, `kube_container:${container.name}`],
    });
  }
  for (const container of pod.status?.initContainerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:init`, `kube_container:${container.name}`],
    });
  }
  for (const container of pod.status?.ephemeralContainerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:ephemeral`, `kube_container:${container.name}`],
    });
  }

  // TODO: kube_pod_container_resource_requests
  // TODO: kube_pod_container_resource_limits
}
