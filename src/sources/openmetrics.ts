import {
  autoDetectKubernetesClient,
  CoreV1,
} from '../deps.ts';
import { KubeWatcher } from "../lib/kube-watcher.ts";
import {
  AsyncMetricGen,
  makeLoopErrorPoint,
} from '../lib/metrics.ts';
import { OpenmetricsMemory, parseMetrics } from "../lib/openmetrics.ts";

const kubernetes = await autoDetectKubernetesClient();
const coreApi = new CoreV1.CoreV1Api(kubernetes);

const memory = new OpenmetricsMemory();

export async function* buildOpenMetrics(baseTags: string[], watcher: KubeWatcher): AsyncMetricGen {

  for (const pod of watcher.podReflector.listCached()) {
    if (pod.metadata.labels?.['cloudydeno.github.io/metrics'] !== 'true') continue;
    if (!pod.status?.podIP) continue;

    const podTags = [
      ...baseTags,
      `kube_namespace:${pod.metadata!.namespace}`,
      `kube_pod:${pod.metadata!.name}`,
    ];

    for (const x of pod.metadata!.ownerReferences ?? []) {
      if (!x.controller) continue;
      podTags.push(`kube_${x.kind}:${x.name}`);
      if (x.kind === 'ReplicaSet') {
        podTags.push(`kube_deployment:${x.name.slice(0, x.name.lastIndexOf('-'))}`);
      }
    }

    try {
      const metricPort = pod.metadata!.annotations!['cloudydeno.github.io/metric-port'];

      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 5000);

      const stream = Deno.args.includes('--proxied')
      ? await coreApi
          .namespace(pod.metadata!.namespace!)
          .proxyPodRequest(pod.metadata!.name!, {
            port: metricPort,
            method: 'GET',
            path: '/metrics',
            expectStream: true,
            abortSignal: abort.signal,
          })
      : await fetch(`http://${pod.status?.podIP}:${metricPort}/metrics`, { signal: abort.signal })
        .then(x => x.body!);

      clearTimeout(timeout);

      for await (const rawMetric of parseMetrics(stream)) {

        let metric_name = 'om.'+rawMetric.name;
        const firstDot = metric_name.indexOf('_');
        metric_name = metric_name.slice(0, firstDot) + '.' + metric_name.slice(firstDot+1);
        if (rawMetric.unit) {
          if (rawMetric.name.endsWith('_'+rawMetric.unit)) {
            metric_name = metric_name.slice(0, -rawMetric.unit.length-1) + '.' + rawMetric.unit;
          }
        }

        const memPrefix = `${pod.metadata!.uid!}!${rawMetric.name}`;
        switch (rawMetric.type) {

          case 'counter':
            for (const point of rawMetric.datas) {
              if (point.submetric && point.submetric !== 'total') continue;
              yield* memory.reportPointAs(point, metric_name, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          case 'gauge':
            for (const point of rawMetric.datas) {
              if (point.submetric) continue;
              yield* memory.reportPointAs(point, metric_name, 'gauge', podTags, {}, false);
            }
            break;

          case 'summary':
            for (const point of rawMetric.datas) {
              if (point.submetric !== 'sum' && point.submetric !== 'count') continue;
              yield* memory.reportPointAs(point, metric_name+'.'+point.submetric, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          case 'histogram':
            for (const point of rawMetric.datas) {
              yield* memory.reportPointAs(point, metric_name+'.'+point.submetric, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          default:
            console.log(rawMetric);

        }
      }

      // Deno.exit(1);
      // yield* grabKubeStateMetrics(baseTags);
    } catch (err: unknown) {
      console.log(`Failed to scrape ${pod.metadata!.namespace}/${pod.metadata!.name}`);
      yield makeLoopErrorPoint(err, [...baseTags,
        `source:openmetrics`,
        `source_name:${pod.metadata!.namespace}/${pod.metadata!.name}`,
      ]);
    }
  }

  // console.log('Memory:', monotonicMemory.size, monotonicMemory)

}
