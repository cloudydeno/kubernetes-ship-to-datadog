import {
  CoreV1,
  KubeConfigContext,
  fetchUsing,
  TlsDialer,
} from '../deps.ts';
import {
  AsyncMetricGen,
  SyncMetricGen,
  makeLoopErrorPoint,
} from '../lib/metrics.ts';
import { KubeWatcher } from "../lib/kube-watcher.ts";

import * as types from "../lib/kubelet-api.ts";

interface StatsSummary {
  node: NodeSummary;
  pods: Map<string, PodSummary>;
}
interface NodeSummary {
  cpu:               types.CPU;
  memory:            types.Memory;
  systemContainers:  Map<string, ContainerSummary>;
  network?:          types.Network;
  fs?:               types.FS;
  runtime?:          types.Runtime;
  rlimit?:           types.Rlimit;
}
interface PodSummary {
  podRef:               types.PodRef;
  containers:           Map<string, ContainerSummary>;
  cpu:                  types.CPU;
  memory:               types.Memory;
  network?:             types.Network;
  volume:               Map<string, types.FS>;
  "ephemeral-storage"?: types.FS;
}
interface ContainerSummary {
  name:                string;
  cpu:                 types.CPU;
  memory:              types.Memory;
  rootfs?:             types.FS;
  logs?:               types.FS;
  userDefinedMetrics:  Map<string, types.UserDefinedMetric>;
}
const memories = new Map<string, StatsSummary>();

export async function* buildKubeletMetrics(baseTags: string[], watcher: KubeWatcher, kubeContext: KubeConfigContext): AsyncMetricGen {
  for (const node of watcher.nodeReflector.listCached()) {
    try {
      yield* buildKubeletMetricsFromNode(baseTags, node, watcher.coreApi, kubeContext);

    } catch (err: unknown) {
      yield makeLoopErrorPoint(err, [...baseTags,
        `source:kubelet`,
        `source_name:${node.metadata.name}`,
      ]);
    }
  }
}

export async function* buildKubeletMetricsFromNode(baseTags: string[], node: CoreV1.Node, coreApi: CoreV1.CoreV1Api, kubeContext: KubeConfigContext): AsyncMetricGen {
  if (!node.metadata?.name || !node.status?.addresses) return;

  const readyCondition = node.status.conditions?.find(x => x.type === 'Ready');
  if (readyCondition?.status === 'Unknown') {
    console.log('Skipping unknown-health kubelet on', node.metadata.name);
    return;
  }

  const internalAddr = node.status.addresses
    .filter(x => x.type === 'InternalIP')
    .map(x => x.address)[0];
  if (!internalAddr) return;
  if (internalAddr.includes('<')) return; // <nil> from kube-pet-node

  const summary = Deno.args.includes('--proxied')
    ? await coreApi.proxyNodeRequest(node.metadata.name, {
        method: 'GET',
        path: '/stats/summary',
        expectJson: true,
      }) as unknown as types.StatsSummary
    : Deno.args.includes('--plaintext-kubelet')
    ? await fetch(`http://${internalAddr}:10255/stats/summary`)
      .then(x => x.json() as Promise<types.StatsSummary>)
    : await fetchFromKubelet(node, kubeContext, `https://${internalAddr}:10250/stats/summary`)
      .then(x => x.json() as Promise<types.StatsSummary>);

  const thisObs: StatsSummary = {
    node: {
      ...summary.node,
      systemContainers: new Map(summary.node.systemContainers?.map(x => [x.name, {
        ...x,
        userDefinedMetrics: new Map(x.userDefinedMetrics?.map(y => [y.name, y])),
      }])),
    },
    pods: new Map(summary.pods.map(x => [x.podRef.uid, {
      ...x,
      volume: new Map(x.volume?.map(x => [x.name, x])),
      containers: new Map(x.containers?.map(x => [x.name, {
        ...x,
        userDefinedMetrics: new Map(x.userDefinedMetrics?.map(y => [y.name, y])),
      }])),
    }])),
  };

  const prevObs = memories.get(node.metadata.name);

  const tags = [...baseTags,
    `host:${node.metadata.name}`,
    `kube_node:${node.metadata.name}`,
  ];

  yield* buildNodeMetrics(thisObs.node, prevObs?.node, tags);

  for (const [uid, podNow] of thisObs.pods) {
    const podPrev = prevObs?.pods?.get(uid);
    yield* buildPodMetrics(podNow, podPrev, [...tags,
      `kube_namespace:${podNow.podRef.namespace}`,
      `kube_pod:${podNow.podRef.name}`,
    ]);
  }

  memories.set(node.metadata.name, thisObs);
}

