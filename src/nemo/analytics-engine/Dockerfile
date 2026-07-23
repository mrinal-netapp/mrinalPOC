# Native build only (no cross-compilation). For multi-arch from Mac, prefer
# SKIP_SERVICES=analytics-engine and build amd64 on Linux/CI, or build per arch on each host.
FROM docker.repo.eng.netapp.com/golang:1.24 AS builder

WORKDIR /build

# Shared Go observability client (go.mod replace => ../../common-go/observability/observability-client)
COPY src/common-go/observability/observability-client/ src/common-go/observability/observability-client/

COPY src/nemo/analytics-engine/go.mod src/nemo/analytics-engine/go.sum* src/nemo/analytics-engine/

WORKDIR /build/src/nemo/analytics-engine

RUN go mod download

COPY src/nemo/analytics-engine/ .

RUN CGO_ENABLED=1 go build -tags=duckdb_arrow -o analytics-engine .

ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions
RUN mkdir -p ${DUCKDB_EXTENSION_DIR} && \
    ./analytics-engine --install-extensions

FROM docker.repo.eng.netapp.com/debian:trixie-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Create non-root user first, then copy as that user (no chown RUN)
RUN useradd -u 1000 -m appuser
COPY --from=builder --chown=appuser:appuser /build/src/nemo/analytics-engine/analytics-engine /app/analytics-engine
COPY --from=builder --chown=appuser:appuser /opt/duckdb/extensions /opt/duckdb/extensions

USER appuser

EXPOSE 5000
ENV PORT=5000
ENV DUCKDB_EXTENSION_DIR=/opt/duckdb/extensions

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:5000/health || exit 1

CMD ["/app/analytics-engine"]
