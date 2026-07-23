FROM docker.repo.eng.netapp.com/supercorp/supergateway:latest

USER root

RUN apk add --no-cache python3 py3-pip && \
    pip3 install --break-system-packages mcp-server-sqlite

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "mcp-server-sqlite --db-path /data/db.sqlite", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
