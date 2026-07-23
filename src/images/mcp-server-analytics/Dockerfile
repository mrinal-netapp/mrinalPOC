# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.12-slim

COPY obs-client /tmp/obs-client
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install fastmcp>=2.0.0 httpx>=0.27.0 uvicorn>=0.30.0 starlette>=0.37.0 /tmp/obs-client

COPY server.py /app/server.py

USER 1000
EXPOSE 8000

CMD ["python", "/app/server.py", "--transport", "streamable-http"]
