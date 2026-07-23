# Build stage: native build (no cross-compilation)
FROM docker.repo.eng.netapp.com/golang:1.24-alpine AS builder

WORKDIR /build

# Install build dependencies (including Python for OpenAPI consolidation)
RUN apk add --no-cache git python3 py3-yaml

# Shared Go observability client (go.mod replace => ../../common-go/observability/observability-client)
COPY src/common-go/observability/observability-client/ src/common-go/observability/observability-client/

COPY src/nemo/apigateway-service/go.mod src/nemo/apigateway-service/go.sum* src/nemo/apigateway-service/

WORKDIR /build/src/nemo/apigateway-service

# Download dependencies (replace path must exist relative to this directory)
RUN go mod download

# Copy OpenAPI specs and consolidation script
COPY src/nemo/config-service/openapi.yaml ./config-service-openapi.yaml
COPY scripts/consolidate-openapi.py ./

# Consolidate OpenAPI specs (analytics-service is optional - script handles missing file)
# The script will check if analytics-service/openapi.yaml exists and handle it gracefully
RUN python3 consolidate-openapi.py config-service-openapi.yaml "" openapi-consolidated.yaml || echo "Warning: OpenAPI consolidation failed, continuing..."

# Copy source code (this will include swagger.go which needs openapi-consolidated.yaml)
COPY src/nemo/apigateway-service/ ./

# Ensure the consolidated spec exists and copy it to swagger directory for embed directive
# The embed directive in swagger/swagger.go looks for the file relative to the package directory
RUN if [ ! -f "openapi-consolidated.yaml" ]; then \
        echo "Error: openapi-consolidated.yaml not found after consolidation"; \
        exit 1; \
    fi && \
    cp openapi-consolidated.yaml swagger/openapi-consolidated.yaml

RUN CGO_ENABLED=0 go build -a -installsuffix cgo -o apigateway-service .

# Production stage
FROM docker.repo.eng.netapp.com/alpine:latest

WORKDIR /app

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates

# Create non-root user (clear 1000 if already used by base image)
RUN if getent group 1000 >/dev/null 2>&1; then delgroup $(getent group 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    if getent passwd 1000 >/dev/null 2>&1; then deluser $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    addgroup -g 1000 appuser && adduser -D -u 1000 -G appuser appuser

# Copy binary as appuser so no chown needed
COPY --from=builder --chown=appuser:appuser /build/src/nemo/apigateway-service/apigateway-service .

USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV PORT=8080

CMD ["./apigateway-service"]