function* buildNodeMetrics(now: NodeSummary, before: NodeSummary | undefined, tags: string[]): SyncMetricGen {

  yield* buildBasicMetrics('kube.node.', now, before, tags);

  yield* buildNetworkMetrics('kube.node.', now, before, tags);

  if (now.systemContainers) {
    for (const [name, containerNow] of now.systemContainers) {
      const containerPrev = before?.systemContainers?.get(name);
      yield* buildContainerMetrics('kube.system.', containerNow, containerPrev, [...tags,
        `kube_container:${name}`,
      ]);
    }
  }

  if (now.fs) {
    yield* buildFsMetrics(`kube.node.`, now.fs, [ ...tags, `kube_fs_type:system` ]);
  }

  if (now.runtime?.imageFs) {
    yield* buildFsMetrics(`kube.node.`, now.runtime.imageFs, [ ...tags, `kube_fs_type:images` ]);
  }

  if (now.rlimit) {
    yield* buildRlimitMetrics(`kube.node.`, now.rlimit, tags);
  }
}

function* buildFsMetrics(prefix: string, fs: types.FS, tags: string[]): SyncMetricGen {
  const timestamp = new Date(fs.time);
  const interval = 30;
  const metric_type = 'gauge';

  yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.bytes_available`,
    points: [{ value: fs.availableBytes, timestamp }],
  };
  yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.bytes_total`,
    points: [{ value: fs.capacityBytes, timestamp }],
  };
  yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.bytes_used`,
    points: [{ value: fs.usedBytes, timestamp }],
  };

  if (typeof fs.inodesFree == 'number') yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.inodes_available`,
    points: [{ value: fs.inodesFree, timestamp }],
  };
  if (typeof fs.inodes == 'number') yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.inodes_total`,
    points: [{ value: fs.inodes, timestamp }],
  };
  if (typeof fs.inodesUsed == 'number') yield {
    interval, metric_type, tags,
    metric_name: `${prefix}filesystem.inodes_used`,
    points: [{ value: fs.inodesUsed, timestamp }],
  };
}

function* buildRlimitMetrics(prefix: string, data: types.Rlimit, tags: string[]): SyncMetricGen {
  const timestamp = new Date(data.time);
  const interval = 30;
  const metric_type = 'gauge';

  yield {
    interval, metric_type, tags,
    metric_name: `${prefix}processes.max`,
    points: [{ value: data.maxpid, timestamp }],
  };
  yield {
    interval, metric_type, tags,
    metric_name: `${prefix}processes.current`,
    points: [{ value: data.curproc, timestamp }],
  };
}

type BasicSummary = NodeSummary | PodSummary | ContainerSummary;
function* buildBasicMetrics(prefix: string, now: BasicSummary, before: BasicSummary | undefined, tags: string[]): SyncMetricGen {

  if (before?.cpu && now.cpu.usageCoreNanoSeconds >= before.cpu.usageCoreNanoSeconds) {
    const timestamp = new Date(now.cpu.time);
    const secondsConsumed = (now.cpu.usageCoreNanoSeconds - before.cpu.usageCoreNanoSeconds) / 1000 / 1000 / 1000;
    yield {
      metric_name: prefix+`cpu_seconds`,
      points: [{value: secondsConsumed, timestamp}],
      interval: 30,
      metric_type: 'count',
      tags,
    };

    const secondsPassed = (timestamp.valueOf() - new Date(before.cpu.time).valueOf()) / 1000;
    yield {
      metric_name: prefix+`cpu_cores`,
      points: [{value: secondsConsumed / secondsPassed, timestamp}], // TODO: move point back to the middle?
      interval: 30,
      metric_type: 'gauge',
      tags,
    };
  }

  if (now.memory) {
    const timestamp = new Date(now.memory.time);
    yield {
      metric_name: prefix+`memory.used_bytes`,
      points: [{value: now.memory.workingSetBytes, timestamp}],
      interval: 30,
      metric_type: 'gauge',
      tags,
    };
    if (now.memory.availableBytes) yield {
      metric_name: prefix+`memory.available_bytes`,
      points: [{value: now.memory.availableBytes, timestamp}],
      interval: 30,
      metric_type: 'gauge',
      tags,
    };
    if (now.memory.rssBytes) yield {
      metric_name: prefix+`memory.rss_bytes`,
      points: [{value: now.memory.rssBytes, timestamp}],
      interval: 30,
      metric_type: 'gauge',
      tags,
    };
    if (before?.memory && typeof now.memory.pageFaults === 'number') yield {
      metric_name: prefix+`memory.page_faults`,
      points: [{value: now.memory.pageFaults - (before.memory.pageFaults ?? 0), timestamp}],
      interval: 30,
      metric_type: 'count',
      tags,
    };
  }

  // network?:          types.Network;
}

function* buildNetworkMetrics(prefix: string, now: NodeSummary | PodSummary, before: NodeSummary | PodSummary | undefined, tags: string[]): SyncMetricGen {
  if (!now.network) return;
  const timestamp = new Date(now.network.time);

  const defaultIface = now.network.name;
  if (defaultIface) {
    yield* buildNetworkIfaceMetrics(prefix, timestamp, now.network, before?.network, [...tags, 'primary_iface']);
  } else if (prefix.includes('pod')) {
    // We don't emit network metrics for pods without a default network,
    // because these seem to be hostNetwork pods and they will just double-count host traffic.
    return;
  }

  for (const iface of now.network.interfaces ?? []) {
    if (iface.name == defaultIface) continue;
    if (iface.name.startsWith('cali')) continue; // ignore calico interfaces
    const ifaceBefore = before?.network?.interfaces?.find(x => x.name === iface.name);
    yield* buildNetworkIfaceMetrics(prefix, timestamp, iface, ifaceBefore, [...tags]);
  }
}

function* buildNetworkIfaceMetrics(prefix: string, timestamp: Date, now: types.Interface, before: types.Interface | undefined, tags: string[]): SyncMetricGen {

  if (before && now) {

    yield {
      metric_name: prefix+`net.rx_bytes`,
      points: [{value: now.rxBytes - before.rxBytes, timestamp}],
      interval: 30,
      metric_type: 'count',
      tags: [...tags,
        `interface:${now.name}`,
      ],
    };
    if (typeof now.rxErrors === 'number') yield {
      metric_name: prefix+`net.rx_errors`,
      points: [{value: now.rxErrors - (before.rxErrors ?? 0), timestamp}],
      interval: 30,
      metric_type: 'count',
      tags: [...tags,
        `interface:${now.name}`,
      ],
    };

    yield {
      metric_name: prefix+`net.tx_bytes`,
      points: [{value: now.txBytes - before.txBytes, timestamp}],
      interval: 30,
      metric_type: 'count',
      tags: [...tags,
        `interface:${now.name}`,
      ],
    };
    if (typeof now.txErrors === 'number') yield {
      metric_name: prefix+`net.tx_errors`,
      points: [{value: now.txErrors - (before.txErrors ?? 0), timestamp}],
      interval: 30,
      metric_type: 'count',
      tags: [...tags,
        `interface:${now.name}`,
      ],
    };

  }

}

function* buildPodMetrics(now: PodSummary, before: PodSummary | undefined, tags: string[]): SyncMetricGen {

  for (const [name, containerNow] of now.containers) {
    const containerPrev = before?.containers?.get(name);
    yield* buildContainerMetrics('kube.pod.', containerNow, containerPrev, [...tags,
      `kube_container:${name}`,
    ]);
  }

  yield* buildNetworkMetrics('kube.pod.', now, before, tags);

  // These seem to mostly be mounted configmaps/etc and not really providing anything useful
  // hostpath mounts aren't incldued
  // volume?:              (FS & {name: string})[];

  if (now['ephemeral-storage']) {
    // This is a sum of all usage from containers, including logs
    yield* buildFsMetrics('kube.pod.', now['ephemeral-storage'], [ ...tags, `kube_fs_type:ephemeral` ]);
  }
}

function* buildContainerMetrics(prefix: string, now: ContainerSummary, before: ContainerSummary | undefined, tags: string[]): SyncMetricGen {

  yield* buildBasicMetrics(prefix, now, before, tags);

  if (now.rootfs) {
    yield* buildFsMetrics(prefix, now.rootfs, [ ...tags, `kube_fs_type:rootfs` ]);
  }
  if (now.logs) {
    yield* buildFsMetrics(prefix, now.logs, [ ...tags, `kube_fs_type:logs` ]);
  }

  // userDefinedMetrics?: Map<string, types.UserDefinedMetric>;

  for (const [name, containerNow] of now.userDefinedMetrics) {
    const containerPrev = before?.userDefinedMetrics?.get(name);
    const timestamp = new Date(containerNow.time);

    if (containerNow.type === 'gauge') {
      yield {
        metric_name: prefix+containerNow.name,
        points: [{value: containerNow.value, timestamp}],
        interval: 30,
        metric_type: 'gauge',
        tags, // TODO: technically custom metrics can have their own custom tags too...
      };
    } else if (containerNow.type === 'cumulative') {
      if (containerPrev) yield {
        metric_name: prefix+containerNow.name,
        points: [{value: containerNow.value - (containerPrev.value ?? 0), timestamp}],
        interval: 30,
        metric_type: 'count',
        tags, // TODO: technically custom metrics can have their own custom tags too...
      };
    } // TODO: can we even do delta right?
  }

}

/**
 * Somewhat-hacky helper for directly accessing encrypted and authenticated endpoints on a node's kubelet
 */
async function fetchFromKubelet(node: CoreV1.Node, kubeContext: KubeConfigContext, url: string) {
  // Load the TLS authority for the cluster
  // TODO: This sort of file loading needs to be handled by /x/kubernetes_client, to fix relative paths
  let serverCert = atob(kubeContext.cluster["certificate-authority-data"] ?? "");
  if (!serverCert && kubeContext.cluster["certificate-authority"]) {
    serverCert = await Deno.readTextFile(kubeContext.cluster["certificate-authority"]);
  }

  // Build an auth header for the user, if any
  const headers = new Headers();
  const authHeader = await kubeContext.getAuthHeader();
  if (authHeader) {
    headers.set("authorization", authHeader);
  }

  const dialer = new TlsDialer({
    caCerts: serverCert ? [serverCert] : [],
    hostname: node.metadata?.name ?? undefined,
  });
  return fetchUsing(dialer, url, { headers });
}
