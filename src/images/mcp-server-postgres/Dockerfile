FROM docker.repo.eng.netapp.com/supercorp/supergateway:latest

RUN npm install -g @modelcontextprotocol/server-postgres

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "mcp-server-postgres", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
