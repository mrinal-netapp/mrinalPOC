# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.12-slim

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
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY anf_common /app/anf_common
COPY server.py /app/server.py

USER 1000

EXPOSE 8000

ENTRYPOINT ["supergateway", \
  "--stdio", "python /app/server.py", \
  "--outputTransport", "streamableHttp", \
  "--stateful", \
  "--sessionTimeout", "300000", \
  "--port", "8000", \
  "--healthEndpoint", "/healthz", \
  "--logLevel", "none"]
