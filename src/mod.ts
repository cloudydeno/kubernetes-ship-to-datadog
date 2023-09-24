import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  runMetricsServer, replaceGlobalFetch,
  ows,
  autoDetectKubernetesClient,
  KubeConfig,
} from './deps.ts';
import {
  AsyncMetricGen,
  SyncMetricGen,
  CheckSubmission,
} from './lib/metrics.ts';

import { KubeWatcher } from './lib/kube-watcher.ts';
import { buildKubeletMetrics } from './sources/kubelet-stats.ts';
import { buildKubeStateMetrics } from './sources/kube-state.ts';
import { buildOpenMetrics } from './sources/openmetrics.ts';
import { buildBlockDeviceMetrics } from './sources/pet-blockdevices.ts';
import { buildApiserverMetrics } from "./sources/apiserver.ts";

if (Deno.args.includes('--serve-metrics')) {
  replaceGlobalFetch();
  runMetricsServer({ port: 9090 });
  console.log("Now serving OpenMetrics @ :9090/metrics");
}

const datadog = DatadogApi.fromEnvironment(Deno.env);

const kubeConfig = await KubeConfig.getInClusterConfig()
  .catch(() => KubeConfig.getDefaultConfig());
const kubeContext = kubeConfig.fetchContext();

const kubeClient = await autoDetectKubernetesClient();
const kubeWatcher = new KubeWatcher(kubeClient);
const isInSync = kubeWatcher.startAll();
for (let x = 0; x < 5; x++) {
  if (isInSync()) break;
  console.log('Waiting longer for Kubernetes sync...');
  await new Promise(ok => setTimeout(ok, 1000));
}

async function* buildDogMetrics(dutyCycle: number): AsyncMetricGen {
  const clusterName = Deno.env.get('DATADOG_CLUSTER_TAG') || 'none';
  const commonTags = [
    `cluster:${clusterName}`,
  ];

  // Scrape all autodiscovered OpenMetrics (or Prometheus) pods
  yield* buildOpenMetrics(commonTags, kubeClient, kubeWatcher);

  // Basic scheduling & health from the cluster's control plane
  yield* buildKubeStateMetrics(commonTags, kubeWatcher);

  // By-Node stats summaries scraped directly from kubelet
  yield* buildKubeletMetrics(commonTags, kubeWatcher, kubeContext);

  // By-Node stats summaries scraped directly from apiserver
  // (Only works in non-HA clusters)
  yield* buildApiserverMetrics(commonTags, kubeClient);

  // A custom CRD for S.M.A.R.T. reports
  yield* buildBlockDeviceMetrics(commonTags, kubeClient);

  // Our own loop-health metric
  yield {
    metric_name: `app.loop.duty_cycle`,
    points: [{value: dutyCycle*100}],
    interval: 60,
    metric_type: 'gauge',
    tags: [...commonTags, 'app:kubernetes-ship-to-dd'],
  };

}

for await (const dutyCycle of fixedInterval(30 * 1000)) {
  console.log('---', new Date().toISOString(), dutyCycle);
  const metricStream = ows.fromIterable(buildDogMetrics(dutyCycle));
  for await (const batch of metricStream
      .pipeThrough(ows.filter(x => x.metric_type !== 'count' || x.points[0].value !== 0))
      .pipeThrough(ows.bufferWithCount(500))
  ) {

    const checkPoints = (
      batch.filter(x => x.metric_type === 'check')
    ) as CheckSubmission[];
    for (const checkPoint of checkPoints) {
      console.log(checkPoint.metric_name, await datadog.v1ServiceChecks.submit({
        check_name: checkPoint.metric_name,
        ...checkPoint,
      }));
    }

    const metricPoints = (checkPoints.length > 0
      ? batch.filter(x => x.metric_type !== 'check')
      : batch
    ) as MetricSubmission[];
    console.log(batch.length, await datadog.v1Metrics.submit(metricPoints));
  }
}
