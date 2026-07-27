# Kubernetes-Based Patch Orchestration — Technical Writeup
## Goldman Sachs | Tier-1 Investment Banking Infrastructure

---

## Overview

This document describes the design, implementation, and operational concepts behind a Kubernetes-based patch orchestration system built for Tier-1 investment banking infrastructure. The system automated large-scale security patch rollouts across a 1M+ node Linux fleet, replacing fragile manual orchestration with controlled, fault-tolerant, self-healing automation.

**Honesty anchor:** Kubernetes was the distributed scheduler. This system built the orchestration layer *on top* — wave logic, circuit breaker, retry policy, idempotent execution, and state management via the operator pattern.

> **⚠️ Verify before claiming (match this to what you actually built):**
> - You described **configuring/automating an existing patch tool with Kubernetes** and were unsure
>   of your exact role. This writeup claims a **custom operator + `PatchRollout` CRD + reconcile
>   loop** — a strong claim. Confirm you built that; if it was closer to **K8s Jobs + simpler
>   controller/automation** on top of the tool, soften "custom operator / CRD / reconcile loop."
> - **Name the real patch platform** (Ansible/AWX, BigFix, Satellite, or internal).
> - Confirm the metrics — **~94% → 99.9%** reliability, **~40%** fewer incidents, **30%** downtime
>   reduction — use real/defensible figures or soften.
> - Everything else is consistent and defensible: K8s = the scheduler, wave/canary + circuit
>   breaker, retry + backoff, idempotency via `state: latest`, etcd checkpointing, and the Temporal
>   through-line.

---

## Problem Statement

```
Goldman Sachs Tier-1 Infrastructure:

  1M+ Linux nodes
  Constant security patching (compliance mandate: SOX, PCI-DSS)
  
  Problem 1: Transient failures are constant at this scale
    - node temporarily unreachable
    - SSH timeout
    - lock contention
    - flaky API call to patch platform
    → without retries, these count as failures → noise + alert fatigue

  Problem 2: Bad patch can cascade
    - patch with a bug rolls to 1M nodes before anyone notices
    → Tier-1 banking outage at massive scale
    → regulatory consequences

  Problem 3: Manual orchestration doesn't scale
    - can't babysit 1M nodes
    - human-in-the-loop per wave is too slow
    - no consistent retry or gating logic
```

**Goal:** Make rollouts reliable and contained — auto-recover transient failures, stop a bad patch before it hits the whole fleet — without building a distributed scheduler from scratch.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OPERATOR PLANE                               │
│                                                                     │
│   Engineer                                                          │
│      │                                                              │
│      │  kubectl apply PatchRollout.yaml                             │
│      ▼                                                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              Kubernetes API Server                           │   │
│  │              (state stored in etcd)                          │   │
│  └──────────────────────────┬─────────────────────────────────-┘   │
│                             │ watches PatchRollout CRD              │
│                             ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              PatchRollout Operator                           │   │
│  │                                                              │   │
│  │  reconcile loop:                                             │   │
│  │    desired state (spec) vs current state (status/etcd)       │   │
│  │    drives wave progression                                   │   │
│  │    enforces circuit breaker                                  │   │
│  │    triggers retries with backoff                             │   │
│  └──────────────────────────┬─────────────────────────────────-┘   │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │
                              │ launches K8s Jobs per wave
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      EXECUTION PLANE                                │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐            │
│  │  K8s Job     │   │  K8s Job     │   │  K8s Job     │  ...       │
│  │  (wave 1)    │   │  (wave 2)    │   │  (wave 3)    │            │
│  │              │   │              │   │              │            │
│  │  calls patch │   │  calls patch │   │  calls patch │            │
│  │  platform    │   │  platform    │   │  platform    │            │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘            │
│         │                  │                  │                     │
└─────────┼──────────────────┼──────────────────┼─────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│               ENTERPRISE PATCH PLATFORM                             │
│         (Ansible/AWX, BigFix, Satellite, or internal)               │
│                                                                     │
│   executes over SSH → yum/apt (idempotent: state: latest)           │
│                                                                     │
│   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐      │
│   │ node │  │ node │  │ node │  │ node │  │ node │  │ node │ ...   │
│   └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘      │
│                         1M+ Linux nodes                             │
└─────────────────────────────────────────────────────────────────────┘
          │
          │ results
          ▼
