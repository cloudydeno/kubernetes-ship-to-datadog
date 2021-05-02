export { default as DatadogApi } from "https://deno.land/x/datadog_api@v0.1.3/mod.ts";
export { CheckStatus } from "https://deno.land/x/datadog_api@v0.1.3/mod.ts";
export type { MetricSubmission } from "https://deno.land/x/datadog_api@v0.1.3/v1/metrics.ts";

export { fixedInterval } from "https://crux.land/4MC9JG#fixed-interval@v1";

export {
  runMetricsServer,
} from "https://raw.githubusercontent.com/cloudydeno/deno-openmetrics_exporter/49ce410657ae5cbd9f647acf1233656933a936aa/mod.ts";
export {
  replaceGlobalFetch,
} from "https://raw.githubusercontent.com/cloudydeno/deno-openmetrics_exporter/49ce410657ae5cbd9f647acf1233656933a936aa/lib/instrumented/fetch.ts";

export type {
  RestClient as KubernetesClient,
} from "https://deno.land/x/kubernetes_client@v0.2.3/mod.ts";
export {
  // RestClient as KubernetesClient,
  autoDetectClient as autoDetectKubernetesClient,
  ReadLineTransformer,
  Reflector,
} from "https://deno.land/x/kubernetes_client@v0.2.3/mod.ts";

export * as CoreV1 from "https://deno.land/x/kubernetes_apis@v0.3.0/builtin/core@v1/mod.ts";
export * as AppsV1 from "https://deno.land/x/kubernetes_apis@v0.3.0/builtin/apps@v1/mod.ts";
export * as MetaV1 from "https://deno.land/x/kubernetes_apis@v0.3.0/builtin/meta@v1/structs.ts";

//------------

import { bufferWithCount } from "https://deno.land/x/stream_observables@v1.0/transforms/buffer-with-count.ts";
import { filter } from "https://deno.land/x/stream_observables@v1.0/transforms/filter.ts";

import {
  fromIterable,
} from "https://deno.land/x/stream_observables@v1.0/sources/from-iterable.ts";

export const ows = {
  bufferWithCount,
  filter,
  fromIterable,
};
