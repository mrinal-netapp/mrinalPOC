# Build stage
FROM docker.repo.eng.netapp.com/node:20-alpine AS builder

WORKDIR /build

# Match source directory structure so file:../../common paths work correctly
# Source: src/nemo/config-service -> ../../common -> src/common
# Docker: /build/src/nemo/config-service -> ../../common -> /build/src/common

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
COPY src/nemo/config-service/package*.json ./src/nemo/config-service/
COPY src/nemo/config-service/tsconfig.json ./src/nemo/config-service/

WORKDIR /build/src/nemo/config-service

# Install dependencies (this will link to ../../common which is /build/src/common)
RUN npm ci

# Copy source code (config-service has files at root level)
# Copy all TypeScript source files and config files
COPY src/nemo/config-service/*.ts ./
COPY src/nemo/config-service/*.json ./
COPY src/nemo/config-service/catalog ./catalog
COPY src/nemo/config-service/clients ./clients
COPY src/nemo/config-service/db ./db
COPY src/nemo/config-service/middleware ./middleware
COPY src/nemo/config-service/models ./models
COPY src/nemo/config-service/providers ./providers
COPY src/nemo/config-service/repositories ./repositories
COPY src/nemo/config-service/routes ./routes
COPY src/nemo/config-service/services ./services
COPY src/nemo/config-service/types ./types
COPY src/nemo/config-service/utils ./utils
COPY src/nemo/config-service/validators ./validators
COPY src/nemo/config-service/openapi.yaml ./openapi.yaml

# Build TypeScript (common package should now be available at ../../common)
RUN npm run build && \
    cp openapi.yaml dist/openapi.yaml

# Production stage
FROM docker.repo.eng.netapp.com/node:20-alpine

WORKDIR /

# Create non-root user first so all installed files are owned by it (avoids slow chown -R).
# Remove existing 1000:1000 if present (node image may use it) so we can create nodeuser.
RUN if getent group 1000 >/dev/null 2>&1; then delgroup $(getent group 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    if getent passwd 1000 >/dev/null 2>&1; then deluser $(getent passwd 1000 | cut -d: -f1) 2>/dev/null || true; fi && \
    addgroup -g 1000 nodeuser && adduser -D -u 1000 -G nodeuser nodeuser

# Copy common package and install as nodeuser so /common is owned by nodeuser
COPY --from=builder /build/src/common/package.json /common/
COPY --from=builder /build/src/common/dist /common/dist
# Copy the local observability-client package so 'file:src/observability/observability-client' resolves
COPY --from=builder /build/src/common/src/observability/observability-client /common/src/observability/observability-client
WORKDIR /common
RUN chown -R nodeuser:nodeuser /common && su nodeuser -c "npm install --omit=dev"

# Copy service package and install as nodeuser so /app is owned by nodeuser
WORKDIR /app
COPY --from=builder /build/src/nemo/config-service/package.json ./
RUN chown -R nodeuser:nodeuser /app && su nodeuser -c "npm install --omit=dev"

# Copy built files as nodeuser so no chown of large trees is needed
COPY --from=builder --chown=nodeuser:nodeuser /build/src/nemo/config-service/dist ./dist
COPY --from=builder --chown=nodeuser:nodeuser /build/src/nemo/config-service/dist/openapi.yaml ./dist/openapi.yaml

USER nodeuser

EXPOSE 3000

ENV NODE_OPTIONS="--require /app/node_modules/@agentstudio/observability-client-runtime/dist/preload.js"

CMD ["node", "dist/index.js"]
