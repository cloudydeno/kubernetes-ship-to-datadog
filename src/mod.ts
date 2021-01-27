import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  ows,
} from './deps.ts';
import {
  AsyncMetricGen,
  SyncMetricGen,
  CheckSubmission,
} from './lib/metrics.ts';

import { buildSystemMetrics } from './sources/kubelet-stats.ts';
import { buildKubeStateMetrics } from './sources/kube-state.ts';
import { buildOpenMetrics } from './sources/openmetrics.ts';
import { buildBlockDeviceMetrics } from './sources/pet-blockdevices.ts';

const datadog = DatadogApi.fromEnvironment(Deno.env);

async function* buildDogMetrics(dutyCycle: number): AsyncMetricGen {

  const commonTags = [
    'cluster:dust-gke',
  ];

  // Our own loop-health metric
  yield {
    metric_name: `app.loop.duty_cycle`,
    points: [{value: dutyCycle*100}],
    interval: 60,
    metric_type: 'gauge',
    tags: [...commonTags, 'app:kubernetes-ship-to-dd'],
  };

  // Scrape all autodiscovered OpenMetrics (or Prometheus) pods
  yield* buildOpenMetrics(commonTags);

  // Basic scheduling & health from the cluster's control plane
  yield* buildKubeStateMetrics(commonTags);

  // By-Node stats summaries scraped directly from kubelet
  yield* buildSystemMetrics(commonTags);

  // A custom CRD for S.M.A.R.T. reports
  yield* buildBlockDeviceMetrics(commonTags);

}

const pipeOpts: PipeOptions = {
  preventAbort: false,
  preventCancel: false,
  preventClose: false,
};

for await (const dutyCycle of fixedInterval(30 * 1000)) {
  console.log('---', new Date().toISOString(), dutyCycle);
  const metricStream = ows.fromAsyncIterator(buildDogMetrics(dutyCycle));
  for await (const batch of metricStream
      .pipeThrough(ows.filter(x => x.metric_type !== 'count' || x.points[0].value !== 0), pipeOpts)
      .pipeThrough(ows.bufferWithCount(500), pipeOpts)
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
