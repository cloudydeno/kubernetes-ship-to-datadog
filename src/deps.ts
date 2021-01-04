export { default as DatadogApi } from "https://deno.land/x/datadog_api@v0.1.2/mod.ts";
export { CheckStatus } from "https://deno.land/x/datadog_api@v0.1.2/mod.ts";
export type { MetricSubmission } from "https://deno.land/x/datadog_api@v0.1.2/v1/metrics.ts";

export { fixedInterval } from "https://danopia.net/deno/fixed-interval@v1.ts";

export {
  // RestClient as KubernetesClient,
  autoDetectClient as autoDetectKubernetesClient,
  ReadLineTransformer,
} from "https://deno.land/x/kubernetes_client@v0.1.0/mod.ts";
// export { CoreV1Api } from "https://deno.land/x/kubernetes_apis@v0.1.0/builtin/core@v1/mod.ts";

export { CoreV1Api } from "https://deno.land/x/kubernetes_apis@v0.1.0/builtin/core@v1/mod.ts";

//------------

import { bufferWithCount } from "https://cloudydeno.github.io/observables-with-streams/src/transforms/buffer-with-count.ts";

import {
  readableStreamFromAsyncIterator as fromAsyncIterator,
} from "https://deno.land/std@0.81.0/io/streams.ts";

export const ows = {
  bufferWithCount,
  fromAsyncIterator,
};
