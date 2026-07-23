# Multi-arch TEI image without Intel MKL — runs natively on amd64 and arm64.
# Upstream `ghcr.io/huggingface/text-embeddings-inference:cpu-1.5` is built
# with MKL and is amd64-only; on Apple Silicon it falls back to QEMU/Rosetta
# emulation with a ~30s cold-start penalty per pod restart.
#
# This Dockerfile rebuilds TEI from the public source against the ONNX
# Runtime CPU provider (no MKL), producing a portable image. Build with:
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t agentstudio-tei-models:cpu-1.7 \
#     -f deployments/docker/text-embeddings-inference/Dockerfile \
#     --load deployments/docker/text-embeddings-inference
#
# Bump the source tag below when upstream cuts a new release.

ARG TEI_VERSION=v1.7.0

FROM docker.repo.eng.netapp.com/rust:1.82-slim-bookworm AS builder
ARG TEI_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --depth 1 --branch ${TEI_VERSION} \
    https://github.com/huggingface/text-embeddings-inference.git src
WORKDIR /build/src
# Build the ORT (ONNX Runtime) backend — pure-Rust, no MKL, multi-arch.
RUN cargo build --release --bin text-embeddings-router \
    --no-default-features --features "ort,http"

FROM docker.repo.eng.netapp.com/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 libgomp1 && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/src/target/release/text-embeddings-router /usr/local/bin/
ENV HUGGINGFACE_HUB_CACHE=/data
WORKDIR /data
EXPOSE 80
ENTRYPOINT ["text-embeddings-router"]
CMD ["--port", "80"]
