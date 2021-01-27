import {
  autoDetectKubernetesClient,
  KubernetesClient,
  Reflector,
  CoreV1,
  AppsV1,
  MetaV1,
  CheckStatus,
} from '../deps.ts';
import {
  AsyncMetricGen,
  SyncMetricGen,
  makeLoopErrorPoint,
  MonotonicMemory,
} from '../lib/metrics.ts';

const kubernetes = await autoDetectKubernetesClient();
const coreApi = new CoreV1.CoreV1Api(kubernetes);
const appsApi = new AppsV1.AppsV1Api(kubernetes);

// upstream's sources per kind:
// https://github.com/kubernetes/kube-state-metrics/tree/master/internal/store

export async function* buildKubeStateMetrics(baseTags: string[]): AsyncMetricGen {
  try {
    yield* grabKubeStateMetrics(baseTags);
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

const containerMemories = new Map<string,MonotonicMemory>();

class KubeStateWatcher {
  constructor(
    private kubeClient: KubernetesClient,
  ) {}
  coreApi = new CoreV1.CoreV1Api(this.kubeClient);
  appsApi = new AppsV1.AppsV1Api(this.kubeClient);

  daemonsetReflector = new Reflector(
    opts => this.appsApi.getDaemonSetListForAllNamespaces(opts),
    opts => this.appsApi.watchDaemonSetListForAllNamespaces(opts));
  deploymentReflector = new Reflector(
    opts => this.appsApi.getDeploymentListForAllNamespaces(opts),
    opts => this.appsApi.watchDeploymentListForAllNamespaces(opts));
  statefulsetReflector = new Reflector(
    opts => this.appsApi.getStatefulSetListForAllNamespaces(opts),
    opts => this.appsApi.watchStatefulSetListForAllNamespaces(opts));
  nodeReflector = new Reflector(
    opts => this.coreApi.getNodeList(opts),
    opts => this.coreApi.watchNodeList(opts));
  podReflector = new Reflector(
    opts => this.coreApi.getPodListForAllNamespaces(opts),
    opts => this.coreApi.watchPodListForAllNamespaces(opts));

  startAll() {
    this.daemonsetReflector.run();
    this.deploymentReflector.run();
    this.statefulsetReflector.run();
    this.nodeReflector.run();
    this.podReflector.run();
    // return Promise.all([
    //   this.daemonsetReflector
    // ])
  }
}

export async function* grabKubeStateMetrics(baseTags: string[]): AsyncMetricGen {

  const daemonsetList = await appsApi.getDaemonSetListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of daemonsetList.items) {
    yield* observeDaemonset(contr, baseTags);
  }

  const deploymentList = await appsApi.getDeploymentListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of deploymentList.items) {
    yield* observeDeployment(contr, baseTags);
  }

  const statefulsetList = await appsApi.getStatefulSetListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of statefulsetList.items) {
    yield* observeStatefulset(contr, baseTags);
  }

  const nodeList = await coreApi.getNodeList({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const node of nodeList.items) {
    yield* observeNode(node, baseTags);
  }

  const podList = await coreApi.getPodListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const pod of podList.items) {
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

  const memoryKey = JSON.stringify(tags);
  let memory = containerMemories.get(memoryKey);
  if (!memory) {
    memory = new MonotonicMemory();
    containerMemories.set(memoryKey, memory);
  }

  for (const container of pod.status?.containerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `${memoryKey}:restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:regular`, `kube_container:${container.name}`],
    });
  }
  for (const container of pod.status?.initContainerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `${memoryKey}:restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:init`, `kube_container:${container.name}`],
    });
  }
  for (const container of pod.status?.ephemeralContainerStatuses ?? []) {
    yield* memory.reportCount(container.restartCount, `${memoryKey}:restarts:${container.name}`, {
      metric_name: 'kube_state.container.restarts.total',
      tags: [...tags, `container_type:ephemeral`, `kube_container:${container.name}`],
    });
  }

  // TODO: kube_pod_container_resource_requests
  // TODO: kube_pod_container_resource_limits
}
