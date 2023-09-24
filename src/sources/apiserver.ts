import {
  KubernetesClient,
} from '../deps.ts';
import {
  AsyncMetricGen,
  makeLoopErrorPoint,
} from '../lib/metrics.ts';
import {
  OpenmetricsMemory,
  parseMetrics,
} from "../lib/openmetrics.ts";

const memory = new OpenmetricsMemory('kube');

export async function* buildApiserverMetrics(baseTags: string[], client: KubernetesClient): AsyncMetricGen {
  try {

    const stream = await client.performRequest({
      method: 'GET',
      path: '/metrics',
      expectStream: true,
      abortSignal: AbortSignal.timeout(5000),
    });

    const prefix = 'kube.apiserver.';
    for await (const rawMetric of parseMetrics(stream)) {
      switch (rawMetric.name) {

        case 'apiserver_watch_events_total':
          for (const point of rawMetric.datas) {
            point.facets['group'] ||= 'core';
            yield* memory.reportPointAs(point, prefix+'kind.watch_events', 'count', baseTags, {}, `${rawMetric.name}!${point.submetric}!${point.labelset}`);
          }
          break;

        case 'apiserver_request_total':
          for (const point of rawMetric.datas) {
            point.facets['kind'] = unPlural(point.facets['resource']);
            if (!point.facets['kind']) continue;
            point.facets['group'] ||= 'core';
            // console.log(point.facets)
            yield* memory.reportPointAs(point, prefix+'kind.served_requests', 'count', baseTags, {}, `${rawMetric.name}!${point.submetric}!${point.labelset}`);
          }
          break;

        case 'apiserver_longrunning_requests':
          for (const point of rawMetric.datas) {
            point.facets['kind'] = unPlural(point.facets['resource']);
            if (!point.facets['kind']) continue;
            point.facets['group'] ||= 'core';
            yield* memory.reportPointAs(point, prefix+'kind.longrunning_requests', 'gauge', baseTags, {}, false);
          }
          break;

        case 'apiserver_storage_objects':
          for (const point of rawMetric.datas) {
            const firstDot = point.facets['resource'].indexOf('.');
            if (firstDot > 0) {
              point.facets['kind'] = unPlural(point.facets['resource'].slice(0, firstDot));
              point.facets['group'] = point.facets['resource'].slice(firstDot+1);
            } else {
              point.facets['kind'] = unPlural(point.facets['resource']);
              point.facets['group'] = 'core';
            }
            yield* memory.reportPointAs(point, prefix+'kind.stored_objects', 'gauge', baseTags, {}, false);
          }
          break;

        case 'apiserver_storage_size_bytes':
          for (const point of rawMetric.datas) {
            yield* memory.reportPointAs(point, prefix+'total_storage.bytes', 'gauge', baseTags, {}, false);
          }
          break;

        case 'rest_client_requests_total':
          for (const point of rawMetric.datas) {
            point.facets['host'] = point.facets['host']?.replace('[::1]', 'localhost')
            yield* memory.reportPointAs(point, prefix+'sent_requests', 'count', baseTags, {}, `${rawMetric.name}!${point.submetric}!${point.labelset}`);
          }
          break;

        default:
          // console.log('skipped', rawMetric.name, rawMetric.type);

      }
    }

  } catch (err: unknown) {
    console.log(`Failed to scrape APIServer`);
    yield makeLoopErrorPoint(err, [...baseTags,
      `source:apiserver`,
    ]);
  }
}

function unPlural(plural: string) {
  if (plural == 'endpoints') return 'endpoints';
  if (plural.endsWith('ses')) return plural.replace(/es$/, '');
  if (plural.endsWith('ies')) return plural.replace(/ies$/, 'y');
  return plural.replace(/s$/, '');
}
