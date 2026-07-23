# syntax=docker/dockerfile:1
# Self-contained MCP server exposing read-only GCNV logs/errors/events tools
# backed by Google Cloud Logging. Built from in-tree TypeScript source and
# wrapped with supergateway so the managed MCP runtime gets streamable HTTP on
# :8000 + /healthz (same convention as nemo/mcp-server-gcnv).
#
# supergateway runs in STATEFUL streamable-http mode: the Bifrost gateway
# connects as a stateful client (it sends mcp-protocol-version + dual Accept and
# reuses the mcp-session-id), so a single stdio child is reused across requests
# and idle sessions are reaped after --sessionTimeout. The previous stateless
# config made supergateway auto-initialize (and spawn) a fresh child for every
# request, and those children were never reaped — they piled up until the pod
# hit its memory limit and was liveness-killed (CrashLoopBackOff).

FROM docker.repo.eng.netapp.com/node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker.repo.eng.netapp.com/node:20-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g supergateway@3.4.3

WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Writable paths when readOnlyRootFilesystem is true (MCPRuntimeManager mounts /tmp too).
ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "node /app/build/index.js", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--stateful", \
  "--sessionTimeout", "300000", \
  "--healthEndpoint", "/healthz"]
