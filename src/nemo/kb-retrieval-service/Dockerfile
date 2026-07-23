# syntax=docker/dockerfile:1
# ==============================================================================
# Multi-stage Dockerfile for kb-retrieval-service (Rust)
# ==============================================================================
# Native build only: compiles for the platform the build runs on (no cross-compilation).
# For multi-arch: build each architecture on a host of that arch, or use
# For multi-platform, build on each arch or use SKIP_SERVICES=kb-retrieval-service when building with DOCKER_PLATFORMS from one host.

# Stage 1: Build the Rust binary
# Embeddings happen via Bifrost (Phase 4 of the unified-embedding port); no
# in-process ONNX runtime is linked anymore. Debian Bookworm / Ubuntu 22.04
# would suffice, but keeping Ubuntu 24.04 avoids a base-image churn.
FROM docker.repo.eng.netapp.com/ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Install build dependencies + Rust toolchain via rustup
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    cmake \
    pkg-config \
    libssl-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Install Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    sh -s -- -y --default-toolchain 1.93.0
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /build

# Preserve the workspace-relative directory layout so that the path dependency
#   agentstudio-observability-client-runtime = { path = "../../common-rs/observability/observability-client" }
# resolves correctly from src/nemo/kb-retrieval-service/.
COPY src/nemo/kb-retrieval-service/ src/nemo/kb-retrieval-service/
COPY src/common-rs/observability/observability-client/ src/common-rs/observability/observability-client/

WORKDIR /build/src/nemo/kb-retrieval-service

# Build with persistent cache mounts for cargo registry + target dir.
#
# Named (`id=...`) so BuildKit can resolve the same cache across rebuilds of
# this image even when other (anonymous) Dockerfiles in the project share the
# same target path. Anonymous mounts work but their hash includes the
# Dockerfile path, so a Dockerfile relocation or BuildKit garbage-collect can
# orphan the cache — naming pins it.
#
# sharing=locked on the target/ mount is the BuildKit default (single-writer
# semantics, which is correct for cargo's lockfile-driven incremental
# compilation). The registry/git mounts are read-mostly so we explicitly
# request sharing=shared there to allow parallel image builds (e.g. when
# `make images-build` builds multiple Rust images concurrently in CI).
RUN --mount=type=cache,id=cargo-registry,target=/root/.cargo/registry,sharing=shared \
    --mount=type=cache,id=cargo-git,target=/root/.cargo/git,sharing=shared \
    --mount=type=cache,id=kb-retrieval-service-target,target=/build/src/nemo/kb-retrieval-service/target \
    cargo build --release && \
    cp target/release/kb-retrieval-service /kb-retrieval-service-bin

# Stage 2: Minimal runtime image
# Embeddings now route through Bifrost (Phase 4) so we no longer need the
# old ONNX-model-downloader stage. The image is ~90 MB smaller as a result.
# Must also use Ubuntu 24.04 (glibc 2.39) since the binary was linked against it.
FROM docker.repo.eng.netapp.com/ubuntu:24.04 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libssl3t64 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary
COPY --from=builder /kb-retrieval-service-bin /app/kb-retrieval-service

# Copy OpenAPI spec
COPY --from=builder /build/src/nemo/kb-retrieval-service/openapi.yaml /app/openapi.yaml

# Environment defaults — LLM_GATEWAY_URL is injected by the Helm chart
# (services umbrella resolves it via nemo.llmGatewayUrl). K8S_NAMESPACE is
# also chart-injected for per-project VK Secret lookup.
ENV PORT=5000
ENV RUST_LOG=info

EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:5000/health || exit 1

ENTRYPOINT ["/app/kb-retrieval-service"]
