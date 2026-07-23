# Agent Code Sandbox Build-vs-Buy

## Context
- We need secure, scalable execution of AI-generated free-form code (primarily Python and JavaScript).
- Execution must run in the same Kubernetes cluster where AgentStudio is deployed (cloud or on-prem).
- Isolation target is **balanced**: stronger than plain containers, without defaulting to highest-cost microVM-per-request everywhere.

## Decision Drivers
- Security isolation and blast-radius reduction for untrusted code.
- Horizontal scalability under bursty agent workloads.
- Cost efficiency and operational simplicity over time.
- Compliance and data residency control (especially for on-prem deployments).
- Integration fit with existing AgentStudio runtime management patterns.

## Options Considered

### Option A: E2B (Managed Service)
- **What it is:** hosted sandbox execution platform with APIs tailored for AI-agent code execution.
- **Pros**
  - Fastest time-to-value.
  - Reduced platform engineering effort.
  - Good developer experience for sandbox lifecycle and execution.
- **Cons**
  - Paid product with ongoing vendor cost.
  - External dependency in critical execution path.
  - Potential compliance/data-boundary concerns in regulated environments.
- **Best fit**
  - Rapid experimentation, MVP phases, and lower-sensitivity workloads.

### Option B: Daytona (Open Source)
- **What it is:** workspace/runtime orchestration focused on development environments.
- **Pros**
  - Open source, extensible.
  - Strong if agents need long-lived, project-aware environments.
- **Cons**
  - Not a direct 1:1 replacement for tightly constrained, ephemeral sandbox execution jobs.
  - May require additional guardrail layers for strict untrusted-code execution posture.
- **Best fit**
  - Interactive or persistent agent developer workflows, not minimal one-shot execution.

### Option C: Self-Hosted Sandbox (Open Components)
- **What it is:** in-cluster execution service built on Kubernetes Jobs/Pods, hardened runner images, and runtime sandboxing (`gVisor` or `Kata`).
- **Pros**
  - Full control over isolation, policy, and data boundaries.
  - Strong alignment with current AgentStudio Kubernetes-centric architecture.
  - No hard vendor lock-in for execution control plane.
- **Cons**
  - Highest engineering and operations ownership.
  - Requires ongoing security and reliability investment.
- **Best fit**
  - Production deployments requiring compliance, on-prem flexibility, and predictable control.

## Comparison Summary
- **Security Control:** Self-Hosted > E2B > Daytona (for this exact use case)
- **Time to Market:** E2B > Daytona > Self-Hosted
- **Long-Term Control/Compliance:** Self-Hosted > Daytona > E2B
- **Operational Burden:** E2B < Daytona < Self-Hosted
- **Fit for Ephemeral Code-Exec API:** E2B ~= Self-Hosted > Daytona

## Recommended Approach
- **Primary path:** implement a self-hosted, in-cluster sandbox execution plane for production.
- **Execution model:**
  - Queue-backed submit/status/cancel API.
  - Ephemeral runner pod per execution.
  - Hardened runtime (`runAsNonRoot`, `allowPrivilegeEscalation=false`, read-only root FS, dropped capabilities, seccomp/AppArmor, no host mounts).
  - RuntimeClass-backed isolation (`gVisor` or `Kata`) for balanced security.
  - Default-deny egress with profile-based allowlisting.
  - Strict CPU/memory/time/output limits with deterministic cleanup.
- **Secondary path:** preserve an abstraction layer so E2B can be used as a tactical accelerator for experiments or overflow capacity.
- **Deferred scope:** Daytona-style persistent workspaces unless agent workflows require long-lived interactive sessions.

## Critical Architecture Review (Current Agent-Service Flow)
- Agent invocations currently execute in API-driven request paths (`invoke`, `invoke/stream`, `invoke/async`) and call `agent.arun()` directly.
- This means any future "run generated code" capability must not execute inside agent-service process memory/runtime.
- Required design correction:
  - keep agent-service as orchestration/control plane,
  - route untrusted code execution to isolated sandbox runtime via explicit tool APIs,
  - preserve existing SSE tool event semantics so client UX does not regress.

## How Agents Should Execute Code Securely
1. Agent emits tool call to `sandbox.submit(...)` with language, code, limits, and optional workspace ID.
2. Agent-service forwards request to sandbox gateway (internal auth + tenant context).
3. Sandbox scheduler enqueues and starts isolated pod/job with policy profile.
4. Runner returns status + bounded logs + artifact references.
5. Agent polls (`sandbox.status`) or receives completion callback and continues reasoning.

This keeps untrusted code outside the agent-service trust boundary while preserving current API-driven invocation architecture.

## File State for Agents: Evolved Design
- Support two workspace modes:
  - **Ephemeral:** per execution, deleted immediately (default for highest safety).
  - **Persistent:** scoped per `(projectId, agentId, sessionId)` for iterative agent workflows.
- Persistent workspace architecture:
  - object storage for file blobs,
  - metadata index in DB (path, checksum, size, version, updatedBy),
  - mount/sync mechanism at run start/end (copy-in/copy-out).
- Guardrails:
  - strict path normalization and traversal prevention,
  - size/file-count quotas and TTL expiry,
  - extension and content policy checks,
  - workspace version locking for concurrent updates.

## Additional Risks and Mitigations
- **Risk: API latency inflation** if agent request waits for long-running sandbox jobs.
  - **Mitigation:** treat execution as async tool operation with progress polling and bounded wait windows.
- **Risk: noisy-neighbor workloads across tenants.**
  - **Mitigation:** per-tenant concurrency tokens + namespace resource quotas + queue priority classes.
- **Risk: state exfiltration via outbound network and artifact channels.**
  - **Mitigation:** default-deny egress, destination allowlists, signed short-lived artifact URLs, audit logging.
- **Risk: prompt-induced unsafe filesystem usage.**
  - **Mitigation:** virtual workspace root, deny absolute paths, deny symlink escapes, and enforce write policy in runner.

## Why This Fits AgentStudio
- Existing runtime provisioning patterns already exist in config-service (`MCPRuntimeManager`) and can be reused for sandbox orchestration logic (labels, policies, readiness, cleanup, reconciliation).
- Cluster-local execution minimizes external data transfer and supports cloud/on-prem deployment parity.
- Policy controls can align with existing multi-tenant project model and secret handling patterns.

## Security Baseline (Phase 1)
- No package installation by default during execution.
- No outbound network unless explicit policy profile allows it.
- Per-job ephemeral filesystem only.
- Enforced timeout and output truncation.
- Per-tenant quotas and rate limits.
- Full audit metadata for each execution request.
- Agent-service never executes generated code directly; only sandbox runtime may execute it.

## Rollout Plan
1. Build MVP self-hosted sandbox (Python + JS, no-network profile default) with submit/status/cancel tool APIs.
2. Integrate agent-service tool path so code execution is always out-of-process.
3. Add runtime sandbox class and policy profiles for selective egress.
4. Add persistent workspace mode (quota + versioning + TTL) for stateful agent workflows.
5. Add autoscaling, admission control, and dead-letter handling.
6. Run adversarial tests and security review gates.
7. Optionally validate E2B integration behind the same execution interface.

## Open Questions
- Which RuntimeClass is preferred in target clusters (`gVisor` vs `Kata`)?
- Should controlled outbound web access be enabled in phase 1, or deferred to phase 2?
- What per-tenant SLOs and cost ceilings should drive autoscaling policy?
- Should persistent workspaces be enabled by default per agent, or only via explicit policy opt-in?
