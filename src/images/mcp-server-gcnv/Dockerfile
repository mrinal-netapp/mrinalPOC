# syntax=docker/dockerfile:1
# Wraps the public NetApp npm package `gcnv-mcp-server` (bin: gcnv-mcp) with
# supergateway so managed MCP runtime gets streamable HTTP on :8000 + /healthz.
# Upstream: https://github.com/NetApp/gcnv-mcp-server / https://www.npmjs.com/package/gcnv-mcp-server
ARG GCNV_MCP_VERSION=1.0.1

FROM docker.repo.eng.netapp.com/node:20-bookworm-slim

ARG GCNV_MCP_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g supergateway@latest "gcnv-mcp-server@${GCNV_MCP_VERSION}"

# Writable paths when readOnlyRootFilesystem is true (MCPRuntimeManager mounts /tmp too).
ENV HOME=/tmp \
    NPM_CONFIG_CACHE=/tmp/.npm

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "gcnv-mcp --transport stdio", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
