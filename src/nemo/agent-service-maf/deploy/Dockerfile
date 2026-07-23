# syntax=docker/dockerfile:1.7
# =============================================================================
# agent-service-maf — Production Dockerfile
# Multi-stage build: builder (compile/install) + runtime (minimal attack surface)
#
# Build context: the AgentStudio repo root (NOT this folder), so the build
# can reference repo-root-relative paths via the COPY directives below.
# Matches sibling agent-service.
#
# The shared in-repo observability client (`observability_client_runtime`) is
# installed in the builder stage below from
# `src/common-py/observability/observability-client` — the same package used by
# config-service, kb-retrieval-service, and the Temporal workers. If it is ever
# absent, the service degrades gracefully to a structlog-only fallback (see
# `interface_layer/api.py`).
#
#   cd <repo root>
#   docker build -f src/nemo/agent-service-maf/deploy/Dockerfile \
#                -t agent-service-maf:local .
#
# Base image is pulled from NetApp's internal Docker mirror, matching the
# convention used by every other Python service in this monorepo.
# =============================================================================

# =============================================================================
# Stage 1: builder — install all Python dependencies into an isolated prefix
# =============================================================================
FROM docker.repo.eng.netapp.com/python:3.12-slim AS builder

LABEL stage="builder"

# Install build tools needed to compile any C extensions
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# =============================================================================
# Shared observability client (in-repo package, not on any package index)
# =============================================================================
# Installs `observability_client_runtime` from the canonical monorepo source at
# src/common-py/observability/observability-client — the same package every
# other AgentStudio service uses. It provides structlog JSON logging with OTel
# trace_id/span_id injection, OTLP trace/metric export, and the ASGI trace
# middleware wired in interface_layer/api.py. Installed before the app deps so
# its layer stays cached across application-code changes.
#
# The re-include for this path lives in deploy/.dockerignore.
COPY src/common-py/observability/observability-client/ /tmp/observability-client/
RUN pip install --no-cache-dir --prefix=/install /tmp/observability-client \
 && rm -rf /tmp/observability-client

# Copy only the metadata files first — allows Docker to cache the pip install
# layer and skip re-installing when only application code changes.
COPY src/nemo/agent-service-maf/pyproject.toml ./

# Install the package and all runtime dependencies into /install prefix.
# --no-cache-dir keeps the image layer small.
#
# The [agent-framework] extra (agent-framework-core + -orchestrations) is
# REQUIRED: framework/__init__.py imports the "maf" adapter unconditionally, so
# the package fails to import without it. "maf" is the default framework
# (AGENT_AGENT__FRAMEWORK=maf).
RUN pip install --no-cache-dir --prefix=/install ".[agent-framework,guardrails-secrets,redis]"

# Sanity check: fail the build if the [agent-framework] extra ever drifts and
# the AF core / orchestration runtime goes missing, instead of crashing the
# first time someone hits a multi-agent team at runtime.
RUN PYTHONPATH=/install/lib/python3.12/site-packages \
    python -c "from agent_framework import Agent, WorkflowBuilder; from agent_framework.orchestrations import SequentialBuilder, ConcurrentBuilder, HandoffBuilder, GroupChatBuilder, MagenticBuilder; print('AF orchestration import OK')"

# =============================================================================
# Stage 2: runtime — minimal image with no build tools
# =============================================================================
FROM docker.repo.eng.netapp.com/python:3.12-slim AS runtime

# ---------------------------------------------------------------------------
# OCI image labels (https://github.com/opencontainers/image-spec)
# ---------------------------------------------------------------------------
LABEL org.opencontainers.image.title="agent-service-maf" \
      org.opencontainers.image.description="Pluggable, protocol-agnostic Python agent framework" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.source="https://github.com/NetApp-Nemo/agent-studio" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.repo.eng.netapp.com/python:3.12-slim"

# Install only the runtime system packages (curl for health check only)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ---------------------------------------------------------------------------
# Security hardening — non-root user with fixed UID 1000
# Matches Helm values: podSecurityContext.runAsUser: 1000
# ---------------------------------------------------------------------------
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid 1000 --no-create-home --shell /sbin/nologin appuser

# ---------------------------------------------------------------------------
# Copy installed packages from builder stage
# ---------------------------------------------------------------------------
COPY --from=builder /install /usr/local

# ---------------------------------------------------------------------------
# Application code
# ---------------------------------------------------------------------------
WORKDIR /app

# Copy source and config with correct ownership (paths are repo-root-relative)
COPY --chown=appuser:appuser src/nemo/agent-service-maf/src/ ./src/
COPY --chown=appuser:appuser src/nemo/agent-service-maf/configs/ ./configs/

# Create a writable tmp directory (rootfs is read-only in Kubernetes)
RUN mkdir -p /tmp/agent-service-maf \
    && chown appuser:appuser /tmp/agent-service-maf

# The observability client auto-creates `App_Logs/` and `Trace_Logs/` under the
# container WORKDIR when a relative log/trace path is used. WORKDIR is created by
# Docker as root, so a non-root user (appuser, UID 1000) can't mkdir inside it.
# Pre-create the directories with appuser ownership and chown WORKDIR itself so
# any relative log-path the client falls back to also Just Works. (In k8s the
# deployment points logs at /dev/stdout and traces at /tmp, so these are only a
# safety net for local runs.)
RUN mkdir -p /app/App_Logs /app/Trace_Logs \
    && chown -R appuser:appuser /app

# ---------------------------------------------------------------------------
# Runtime environment
# ---------------------------------------------------------------------------
ENV PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_INDEX=1

# Drop to non-root
USER appuser

# ---------------------------------------------------------------------------
# Supply chain security note:
# - This image is signed with Cosign in CI (keyless, Sigstore transparency log)
# - An SBOM in SPDX format is generated with Syft and attached as a Cosign attestation
# - Trivy scans this image for CVEs; CRITICAL/HIGH findings fail the pipeline
# See: .github/workflows/cd.yml (build-and-push job)
# See: .github/workflows/security.yml (trivy-image-scan job)
# ---------------------------------------------------------------------------

# Health check — the FastAPI /health endpoint.
#
# §I1 / §5.8: Docker HEALTHCHECK has *liveness* semantics ("is the
# container process responsive?"), so it must point at /health (always
# 200 once the process is up). Readiness semantics ("is the agent
# framework ready to serve traffic?") live at /ready and depend on
# downstream dependencies (Redis, MCP servers, etc.) -- that probe
# belongs in the Kubernetes readinessProbe (consumer-side Helm chart),
# not the Dockerfile HEALTHCHECK. Mixing them here would cause Docker
# to mark a healthy container as unhealthy whenever Redis flaps,
# which is the wrong semantics for orchestrators that auto-restart
# unhealthy containers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl --fail --silent http://localhost:8000/health || exit 1

EXPOSE 8000

CMD ["uvicorn", \
     "agent_service_maf.interface_layer.api:create_app", \
     "--factory", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "2", \
     "--log-level", "info"]
