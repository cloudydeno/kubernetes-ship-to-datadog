export { default as DatadogApi } from "https://deno.land/x/datadog_api@v0.1.2/mod.ts";
export { CheckStatus } from "https://deno.land/x/datadog_api@v0.1.2/mod.ts";
export type { MetricSubmission } from "https://deno.land/x/datadog_api@v0.1.2/v1/metrics.ts";

export { fixedInterval } from "https://danopia.net/deno/fixed-interval@v1.ts";

export type {
  RestClient as KubernetesClient,
} from "https://deno.land/x/kubernetes_client@v0.1.3/mod.ts";
export {
  // RestClient as KubernetesClient,
  autoDetectClient as autoDetectKubernetesClient,
  ReadLineTransformer,
  Reflector,
} from "https://deno.land/x/kubernetes_client@v0.1.3/mod.ts";

// TODO using patch to fix proxy functions
// export * as CoreV1 from "https://deno.land/x/kubernetes_apis@v0.2.0/builtin/core@v1/mod.ts";
export * as CoreV1 from "https://raw.githubusercontent.com/cloudydeno/deno-kubernetes_apis/main/lib/builtin/core@v1/mod.ts";
export * as AppsV1 from "https://deno.land/x/kubernetes_apis@v0.2.0/builtin/apps@v1/mod.ts";
export * as MetaV1 from "https://deno.land/x/kubernetes_apis@v0.2.0/builtin/meta@v1/structs.ts";

//------------

import { bufferWithCount } from "https://cloudydeno.github.io/observables-with-streams/src/transforms/buffer-with-count.ts";
import { filter } from "https://cloudydeno.github.io/observables-with-streams/src/transforms/filter.ts";

import {
  readableStreamFromAsyncIterator as fromAsyncIterator,
} from "https://deno.land/std@0.81.0/io/streams.ts";

export const ows = {
  bufferWithCount,
  filter,
  fromAsyncIterator,
};
