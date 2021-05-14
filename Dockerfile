FROM hayd/alpine-deno:1.10.1
WORKDIR /src/kubernetes-ship-to-datadog

ADD src/deps.ts .
RUN ["deno", "cache", "deps.ts"]

ADD src/ .
RUN ["deno", "cache", "mod.ts"]

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-read=/var/run/secrets/kubernetes.io", "--allow-env", "--cached-only", "mod.ts"]