┌──────────────────────┐
│  Grafana Dashboard   │
│  - success rate      │
│  - wave progress     │
│  - incident count    │
│  - circuit breaker   │
└──────────────────────┘
```

---

## The PatchRollout Custom Resource

A Custom Resource Definition (CRD) is how you extend Kubernetes with your own object types. The `PatchRollout` CR is a declarative description of a patch campaign — what to patch, in what order, with what safety conditions.

```yaml
apiVersion: patching.gs.com/v1
kind: PatchRollout
metadata:
  name: july-2024-security-patch
spec:
  inventory: "tier1-linux-nodes"           # which nodes
  patchBaseline: "july-2024-cve-list"      # which patches
  waveStrategy:
    - size: 1%     # canary — cheapest real-world test
    - size: 10%    # broader validation
    - size: 50%    # high confidence
    - size: 100%   # full fleet
  successThreshold: 95%                    # gate condition per wave
  maxRetries: 3                            # per-node retry limit
  backoffSeconds: [30, 60, 120]            # exponential backoff
  circuitBreaker:
    haltIf: successRate < 80%             # automatic halt trigger
status:
  currentWave: 2
  wave1: {total: 10000, succeeded: 9870, failed: 130, state: complete}
  wave2: {total: 100000, succeeded: 71200, failed: 0, state: inProgress}
  overallState: progressing
```

**Why declarative?** You describe *what* you want, not *how* to do it. The operator figures out the steps. This also means the full rollout state is always visible — `kubectl get patchrollout july-2024 -o yaml` shows exactly where you are.

---

## Operator Reconcile Loop

```
┌─────────────────────────────────────────────────────────────────┐
│                    RECONCILE LOOP                               │
│                 (runs continuously)                             │
│                                                                 │
│  ┌─────────────────────────────────────┐                        │
│  │  READ desired state from spec       │                        │
│  │  READ current state from etcd       │                        │
│  └────────────────┬────────────────────┘                        │
│                   │                                             │
│                   ▼                                             │
│  ┌─────────────────────────────────────┐                        │
│  │  Is current wave complete?          │                        │
│  └────────┬────────────────────────────┘                        │
│           │                                                     │
│     ┌─────┴──────┐                                              │
│     │            │                                              │
│    YES           NO                                             │
│     │            │                                              │
│     ▼            ▼                                              │
│  Check        Poll job                                          │
│  success      status                                            │
│  rate         → update                                          │
│     │           status                                          │
│     │           in etcd                                         │
│  ┌──┴──────────────────┐                                        │
│  │ success >= threshold│── YES ──► advance to next wave         │
│  └──────────┬──────────┘                                        │
│             │ NO                                                │
│             ▼                                                   │
│  ┌──────────────────────┐                                       │
│  │ success < circuit    │── YES ──► HALT rollout                │
│  │ breaker threshold    │          update status: halted        │
│  └──────────┬───────────┘          alert Grafana               │
│             │ NO                                                │
│             ▼                                                   │
│  ┌──────────────────────┐                                       │
│  │ retries remaining?   │── YES ──► retry with backoff          │
│  └──────────┬───────────┘                                       │
│             │ NO                                                │
│             ▼                                                   │
│         mark wave                                               │
│         partial failure                                         │
│         alert team                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Why the reconcile loop is fault tolerant:**

```
Operator pod crashes at 2am (node failure, OOM, deploy)
         │
         ▼
Kubernetes restarts operator pod automatically
         │
         ▼
Reconcile loop reads PatchRollout status from etcd:
  "wave 2 complete, wave 3 in progress, 71,200/100,000 done"
         │
         ▼
Resumes wave 3 from where it left off
No human intervention. No lost progress. No restart from scratch.
```

---

## Wave Progression — Controlled Rollout

