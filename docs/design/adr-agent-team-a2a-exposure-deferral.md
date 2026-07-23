# ADR: Defer Outbound A2A Exposure for Agent Teams

## Status

Accepted

## Context

The current delivery focuses on:

- Agent group to agent team renaming
- Team hierarchy and manager/member modeling
- Team invoke parity with standalone agent invoke
- Session isolation and observability hardening

Outbound A2A exposure adds an external protocol boundary and introduces additional security and operability requirements.

## Decision

Outbound A2A exposure is deferred for this release. Only internal/local execution and optional in-platform A2A member delegation abstractions are included.

## Consequences

- Faster delivery of team parity and session safety guarantees
- Lower security risk by avoiding premature external exposure
- Clear follow-up work packaged in `agent-team-a2a-exposure-deferred.md`

## Follow-up Trigger

Resume outbound A2A exposure implementation only after:

1. Team invoke parity is complete (sync/stream/async/session CRUD parity)
2. Session isolation tests pass for standalone + nested team execution
3. Security and platform reviews approve authz, quota, and audit posture
