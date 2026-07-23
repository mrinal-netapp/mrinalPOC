# Build stage
FROM docker.repo.eng.netapp.com/node:20-alpine AS builder

WORKDIR /build

# Match source directory structure so file:../../common paths work correctly
# Source: src/nemo/storage-manager -> ../../common -> src/common
# Docker: /build/src/nemo/storage-manager -> ../../common -> /build/src/common

# Build observability-client first so its dist/ exists before common's tsc runs.
# Mirrors the "Build observability-client" step in .github/workflows/main.yml.

COPY src/common/src/observability/observability-client/package*.json \
     ./src/common/src/observability/observability-client/
COPY src/common/src/observability/observability-client/tsconfig*.json \
     ./src/common/src/observability/observability-client/
COPY src/common/src/observability/observability-client/preload.ts \
     ./src/common/src/observability/observability-client/
COPY src/common/src/observability/observability-client/enums \
     ./src/common/src/observability/observability-client/enums
COPY src/common/src/observability/observability-client/observability_client_runtime \
     ./src/common/src/observability/observability-client/observability_client_runtime
WORKDIR /build/src/common/src/observability/observability-client
RUN npm ci && npm run build
WORKDIR /build

# Copy and build common package
COPY src/common/package*.json ./src/common/
COPY src/common/tsconfig.json ./src/common/
COPY src/common/src ./src/common/src
WORKDIR /build/src/common
RUN npm ci && npm run build
WORKDIR /build

# Copy service package files
COPY src/nemo/storage-manager/package*.json ./src/nemo/storage-manager/
COPY src/nemo/storage-manager/tsconfig.json ./src/nemo/storage-manager/

WORKDIR /build/src/nemo/storage-manager

# Install dependencies (this will link to ../../common which is /build/src/common)
RUN npm ci

# Copy source code
COPY src/nemo/storage-manager/src/ ./src/

# Copy OpenAPI spec
COPY src/nemo/storage-manager/src/openapi.yaml ./src/openapi.yaml

# Build TypeScript (common package should now be available at ../../common)
RUN npm run build && \
    cp src/openapi.yaml dist/openapi.yaml

# Production stage
FROM docker.repo.eng.netapp.com/node:20-alpine

WORKDIR /

# Create non-root user first so installed files are owned by it (avoids slow chown -R over node_modules)
RUN if getent group 1000 >/dev/null 2>&1; then delgroup $(getent group 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    if getent passwd 1000 >/dev/null 2>&1; then deluser $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    addgroup -g 1000 appuser && adduser -D -u 1000 -G appuser appuser

# Copy common package and install as appuser so /common is owned by 1000
COPY --from=builder /build/src/common/package.json /common/
COPY --from=builder /build/src/common/dist /common/dist
# Copy the local observability-client package so 'file:src/observability/observability-client' resolves
COPY --from=builder /build/src/common/src/observability/observability-client /common/src/observability/observability-client
WORKDIR /common
RUN chown -R appuser:appuser /common && su appuser -c "npm install --omit=dev"

# Copy service package and install as appuser so /app is owned by 1000
WORKDIR /app
COPY --from=builder /build/src/nemo/storage-manager/package.json ./
RUN chown -R appuser:appuser /app && su appuser -c "npm install --omit=dev"

# Copy built files as appuser so no chown of large trees
COPY --from=builder --chown=appuser:appuser /build/src/nemo/storage-manager/dist ./dist
COPY --from=builder --chown=appuser:appuser /build/src/nemo/storage-manager/dist/openapi.yaml ./dist/openapi.yaml

USER 1000

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS="--require /app/node_modules/@agentstudio/observability-client-runtime/dist/preload.js"

CMD ["node", "dist/index.js"]
