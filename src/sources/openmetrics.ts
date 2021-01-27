import {
  autoDetectKubernetesClient,
  CoreV1,
  MetricSubmission,
  ReadLineTransformer,
} from '../deps.ts';
import {
  AsyncMetricGen,
  makeLoopErrorPoint,
  MonotonicMemory,
} from '../lib/metrics.ts';

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

const monotonicMemory = new Map<string,number>();

async function* parseMetrics(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawMetric> {
  const lines = stream.pipeThrough(new ReadLineTransformer());
  let currName: string | undefined;
  let currHelp: string | undefined;
  let currType: string | undefined;
  let currUnit: string | undefined;
  let datas: Array<MetricPoint> | undefined;
  for await (const line of lines) {
    if (!line.startsWith('#')) {
      // console.log(3, currName, currHelp, currType, line);
      const match = line.match(/^([^ {]+)(?:{([^}]+)}|) ([^ ]+)$/);
      if (!match) throw new Error(`TODO: ${line}`);
      const tags: Record<string,string> = Object.create(null);
      for (const kv of match[2]?.split(',') ?? []) {
        const [k,v] = kv.split('=');
        tags[k] = JSON.parse(v);
      }
      datas!.push({
        submetric: match[1].slice(currName!.length + 1),
        labelset: match[2],
        tags: match[2]?.split(',').map(str => {
          const [k, v] = str.split('=');
          return [k, JSON.parse(v)];
        }) ?? [],
        facets: tags,
        value: parseFloat(match[3]),
        rawValue: match[3],
      });
    } else if (line.startsWith('# TYPE ')) {
      if (datas) {
        yield {name: currName!, help: currHelp, unit: currUnit, type: currType!, datas};
      }
      currName = line.split(' ')[2];
      currHelp = undefined;
      currUnit = undefined;
      currType = line.slice(8+currName.length);
      datas = [];
    } else if (line.startsWith('# HELP ')) {
      currName = line.split(' ')[2];
      currHelp = line.slice(8+currName.length);
    } else if (line.startsWith('# UNIT ')) {
      currName = line.split(' ')[2];
      currUnit = line.slice(8+currName.length);
    } else if (line === '# EOF') {
      // break;
    } else throw new Error("TODO: "+line);
  }
  if (datas) {
    yield {name: currName!, help: currHelp, unit: currUnit, type: currType!, datas};
  }
}

function reportPointAs(
  point: MetricPoint,
  metric_name: string,
  metric_type: 'gauge' | 'rate' | 'count',
  extraTags: string[],
  tagKeyMap: Record<string,string>,
  monotonicKey: string | false,
): MetricSubmission[] {

  let value = point.value;
  if (monotonicKey) {
    const lastSeen = monotonicMemory.get(monotonicKey);
    monotonicMemory.set(monotonicKey, value);
    // console.log(monotonicKey, value, lastSeen);
    if (typeof lastSeen === 'number') {
      value -= lastSeen;
      if (value < 0) return [];
    } else {
      return [];
    }
  }

  return [{
    metric_name,
    points: [{value: value}],
    interval: 30,
    metric_type,
    tags: [
      ...extraTags,
      ...point.tags.map(([k,v]) => (tagKeyMap[k]||`om_${k}`)+`:${v}`),
    ]}];
}

export async function* buildOpenMetrics(baseTags: string[]): AsyncMetricGen {

  const podList = await coreApi.getPodListForAllNamespaces({
    labelSelector: 'cloudydeno.github.io/metrics=true',
    resourceVersion: '0', // old data is ok
  });

  for (const pod of podList.items) {
    const podTags = [
      ...baseTags,
      `kube_namespace:${pod.metadata!.namespace}`,
      `kube_pod:${pod.metadata!.name}`,
    ];

    for (const x of pod.metadata!.ownerReferences ?? []) {
      if (!x.controller) continue;
      podTags.push(`kube_${x.kind}:${x.name}`);
    }

    try {
      const metricPort = pod.metadata!.annotations!['cloudydeno.github.io/metric-port'];

      const stream = Deno.args.includes('--proxied')
      ? await coreApi
          .namespace(pod.metadata!.namespace!)
          .proxyPodRequest(pod.metadata!.name!, {
            port: metricPort,
            method: 'GET',
            path: '/metrics',
            expectStream: true,
          })
      : await fetch(`http://${pod.status?.podIP}:${metricPort}/metrics`)
        .then(x => x.body!);

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
              yield* reportPointAs(point, metric_name, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          case 'gauge':
            for (const point of rawMetric.datas) {
              if (point.submetric) continue;
              yield* reportPointAs(point, metric_name, 'gauge', podTags, {}, false);
            }
            break;

          case 'summary':
            for (const point of rawMetric.datas) {
              if (point.submetric !== 'sum' && point.submetric !== 'count') continue;
              yield* reportPointAs(point, metric_name+'.'+point.submetric, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          case 'histogram':
            for (const point of rawMetric.datas) {
              yield* reportPointAs(point, metric_name+'.'+point.submetric, 'count', podTags, {}, `${memPrefix}!${point.submetric}!${point.labelset}`);
            }
            break;

          default:
            console.log(rawMetric);

        }
      }

      // Deno.exit(1);
      // yield* grabKubeStateMetrics(baseTags);
    } catch (err: unknown) {
      console.log(`Failed to scrape ${pod.metadata!.namespace}/${pod.metadata!.name}: ${(err as Error).stack}`);
      yield makeLoopErrorPoint(err, [...baseTags,
        `source:openmetrics`,
        `source_name:${pod.metadata!.namespace}/${pod.metadata!.name}`,
      ]);
    }
  }

  // console.log('Memory:', monotonicMemory.size, monotonicMemory)

}
