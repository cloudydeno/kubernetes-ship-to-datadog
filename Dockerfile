#FROM hayd/alpine-deno:1.6.1
FROM danopia/deno-experiments:1.8.0-heapmetrics
WORKDIR /src/kubernetes-ship-to-datadog

ADD src/deps.ts .
RUN ["deno", "cache", "deps.ts"]

ADD src/ .
RUN ["deno", "cache", "mod.ts"]

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-read=/var/run/secrets/kubernetes.io", "--allow-env", "--cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "--cached-only", "mod.ts"]