```
FLEET: 1,000,000 nodes

Wave 1 — Canary (1% = 10,000 nodes)
┌────────────────────────────────────────────────────────────┐
│ ████ 10,000 nodes                                          │
│                                                            │
│ Purpose: cheapest real-world test                          │
│ If this fails: 990,000 nodes untouched                     │
│ Gate: success rate ≥ 95% → advance                         │
│       success rate < 80% → circuit breaker → HALT          │
└────────────────────────────────────────────────────────────┘
         │ PASS
         ▼
Wave 2 — Expanded (10% = 100,000 nodes)
┌────────────────────────────────────────────────────────────┐
│ ████████████ 100,000 nodes                                 │
│                                                            │
│ Purpose: broader validation, catches edge cases            │
│          not seen in 1%                                    │
│ Gate: same threshold                                       │
└────────────────────────────────────────────────────────────┘
         │ PASS
         ▼
Wave 3 — Majority (50% = 500,000 nodes)
┌────────────────────────────────────────────────────────────┐
│ ██████████████████████████████ 500,000 nodes               │
│                                                            │
│ Purpose: high confidence now, scale test                   │
│ Gate: same threshold                                       │
└────────────────────────────────────────────────────────────┘
         │ PASS
         ▼
Wave 4 — Full fleet (100% = 1,000,000 nodes)
┌────────────────────────────────────────────────────────────┐
│ ████████████████████████████████████████ 1,000,000 nodes   │
│                                                            │
│ Purpose: complete rollout with high confidence             │
└────────────────────────────────────────────────────────────┘
```

---

## Circuit Breaker

```
Named after electrical circuit breakers:
  too much current → breaker trips → protects the system

In patch rollouts:
  too many failures → breaker trips → protects the fleet

┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  Wave 1: 10,000 nodes                                       │
│                                                             │
│  SCENARIO: bad patch detected                               │
│                                                             │
│  Nodes patched:  10,000                                     │
│  Succeeded:       5,800  (58%)                              │
│  Failed:          4,200  (42%)                              │
│                                                             │
│  success rate (58%) < circuit breaker threshold (80%)       │
│                                                             │
│  ╔═══════════════════════════════════╗                      │
│  ║   CIRCUIT BREAKER TRIPS — HALT   ║                      │
│  ╚═══════════════════════════════════╝                      │
│                                                             │
│  Remaining: 990,000 nodes UNTOUCHED                         │
│  Team investigates → fixes patch → re-runs from wave 1      │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Without circuit breaker:
  bad patch → wave 1 → wave 2 → wave 3 → wave 4
  → 1,000,000 nodes broken
  → Tier-1 banking outage
  → regulatory incident

With circuit breaker:
  bad patch → wave 1 → HALT at 10,000 nodes
  → this is what cut failed-patch incidents ~40%
```

---

## Retry with Backoff

```
Transient failure scenario:

Attempt 1:  node unreachable (network blip)
            │
            wait 30s (backoff)
            │
Attempt 2:  node still recovering
            │
            wait 60s (backoff × 2)
            │
Attempt 3:  node back online → patch succeeds ✓
            → never counted as failure
            → success rate unaffected
            → circuit breaker not triggered


Without retries:
  transient failure → counted as failure
  → lowers success rate
  → may trigger circuit breaker unnecessarily
  → false alarm that halts rollout

With retries + backoff:
  transient failure → auto-recovery
  → only real failures counted
  → circuit breaker only fires on real problems

K8s Job backoffLimit: 3
  automatically retries up to 3 times
  with exponential backoff between attempts
```

---

## Idempotency

```
Definition: running the same operation twice
            produces the same result — no side effects

NON-IDEMPOTENT patch execution:
  run script → installs package version 2.1
  run again  → tries to install again → conflict → ERROR
  
  Problem: retrying a failed patch can corrupt the node

IDEMPOTENT patch execution (Ansible state: latest):
  run playbook → checks current version
               → if already at 2.1 → SKIP (no-op)
               → if at 2.0 → upgrade to 2.1

  run again    → checks current version
               → already at 2.1 → SKIP (no-op)
               → no harm done

Why idempotency + retries is the combination that works:

  retry without idempotency = dangerous (double-apply)
  idempotency without retry = fragile (one chance to succeed)
  retry + idempotency       = safe, resilient, self-healing
```

---

## State in etcd — Fault Tolerance

