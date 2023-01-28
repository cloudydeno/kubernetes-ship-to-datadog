FROM denoland/deno:alpine-1.30.0
WORKDIR /src/kubernetes-ship-to-datadog

ADD src/deps.ts .
RUN ["deno", "cache", "deps.ts"]

ADD src/ .
RUN ["deno", "check", "mod.ts"]

ENTRYPOINT ["deno", "run", "--unstable", "--allow-net", "--allow-hrtime", "--allow-read=/var/run/secrets/kubernetes.io", "--allow-env", "--cached-only", "mod.ts"]
