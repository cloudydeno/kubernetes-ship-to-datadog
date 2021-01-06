import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  ows,
} from './deps.ts';

import { buildSystemMetrics } from './sources/kubelet-stats.ts';
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

  // TODO: this doesn't belong here, openmetrics needs some internal rework
  try {
    yield* buildOpenMetrics(commonTags);
  } catch (err: unknown) {
    const type = (err instanceof Error) ? err.name : typeof err;
    yield {
      metric_name: `app.loop.error`,
      points: [{value: 1}],
      interval: 60,
      metric_type: 'count',
      tags: [...commonTags,
        `source:openmetrics`,
        `error:${type}`,
      ],
    };
  }

  // By-Node stats summaries scraped directly from kubelet
  yield* buildSystemMetrics(commonTags);

  // A custom CRD for S.M.A.R.T. reports
  yield* buildBlockDeviceMetrics(commonTags);

}

for await (const dutyCycle of fixedInterval(30 * 1000)) {
  console.log('---', new Date().toISOString(), dutyCycle);
  const metricStream = ows.fromAsyncIterator(buildDogMetrics(dutyCycle));
  for await (const batch of metricStream.pipeThrough(ows.bufferWithCount(500))) {
    console.log(batch.length, await datadog.v1Metrics.submit(batch));
  }
}
