# syntax=docker/dockerfile:1
# Build context: src/nemo/workers/ (per scripts/docker-build-image.sh convention).
# Built and pushed via `make workers-build` / `make -C src/nemo/workers/eval-worker build`.

# ── Build stage ─────────────────────────────────────────────────────
# bookworm-slim (glibc) chosen over alpine for @temporalio/core-bridge native
# bindings, which ship prebuilds for glibc.
FROM docker.repo.eng.netapp.com/node:20-bookworm-slim AS builder

WORKDIR /build/eval-worker

# Install deps first to maximise layer caching when source changes.
COPY eval-worker/package.json eval-worker/package-lock.json ./
RUN npm ci

COPY eval-worker/tsconfig.json eval-worker/tsconfig.app.json ./
COPY eval-worker/scripts ./scripts
COPY eval-worker/src ./src
COPY eval-worker/test ./test

# Pre-bundle workflows into a sandbox-safe JS bundle that main.ts loads at
# runtime (Temporal needs a real filesystem path for the bundle).
RUN npx ts-node --transpile-only scripts/bundle-workflows.ts \
 && npx tsc -p tsconfig.app.json \
 && cp tmp/workflow-bundles-eval/workflow-bundle.js dist/workflow-bundle.js

# ── Runtime stage ───────────────────────────────────────────────────
FROM docker.repo.eng.netapp.com/node:20-bookworm-slim AS runner

ENV NODE_ENV=production

WORKDIR /app

# Run eval-worker as root so it can reliably read/write shared PVC content
# mounted under /mnt/pvcs/default-nemo, which is also used by root-based
# workers in this deployment set.
USER root

COPY --from=builder /build/eval-worker/package.json /build/eval-worker/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /build/eval-worker/dist ./dist

# Prometheus metrics exporter (see src/main.ts METRICS_PORT default).
ENV METRICS_PORT=9465
EXPOSE 9465

CMD ["node", "dist/main.js"]