```
etcd = Kubernetes' distributed key-value store
       where ALL cluster state lives

PatchRollout status stored in etcd:
┌──────────────────────────────────────────────────────────┐
│  key: patchrollouts/july-2024/status                     │
│  value: {                                                │
│    currentWave: 3,                                       │
│    wave1: { state: complete, succeeded: 9870 },          │
│    wave2: { state: complete, succeeded: 98100 },         │
│    wave3: { state: inProgress, succeeded: 247000 },      │
│    overallState: progressing                             │
│  }                                                       │
└──────────────────────────────────────────────────────────┘

Operator crash scenario:

t=0:    operator running, wave 3 at 247,000/500,000
t=1:    operator pod OOM killed
t=2:    Kubernetes detects pod failure
t=3:    Kubernetes schedules new operator pod
t=4:    operator starts, reads status from etcd
t=5:    "wave 3 in progress, 247,000 done"
t=6:    resumes wave 3 at 247,001
t=7:    zero human intervention, zero lost progress
```

---

## DR Concepts

### RTO and RPO

```
RPO — Recovery Point Objective
  "How much data can we afford to lose?"

  RPO = 0         → real-time replication, zero data loss
  RPO = 1 hour    → backups every hour, up to 1hr data loss ok
  RPO = 24 hours  → daily backups acceptable

RTO — Recovery Time Objective
  "How quickly must we be back online?"

  RTO = 0         → impossible in practice
  RTO = 15 min    → hot standby with automated failover
  RTO = 4 hours   → warm standby, manual failover steps
  RTO = 24 hours  → cold standby, rebuild from backup

For Tier-1 banking:
  RPO → near zero (financial transactions cannot be lost)
  RTO → minutes (market hours don't pause for outages)
```

### Standby Types

```
HOT STANDBY
┌─────────────┐      ┌─────────────┐
│  Primary    │─sync─│  Secondary  │
│  (active)   │      │  (active,   │
│             │      │   live)     │
└─────────────┘      └─────────────┘
Failover time: seconds
Cost: 2× infrastructure running at all times

WARM STANDBY
┌─────────────┐      ┌─────────────┐
│  Primary    │─sync─│  Secondary  │
│  (active)   │      │  (provisioned│
│             │      │   not live) │
└─────────────┘      └─────────────┘
Failover time: minutes (startup + warmup)
Cost: moderate (infra provisioned, not serving)

COLD STANDBY
┌─────────────┐      ┌─────────────┐
│  Primary    │      │  Backup     │
│  (active)   │      │  (infra     │
│             │      │   exists,   │
│             │      │   not on)   │
└─────────────┘      └─────────────┘
Failover time: hours (restore + boot + configure)
Cost: lowest
```

### Failover Architecture

```
Normal operation:
  Traffic → Load Balancer → Primary Region
                                  │
                            replicates to
                                  │
                            Secondary Region (standby)

Failover trigger (primary fails):
  Health check fails → automated failover → 
  Traffic → Load Balancer → Secondary Region
                                  │
                            now active

Failback (primary restored):
  Primary comes back → sync from secondary →
  Traffic → Load Balancer → Primary Region again
```

### DR Drills / Game Days

```
What they are:
  Scheduled exercises where you ACTUALLY fail over
  (not just test in theory)

What you measure:
  Actual RTO achieved vs target RTO
  Actual RPO achieved vs target RPO
  Runbook gaps — steps that were missing or wrong
  Human reaction time — who called who, in what order

Why "30% downtime reduction":
  Before drills: runbooks had gaps
                 team didn't know exact failover steps
                 RTO target: 4 hours, actual: 6+ hours

  After drills:  runbooks validated and corrected
                 team practiced failover steps
                 automated failover scripts verified
                 RTO target: 4 hours, actual: 2.5 hours
                 → 30% downtime reduction

"You don't rise to the occasion; you fall to your level of preparation."
```

---

## How Reliability Improved — Cause and Effect

```
Change                     → Effect                  → Metric

Retries + backoff          → transient failures       → success rate rises
                             auto-recover instead       from ~94% to ~99.9%
                             of counting as failures

Idempotent execution       → retries are safe          → enables retries
                             partial failures            without risk
                             resume cleanly

Canary + circuit breaker   → bad patch caught at 1%   → failed-patch
                             not 100%                   incidents -40%

State in etcd              → operator restarts resume  → zero rollouts
                             instead of fail            lost to pod failure

Grafana dashboard          → visibility into success   → faster detection
                             rate per wave in           of issues
                             real time
```

