FROM docker.repo.eng.netapp.com/supercorp/supergateway:latest

RUN npm install -g @modelcontextprotocol/server-memory

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "mcp-server-memory", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
