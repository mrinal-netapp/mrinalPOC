# syntax=docker/dockerfile:1
FROM docker.repo.eng.netapp.com/python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    wget \
    htop \
    libmagic1 \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY dataset-processor/requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip setuptools wheel && \
    pip install -r requirements.txt

# Install the shared Python observability client (local monorepo package, not on PyPI).
# Synced into the build context from src/common-py/observability/observability-client
# by the workers-build Makefile target before docker build runs.
COPY observability-client/ ./observability-client/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install ./observability-client/

RUN --mount=type=cache,target=/root/.cache/pip \
    python -m spacy download en_core_web_lg

# Pre-download CLIP (~350MB): cache mount for fast rebuilds, then copy into layer for runtime.
#
# The CLIP model powers image-sensitivity classification in
# analyzers/sensitivity.py. That code is already wrapped in try/except
# and degrades to sensitivity_class="unknown" when the model isn't
# available — so this prefetch is purely a cold-start optimization, not
# a correctness requirement.
#
# Default OFF (=0) so the build works on laptops behind a
# TLS-intercepting corporate proxy (NetApp Corp CA) where outbound
# HTTPS to huggingface.co fails. CI / production builds that want the
# cold-start optimization opt in explicitly:
#
#   PREFETCH_HF_MODELS=1 make workers-build
#
# (forwarded as --build-arg by scripts/docker-build-image.sh).
ARG PREFETCH_HF_MODELS=0
RUN --mount=type=cache,target=/hf-build-cache \
    if [ "$PREFETCH_HF_MODELS" = "1" ] || [ "$PREFETCH_HF_MODELS" = "true" ]; then \
      export HF_HOME=/hf-build-cache && \
      python -c "from transformers import pipeline; pipeline('zero-shot-image-classification', model='openai/clip-vit-base-patch32')" && \
      mkdir -p /root/.cache/huggingface && rm -rf /root/.cache/huggingface/* && cp -a /hf-build-cache/. /root/.cache/huggingface/; \
    else \
      echo "[dataset-processor] Skipping CLIP prefetch (PREFETCH_HF_MODELS=$PREFETCH_HF_MODELS). Image sensitivity classification will fall back to 'unknown' at runtime unless the model is downloaded then — see analyzers/sensitivity.py."; \
    fi

COPY dataset-processor/analyzers/ ./analyzers/
COPY dataset-processor/processing/ ./processing/
COPY dataset-processor/temporal_worker.py .
COPY shared/ ./shared/

# Warm-up Presidio
RUN python -c "\
from presidio_analyzer import AnalyzerEngine; \
engine = AnalyzerEngine(); \
engine.analyze(text='warmup test 123-45-6789', language='en'); \
print('Presidio warm-up complete')"

# Warm-up document extractor libraries (PDF, DOCX, PPTX)
RUN python -c "\
import fitz; \
from docx import Document; \
from pptx import Presentation; \
print('Document extractor warm-up complete')"

ENV ENABLE_PII_ANALYSIS=false

CMD ["python", "temporal_worker.py"]
