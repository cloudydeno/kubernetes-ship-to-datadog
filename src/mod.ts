import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  runMetricsServer, replaceGlobalFetch,
  ows,
  autoDetectKubernetesClient,
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

if (Deno.args.includes('--serve-metrics')) {
  replaceGlobalFetch();
  runMetricsServer({ port: 9090 });
  console.log("Now serving OpenMetrics @ :9090/metrics");
}

const datadog = DatadogApi.fromEnvironment(Deno.env);

const kubeWatcher = new KubeWatcher(await autoDetectKubernetesClient());
kubeWatcher.startAll();

async function* buildDogMetrics(dutyCycle: number): AsyncMetricGen {

  const commonTags = [
    'cluster:dust-gke',
  ];

  // Scrape all autodiscovered OpenMetrics (or Prometheus) pods
  yield* buildOpenMetrics(commonTags, kubeWatcher);

  // Basic scheduling & health from the cluster's control plane
  yield* buildKubeStateMetrics(commonTags, kubeWatcher);

  // By-Node stats summaries scraped directly from kubelet
  yield* buildKubeletMetrics(commonTags, kubeWatcher);

  // A custom CRD for S.M.A.R.T. reports
  yield* buildBlockDeviceMetrics(commonTags);

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
