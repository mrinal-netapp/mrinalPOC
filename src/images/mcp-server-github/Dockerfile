FROM ghcr.io/github/github-mcp-server:latest AS github-mcp-bin

FROM docker.repo.eng.netapp.com/supercorp/supergateway:latest

COPY --from=github-mcp-bin /server/github-mcp-server /usr/local/bin/github-mcp-server

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "/usr/local/bin/github-mcp-server stdio", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
