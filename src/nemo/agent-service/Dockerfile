# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.12-slim

WORKDIR /app

# Install the shared Python observability client lib from the monorepo.
# Must be copied before requirements.txt so the local path install works.
COPY src/common-py/observability/observability-client/ /app/observability-client/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install /app/observability-client

COPY src/nemo/agent-service/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

COPY src/nemo/agent-service/src/ ./src/

EXPOSE 8000

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--timeout-keep-alive", "300", "--timeout-graceful-shutdown", "30"]
