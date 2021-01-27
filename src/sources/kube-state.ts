import {
  autoDetectKubernetesClient,
  CoreV1,
  AppsV1,
  MetaV1,
  DatadogApi, MetricSubmission,
  ReadLineTransformer,
  CheckStatus,
} from '../deps.ts';

const datadog = DatadogApi.fromEnvironment(Deno.env);

interface RawMetric {
  name: string;
  help?: string;
  unit?: string;
  type: string;
  datas: Array<MetricPoint>;
};
interface MetricPoint {
  submetric: string;
  labelset: string;
  tags: [string, string][];
  facets: Record<string,string>;
  value: number;
  rawValue: string;
};

const kubernetes = await autoDetectKubernetesClient();
const coreApi = new CoreV1.CoreV1Api(kubernetes);
const appsApi = new AppsV1.AppsV1Api(kubernetes);

export async function* buildKubeStateMetrics(baseTags: string[]): AsyncGenerator<MetricSubmission,any,undefined> {

  try {
    yield* grabKubeStateMetrics(baseTags);
  } catch (err: unknown) {
    const type = (err instanceof Error) ? err.name : typeof err;
    yield {
      metric_name: `app.loop.error`,
      points: [{value: 1}],
      interval: 60,
      metric_type: 'count',
      tags: [...baseTags,
        `source:openmetrics`,
        `error:${type}`,
      ],
    };
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
}): Generator<MetricSubmission,any,undefined> {

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

export async function* grabKubeStateMetrics(baseTags: string[]): AsyncGenerator<MetricSubmission,any,undefined> {

  const daemonsetList = await appsApi.getDaemonSetListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of daemonsetList.items) {
    yield* makeControllerMetrics({
      baseTags,
      kind: 'daemonset',
      metadata: contr.metadata!,
      desiredReplicas: contr.status?.desiredNumberScheduled ?? 0,
      availableReplicas: contr.status?.numberAvailable ?? 0,
      unavailableReplicas: contr.status?.numberUnavailable ?? 0,
    });
  }

  const deploymentList = await appsApi.getDeploymentListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of deploymentList.items) {
    yield* makeControllerMetrics({
      baseTags,
      kind: 'deployment',
      metadata: contr.metadata!,
      desiredReplicas: contr.spec?.replicas ?? 0,
      availableReplicas: contr.status?.availableReplicas ?? 0,
      unavailableReplicas: contr.status?.unavailableReplicas ?? 0,
    });
  }

  const statefulsetList = await appsApi.getStatefulSetListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const contr of statefulsetList.items) {
    yield* makeControllerMetrics({
      baseTags,
      kind: 'statefulset',
      metadata: contr.metadata!,
      desiredReplicas: contr.spec?.replicas ?? 0,
      availableReplicas: contr.status?.readyReplicas ?? 0,
      // there is no unavailable...
    });
  }

  const nodeList = await coreApi.getNodeList({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const node of nodeList.items) {
    const tags = [ ...baseTags, `kube_node:${node.metadata!.name}` ];

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
        // TODO: side-effect
        await datadog.v1ServiceChecks.submit({
          check_name: 'kube_state.node.ready',
          host_name: node.metadata!.name!,
          message: condition.message ?? undefined,
          status, tags,
        });
      }
    }

    yield { tags, metric_type, interval,
      metric_name: 'kube_state.node.unschedulable',
      points: [{value: node.spec?.unschedulable ? 1 : 0}]};

    // TODO: kube_node_status_capacity
    // TODO: kube_node_status_allocatable
  }

  const podList = await coreApi.getPodListForAllNamespaces({
    resourceVersion: '0', // old data is ok... ish
  });
  for (const pod of podList.items) {
    const tags = [ ...baseTags, `kube_pod:${pod.metadata!.name}` ];

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
    let memory = containerMemory.get(memoryKey);
    if (!memory) {
      memory = new Map<string,number>();
      containerMemory.set(memoryKey, memory);
    }

    for (const container of pod.status?.containerStatuses ?? []) {
      yield* reportMonotonic('kube_state.container.restarts.total', container.restartCount, [...tags, `container_type:regular`, `kube_container:${container.name}`], memory, `${memoryKey}:restarts:${container.name}`);
    }
    for (const container of pod.status?.initContainerStatuses ?? []) {
      yield* reportMonotonic('kube_state.container.restarts.total', container.restartCount, [...tags, `container_type:init`, `kube_container:${container.name}`], memory, `${memoryKey}:restarts:${container.name}`);
    }
    for (const container of pod.status?.ephemeralContainerStatuses ?? []) {
      yield* reportMonotonic('kube_state.container.restarts.total', container.restartCount, [...tags, `container_type:ephemeral`, `kube_container:${container.name}`], memory, `${memoryKey}:restarts:${container.name}`);
    }

    // TODO: kube_pod_container_resource_requests
    // TODO: kube_pod_container_resource_limits
  }

}

const containerMemory = new Map<string,Map<string,number>>();

function reportMonotonic(
  metric_name: string,
  raw_value: number,
  tags: string[],
  monotonicMemory: Map<string,number>,
  monotonicKey: string | false,
): MetricSubmission[] {

  if (monotonicKey) {
    const lastSeen = monotonicMemory.get(monotonicKey);
    monotonicMemory.set(monotonicKey, raw_value);
    // console.log(monotonicKey, raw_value, lastSeen);
    if (typeof lastSeen === 'number') {
      raw_value -= lastSeen;
      if (raw_value < 0) return [];
    } else {
      return [];
    }
  }

  return [{
    metric_name,
    points: [{value: raw_value}],
    interval: 30,
    metric_type: 'count',
    tags,
  }];
}
