# Build stage
FROM docker.repo.eng.netapp.com/node:20-alpine AS builder

WORKDIR /build

# Match source directory structure so file:../../common paths work correctly
# Source: src/nemo/artifact-service -> ../../common -> src/common
# Docker: /build/src/nemo/artifact-service -> ../../common -> /build/src/common

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
COPY src/nemo/artifact-service/package*.json ./src/nemo/artifact-service/
COPY src/nemo/artifact-service/tsconfig.json ./src/nemo/artifact-service/

WORKDIR /build/src/nemo/artifact-service

# Install dependencies (this will link to ../../common which is /build/src/common)
RUN npm install --no-audit --no-fund

# Copy source code
COPY src/nemo/artifact-service/src/ ./src/

# Build TypeScript and copy OpenAPI spec
RUN npm run build

# Production stage
FROM docker.repo.eng.netapp.com/node:20-alpine

WORKDIR /

# Create non-root user first so installed files are owned by it
RUN if getent group 1000 >/dev/null 2>&1; then delgroup $(getent group 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    if getent passwd 1000 >/dev/null 2>&1; then deluser $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    addgroup -g 1000 appuser && adduser -D -u 1000 -G appuser appuser

# Copy common package and install as appuser
COPY --from=builder /build/src/common/package.json /common/
COPY --from=builder /build/src/common/dist /common/dist
# Copy the local observability-client package so 'file:src/observability/observability-client' resolves
COPY --from=builder /build/src/common/src/observability/observability-client /common/src/observability/observability-client
WORKDIR /common
RUN chown -R appuser:appuser /common && su appuser -c "npm install --omit=dev"

# Copy service package and install as appuser
WORKDIR /app
COPY --from=builder /build/src/nemo/artifact-service/package.json ./
RUN chown -R appuser:appuser /app && su appuser -c "npm install --omit=dev"

# Copy built files
COPY --from=builder --chown=appuser:appuser /build/src/nemo/artifact-service/dist ./dist

USER appuser

EXPOSE 8080

ENV NODE_OPTIONS="--require /app/node_modules/@agentstudio/observability-client-runtime/dist/preload.js"

CMD ["node", "dist/index.js"]
