import {
  DatadogApi, MetricSubmission,
  fixedInterval,
  ows,
} from './deps.ts';

import { buildSystemMetrics } from './sources/kubelet-stats.ts';
import { buildOpenMetrics } from './sources/openmetrics.ts';

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

  yield* buildOpenMetrics(commonTags);

  yield* buildSystemMetrics(commonTags);

}

for await (const dutyCycle of fixedInterval(30 * 1000)) {
  console.log('---', new Date().toISOString(), dutyCycle);
  const metricStream = ows.fromAsyncIterator(buildDogMetrics(dutyCycle));
  for await (const batch of metricStream.pipeThrough(ows.bufferWithCount(500))) {
    console.log(batch.length, await datadog.v1Metrics.submit(batch));
  }
}
