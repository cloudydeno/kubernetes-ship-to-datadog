import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  ows,
} from './deps.ts';

import { buildSystemMetrics } from './sources/kubelet-stats.ts';
import { buildKubeStateMetrics } from './sources/kube-state.ts';
import { buildOpenMetrics } from './sources/openmetrics.ts';
import { buildBlockDeviceMetrics } from './sources/pet-blockdevices.ts';

const datadog = DatadogApi.fromEnvironment(Deno.env);

async function* buildDogMetrics(dutyCycle: number): AsyncGenerator<MetricSubmission,any,undefined> {

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
  // yield* buildSystemMetrics(commonTags);

  // A custom CRD for S.M.A.R.T. reports
  // yield* buildBlockDeviceMetrics(commonTags);

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
    // console.log(batch.filter(x => x.metric_name.includes('fetch.request_d')))
    console.log(batch.length, await datadog.v1Metrics.submit(batch));
  }
}
