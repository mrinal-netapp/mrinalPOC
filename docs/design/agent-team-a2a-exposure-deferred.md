# Agent Team A2A Exposure (Deferred)

## Scope

This document captures the deferred design for exposing platform-managed agents and teams over A2A-compatible interfaces. This is design-only and not part of the current implementation.

## Deferred Items

- External A2A-facing endpoints for published agents/teams
- Exposure registry with aliasing/versioning controls
- External service discovery metadata for exposed entities
- Tenant-aware authz and rate limiting policy at the A2A boundary

## Proposed API Shape

- `POST /api/v1/a2a/agents/{exposedId}/tasks`
- `GET /api/v1/a2a/tasks/{taskId}`
- `POST /api/v1/a2a/tasks/{taskId}/cancel`
- Optional `.../stream` endpoint for token/event streaming

## Envelope Mapping

Incoming A2A request should map to current invoke model:

- Input: `task_id`, `trace_id`, `deadline_ms`, `input`, `tool_context`
- Internal invoke: `{ message, sessionId, context }`
- Output: `status`, `structured_output`, `artifacts`, `token_usage`, `error`

## Security Model

- Service-to-service identity required for all A2A endpoints
- Credential scope bound to project/team
- Mandatory idempotency keys for task submission
- Audit logs with caller identity and delegated member target

## Observability Requirements

- Correlate A2A `trace_id` with internal manager/member spans
- Emit per-exposed-entity SLO metrics: availability, p95 latency, error rate, and token/cost usage

## Reactivation Criteria

- Agent/team invoke parity complete and validated in staging
- Session isolation invariants hold under load
- Security sign-off for authn/z and quota enforcement
- Operability sign-off for dashboards + alerts
