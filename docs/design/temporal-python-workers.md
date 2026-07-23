# Temporal Python Workers — Migration Record

## Status

**Done** — March 2026

## Summary

This document records the migration from ephemeral Kubernetes Jobs to long-running Temporal Python workers for dataset import and KB update processing. For the current architecture, see [workflows.md](workflows.md).

## Previous Architecture (K8s Jobs)

The Go workflow engine created ephemeral K8s Jobs for each processing task. This had five problems:

1. **Cold-start latency** — Each Job pod downloaded ~1.5 GB of ML models on every invocation.
2. **Polling overhead** — The workflow engine busy-polled K8s Job status every 10s (up to 180 attempts).
3. **Secret management complexity** — Ephemeral K8s Secrets with race conditions on concurrent create/delete.
4. **No fault-tolerant progress** — Pod failure lost all progress; entire Job restarted from scratch.
5. **Orchestration brittleness** — Four layers of indirection (create Job, poll, read S3, cleanup) for what is now a single activity dispatch.

## Decision: Pure Temporal Activity Dispatch

All processing work is dispatched as Temporal activities to long-running Python worker Deployments. The workflow engine never creates K8s Jobs. Models are loaded once at pod startup, progress uses Temporal heartbeats, credentials are passed as activity input, and retries operate at the individual activity level.

### Rejected Alternatives

- **KEDA + Redis** — Created a parallel orchestration layer redundant with Temporal.
- **K8s Job fallback mode** — Two code paths doubled the maintenance surface. The "fallback" framing implied the new path was unreliable and created deployment ambiguity.

### Rollout

1. Deploy `processing-workers` Helm chart (workers start listening on queues).
2. Deploy updated workflow-engine (dispatches activities instead of creating K8s Jobs).
3. In-flight K8s Jobs continued to completion uninterrupted.
4. Old K8s Job infrastructure removed after verification.

## References

- **Current architecture:** [workflows.md](workflows.md) — execution model, scatter-gather, scaling, graceful shutdown, observability. Shard sizing and assignment: [`work_planning.py`](../../src/nemo/workers/shared/work_planning.py) (`CreateWorkPlanActivity`).
- **Historical:** Earlier KEDA+Redis proposal (removed; see decision log above).
