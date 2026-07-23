# Build stage: native build (no cross-compilation)
FROM docker.repo.eng.netapp.com/golang:1.24-alpine AS builder

WORKDIR /build

# Shared Go observability client (go.mod replace => ../../common-go/observability/observability-client)
COPY src/common-go/observability/observability-client/ src/common-go/observability/observability-client/

COPY src/nemo/workflow-engine/go.mod src/nemo/workflow-engine/go.sum* src/nemo/workflow-engine/

WORKDIR /build/src/nemo/workflow-engine

RUN go mod download

# Copy source code
COPY src/nemo/workflow-engine/ .

RUN CGO_ENABLED=0 go build -a -installsuffix cgo -o workflow-engine ./cmd/server

# Runtime stage
FROM docker.repo.eng.netapp.com/alpine:latest

# `git` is required by the ArtifactGC activity (workflows/artifact_gc.go),
# which shells out to `git for-each-ref` / `git log -1` / `git update-ref`
# / `git gc --auto` against bare artifact-store repos on the shared NFS.
# Without it the activity silently fails with `exec: "git": executable file not found`.
RUN apk --no-cache add ca-certificates git && \
    addgroup -g 1000 appuser && adduser -D -u 1000 -G appuser appuser

WORKDIR /app
COPY --from=builder --chown=appuser:appuser /build/src/nemo/workflow-engine/workflow-engine .

USER appuser

EXPOSE 8080

CMD ["./workflow-engine"]
