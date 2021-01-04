FROM hayd/alpine-deno:1.6.1
WORKDIR /src/kubernetes-ship-to-datadog

ADD src/deps.ts .
RUN ["deno", "cache", "deps.ts"]

ADD src/ .
RUN ["deno", "cache", "mod.ts"]

CMD ["deno", "run", "--allow-net", "--allow-read=/var/run/secrets/kubernetes.io", "--allow-env", "--cert=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt", "--cached-only", "mod.ts"]
