# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.12-slim

# supergateway turns the stdio MCP server into streamable-http on :8000 with /healthz,
# matching the convention used by mcp-server-postgres so the runtime manager can probe it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g supergateway@latest \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
COPY obs-client /tmp/obs-client
RUN pip install --no-cache-dir -r /app/requirements.txt /tmp/obs-client

# Vendored copy of the canonical ontap_common package (kept in sync with
# src/nemo/workers/connector-worker/ontap_common/ via `make sync-common`).
COPY ontap_common /app/ontap_common
COPY log_queries.py /app/log_queries.py
COPY server.py /app/server.py

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "python /app/server.py", \
  "--outputTransport", "streamableHttp", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz"]
