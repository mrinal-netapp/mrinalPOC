# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    htop \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY connector-worker/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r requirements.txt

# Install the shared Python observability client (local monorepo package, not on PyPI).
# Synced into the build context from src/common-py/observability/observability-client
# by the workers-build Makefile target before docker build runs.
COPY observability-client/ ./observability-client/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install ./observability-client/

# Pre-install DuckDB extensions at build time (no internet needed at runtime)
RUN python -c "import duckdb; conn = duckdb.connect(); conn.execute('INSTALL postgres'); conn.execute('INSTALL mysql'); conn.execute('INSTALL httpfs'); conn.close()"

COPY connector-worker/ .

# Shared Python helpers used by all three workers (Temporal readiness
# probe, work-planning, ...). Synced from src/nemo/workers/shared/ —
# same layout dataset-processor and kb-processor use. Imports look like
# `from shared.temporal_readiness import wait_for_temporal`.
COPY shared/ ./shared/

CMD ["python", "temporal_worker.py"]