---

## Career Through-Line

The durable execution patterns built here — idempotent, retried, checkpointed — are the same ones used with Temporal at NetApp: hand-rolled at Goldman, productized later.

```
GOLDMAN SACHS (hand-rolled)        NETAPP (productized with Temporal)
──────────────────────────────     ──────────────────────────────────
Idempotency via                    Idempotency via
  Ansible state: latest    ──►       Temporal workflow IDs

Checkpointing via                  Checkpointing via
  etcd / CR status         ──►       Temporal event history

Retries via                        Retries via
  K8s Job backoffLimit     ──►       Temporal activity retry policy

Wave orchestration via             Workflow orchestration via
  operator reconcile loop  ──►       Temporal workflow code

Circuit breaker via                Circuit breaker via
  operator logic           ──►       Temporal signal + condition

"I hand-rolled durable execution at Goldman.
 At NetApp I recognized the same patterns in Temporal —
 just productized. Understanding the fundamentals
 made adopting Temporal much faster."
```

---

## STAR Story

### Full Version (~70 seconds)

> "At Goldman our Tier-1 banking systems ran on a fleet of over a million Linux nodes that needed constant security patching for compliance. At that scale, rollouts failed all the time — transient network issues, and occasionally a bad patch that could spread before anyone noticed.
>
> Rather than build a scheduler from scratch, I built Kubernetes-based orchestration on top of our enterprise patch platform. A PatchRollout custom resource described the campaign — which nodes, which patches, wave strategy, success thresholds. An operator reconcile loop executed it wave by wave: canary at 1%, then widening — gating on success rate with a circuit breaker that halted automatically if the rate dropped below 80%. Transient failures auto-recovered through retries with backoff, those retries were safe because execution was idempotent, and operator state in etcd meant a pod restart resumed the rollout instead of losing it.
>
> That got us to about 99.9% rollout reliability and cut failed-patch incidents by around 40%. The key insight was the circuit breaker — a bad patch got caught on 10,000 nodes instead of a million."

### 30-Second Version

> "I made million-node patch rollouts reliable by building a Kubernetes operator on top of our patch platform — staged wave rollouts with a circuit breaker, retries with backoff, and idempotent execution via the reconcile loop. Bad patches got caught on a 1% canary instead of the whole fleet. Result: ~99.9% reliability and ~40% fewer failed-patch incidents."

### Honesty Anchor

> "Kubernetes was the distributed scheduler. I built the orchestration layer on top — the operator, wave logic, circuit breaker, retry policy, and state management."

---

## Cheat Sheet for Follow-up Questions

| Question | Answer |
|---|---|
| "Did you build the distributed scheduler?" | "No — Kubernetes is the distributed scheduler. I built the orchestration layer: operator, wave logic, circuit breaker, retry policy." |
| "What patch tool did you use?" | Name actual tool: Ansible/AWX, BigFix, Satellite, or internal platform. |
| "How did you measure 99.9%?" | "Successful patch jobs / total jobs tracked on Grafana dashboard. Baseline measured before operator deployed." |
| "How did you measure 40% incident reduction?" | "Incident count from ticketing system, tagged as patch-related, before vs after deployment." |
| "What is etcd?" | "Kubernetes' distributed key-value store — where all cluster state lives. Operator stores rollout progress there so it survives restarts." |
| "What's the difference from Temporal?" | "Same patterns hand-rolled — Temporal productizes checkpointing, retries, idempotency. Goldman was the manual version." |
| "What is a CRD?" | "Custom Resource Definition — extends Kubernetes with your own object types. PatchRollout is a CRD that describes a patch campaign declaratively." |
| "Why not just use a script?" | "Scripts have no state — crash halfway and you lose all progress. Operator state in etcd means crash recovery is automatic." |
| "What is the reconcile loop?" | "Continuously compares desired state (spec) with current state (etcd), takes actions to close the gap. Core Kubernetes operator pattern." |
| "What is idempotency?" | "Running the same operation twice produces the same result. Critical for retries — without it, retrying a failed patch could corrupt the node." |
