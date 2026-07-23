# syntax=docker/dockerfile:1
# Stage 1: Build dependencies
FROM docker.repo.eng.netapp.com/python:3.11-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY kb-processor/requirements.txt .

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip && \
    pip install -r requirements.txt

# Install the shared Python observability client (local monorepo package, not on PyPI).
# Synced into the build context from src/common-py/observability/observability-client
# by the workers-build Makefile target before docker build runs.
# Installed here into the venv so it is carried into the runtime stage via
# COPY --from=builder /opt/venv /opt/venv.
COPY observability-client/ ./observability-client/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install ./observability-client/

RUN python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab')"

# Stage 2: Runtime image
FROM docker.repo.eng.netapp.com/python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    htop \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY --from=builder /root/nltk_data /root/nltk_data

COPY kb-processor/utils/ ./utils/
COPY kb-processor/data_sources/ ./data_sources/
COPY kb-processor/processing/ ./processing/
COPY kb-processor/processor.py .
COPY kb-processor/temporal_worker.py .
COPY shared/ ./shared/

CMD ["python", "temporal_worker.py"]
