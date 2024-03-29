export { default as DatadogApi } from "https://deno.land/x/datadog_api@v0.2.0/mod.ts";
export { CheckStatus } from "https://deno.land/x/datadog_api@v0.2.0/mod.ts";
export type { MetricSubmission } from "https://deno.land/x/datadog_api@v0.2.0/v1/metrics.ts";

// from https://github.com/cloudydeno/deno-bitesized :
export { fixedInterval } from "https://crux.land/4MC9JG#fixed-interval@v1";

export { runMetricsServer } from "https://deno.land/x/observability@v0.1.2/sinks/openmetrics/server.ts";
export { replaceGlobalFetch } from "https://deno.land/x/observability@v0.1.2/sources/fetch.ts";

export type {
  RestClient as KubernetesClient,
} from "https://deno.land/x/kubernetes_client@v0.4.0/mod.ts";
export {
  // RestClient as KubernetesClient,
  autoDetectClient as autoDetectKubernetesClient,
  Reflector,
  KubeConfig,
  KubeConfigContext,
} from "https://deno.land/x/kubernetes_client@v0.4.0/mod.ts";

export { Quantity } from "https://deno.land/x/kubernetes_apis@v0.3.2/common.ts";
export * as CoreV1 from "https://deno.land/x/kubernetes_apis@v0.3.2/builtin/core@v1/mod.ts";
export * as AppsV1 from "https://deno.land/x/kubernetes_apis@v0.3.2/builtin/apps@v1/mod.ts";
export * as MetaV1 from "https://deno.land/x/kubernetes_apis@v0.3.2/builtin/meta@v1/structs.ts";

export { fetchUsing, TlsDialer } from "https://deno.land/x/socket_fetch@v0.1/mod.ts";
export { TextLineStream } from "https://deno.land/std@0.202.0/streams/text_line_stream.ts";

//------------

import { bufferWithCount } from "https://deno.land/x/stream_observables@v1.3/transforms/buffer-with-count.ts";
import { filter } from "https://deno.land/x/stream_observables@v1.3/transforms/filter.ts";
import { fromIterable } from "https://deno.land/x/stream_observables@v1.3/sources/from-iterable.ts";

export const ows = {
  bufferWithCount,
  filter,
  fromIterable,
};
