FROM docker.repo.eng.netapp.com/node:22-slim

RUN npm install -g kubernetes-mcp-server@latest

USER 1000

EXPOSE 8000

ENTRYPOINT ["kubernetes-mcp-server", \
  "--port", "8000", \
  "--read-only", \
  "--stateless"]
