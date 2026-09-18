# Leadership & Impact Stories — NetApp / AgentStudio

Companion to `leadership-stories.md` (which covers Microsoft / Commerce Cloud / DIME DQ).
These are the NetApp stories to use for behavioural questions.

**Honesty guardrail for the whole file:** every claim below is traceable to the resume or the AgentStudio codebase. Stories marked **FILL IN** are scaffolds — I can't write those for you, and inventing them is the fastest way to get caught. Prepare them from memory before the interview.

---

## Question → story map

| If they ask… | Use |
|---|---|
| Biggest achievement / what are you most proud of | **Story 1** — zero-trust security architecture |
| Influence without authority / drove adoption | **Story 2** — observability SDK |
| Technical judgement / an optimization you're proud of | **Story 3** — queue-backlog autoscaling |
| Handling ambiguity / greenfield ownership | **Story 4** — platform design from scratch |
| Scale / reliability under failure | **Story 5** — Temporal orchestration at 10k/day |
| Conflict or disagreement | **Story 6** — FILL IN (scaffold provided) |
| A failure / something you got wrong | **Story 7** — FILL IN (scaffold provided) |
| Deep technical rigour | **Story 8** — the incremental re-ingest flaw (read the caveat) |

---

## Story 1 — Zero-trust security across a 15-service mesh
### *Use for: biggest achievement, end-to-end ownership, cross-cutting influence*

### Narrate this first (~40s)

> "The piece I'm proudest of is the end-to-end security architecture for our agent platform. It's a multi-tenant system where customers run agents over their own enterprise data, so the guarantee we had to make was absolute: a user in one project can never reach another project's data, agents, or credentials — and NetApp itself can't reach the customer's credentials either.
>
> I designed and implemented that across 15 microservices as a layered model. At the edge, JWT validation through Keycloak OIDC with per-project RBAC scope enforcement. Inside the mesh, Istio mTLS with SPIFFE workload identities and per-service authorization-policy allow-lists, so pod-to-pod access is explicitly enumerated rather than implicitly permitted. And credentials are materialized as Kubernetes secrets at runtime instead of being persisted anywhere — which removed plaintext credential exposure from the system entirely."

### Why this is the strongest "biggest achievement"

- **Scope** — 15 services, not one component
- **Architecture-level ownership**, not a feature
- **Cross-cutting** — required every other team to adopt it (that's the leadership part)
- **It's a guarantee, not a capability** — security work is judged by what *can't* happen

### The beats (expand as probed)

1. **Situation** — multi-tenant platform, enterprise customers, deployed inside *their* cloud boundary. Trust model had to hold even against NetApp.
2. **Problem** — default Kubernetes networking is flat: any pod can talk to any pod. Project isolation was a policy claim with nothing enforcing it.
3. **Approach** — defence in depth:
   - Edge: JWT (Keycloak OIDC) + per-project RBAC scopes
   - Mesh: Istio mTLS + SPIFFE workload identity, **explicit allow-lists** per service
   - Secrets: K8s-native materialization — credentials become env vars/file mounts at runtime, never persisted in our DB
4. **The hard part** — allow-lists mean every new service-to-service call is *denied by default*. That's friction for every other team, and the reason this is a leadership story as much as a technical one.
5. **Result** — project isolation is enforced by the infrastructure rather than by convention; no plaintext credentials anywhere in the system.

### Follow-ups you might get

- *"Why SPIFFE rather than service accounts?"* → workload identity is cryptographically attested and rotates automatically; service-account tokens are bearer credentials that leak if exfiltrated.
- *"What happens if the sidecar fails?"* → know your answer (fail-closed vs fail-open) and say it plainly.
- *"How did you get 15 teams to adopt deny-by-default?"* → **this is the leadership question.** See Story 6 — it's the same material.
- *"How do you test that isolation actually holds?"* → integration suites that assert cross-project access is rejected.

### Honesty guardrail

Say "I designed and implemented" only where true; where it was a shared effort, say "I owned the design and drove adoption." Managers probe ownership claims hard on security work.

---

## Story 2 — Observability SDK adopted by 10+ services
### *Use for: influence without authority, driving adoption, developer empathy*

### Narrate this first (~40s)

> "We had 15 services across three languages, and every team was instrumenting differently — inconsistent log structure, different metric names, tracing wired up in some services and missing in others. Debugging anything cross-service meant stitching together incompatible telemetry.
>
> I built a Python SDK that packaged structured logging, Prometheus metrics, and OTLP tracing behind a couple of lines of setup, and got it adopted by 10+ internal services with zero breaking changes. The design constraint I held was that adoption had to be nearly free — if it cost a team more than a few minutes, they'd skip it, and a standard nobody adopts isn't a standard."

### Why it works

It's the **same shape as your Microsoft AutoDQ adoption story** — you can't mandate adoption, so you have to make the right thing the easy thing. Having the same pattern in two companies is evidence of a repeatable skill rather than a one-off.

### The beats

1. **Situation** — 15 services, polyglot, inconsistent telemetry
2. **Problem** — no cross-service debugging; each team re-solving the same thing badly
3. **Insight** — adoption is a UX problem, not a mandate problem. Zero breaking changes + minimal boilerplate was the requirement, not a nice-to-have
4. **Result** — 10+ services adopted; RED metrics auto-instrumented; the same custom metrics later became the input to autoscaling (Story 3)

### Follow-ups

- *"How did you get teams to adopt it?"* → made it cheaper than not adopting; zero breaking changes; shipped for the loudest pain first.
- *"What would you do differently?"* → have a real answer ready (e.g. versioning strategy, earlier design partner).

---

## Story 3 — Autoscaling on queue backlog, not CPU
### *Use for: technical judgement, optimization, "explain a decision and its trade-offs"*

### Narrate this first (~30s)

> "Our workers process long-running Temporal workloads, and the default autoscaling signal — CPU — was the wrong one. For queue-backed work, CPU is a lagging indicator: by the time utilization rises, the backlog has already built up, and when the queue drains CPU stays high while workers finish in-flight tasks. So scaling reacted late in both directions.
>
> I exposed Temporal queue depth as a custom Prometheus metric and drove HPA off that instead. Scaling became demand-driven rather than symptom-driven — sub-minute response between 1 and 5 replicas, and about a 60% reduction in idle time."

### Why this one matters for an infrastructure interviewer

This is **the most directly relevant story for a platform/compute team.** Queue-driven autoscaling is exactly the class of problem their scheduler solves. Lead with this if the conversation is technical rather than managerial.

### Follow-ups

- *"How do you stop it flapping?"* → stabilization windows, scale-down delay, hysteresis between thresholds.
- *"What about in-flight work on scale-down?"* → graceful shutdown; Temporal activity heartbeats mean an interrupted worker's task is retried, not lost.
- *"Why 1–5 replicas?"* → know the actual cost/latency reasoning.

---

## Story 4 — Greenfield platform design
### *Use for: ambiguity, ownership, "how do you start with a blank page"*

### Narrate this first (~35s)

> "AgentStudio was greenfield — no existing system, a fast-moving space, and requirements that changed as the market did. I owned the distributed backend design: how data gets in through connectors, how it becomes a knowledge base, how agents are configured and executed, and how all of it stays multi-tenant and isolated.
>
> The decision that shaped everything was treating agents as **configuration rather than deployments**. An agent is a record in the control plane — instructions, model binding, KB bindings, tool bindings — and a shared service materializes it lazily at invoke time. That means a thousand agents don't become a thousand pods; we scale replicas on request load, and a config change takes effect on the next request with no redeploy."

### Why it's good

It shows a **design decision with a clear rationale and a scaling consequence** — which is what "handling ambiguity" actually looks like at senior level. Not "I asked lots of questions," but "I made a call and here's why it was right."

### Follow-ups

- *"What's the trade-off?"* → bundle caches are per-replica, so each replica warms independently and holds its own MCP connections.
- *"What would you change?"* → have one honest answer.

---

## Story 5 — Durable orchestration at 10,000 workloads/day
### *Use for: scale, reliability, failure handling*

### Narrate this first (~35s)

> "We run around 10,000 long-running data and ML workloads a day across three Temporal task queues, at about 99.9% success. The reason it's Temporal rather than a queue-and-cron setup is that these workloads run for minutes to hours — a worker crash mid-ingestion can't mean starting over.
>
> The pattern is scatter-gather: a planner shards a document set into work units, workers process up to a couple of thousand in parallel with exponential-backoff retries and heartbeats, and a merge step assembles the result. Because activity state is durable, a crash replays from the last completed activity rather than the beginning."

### Follow-ups

- *"What's the 0.1%?"* → be honest: bad input data, upstream credential expiry, resource exhaustion.
- *"How do you make activities idempotent?"* → deterministic work-unit IDs, versioned output prefixes with an atomic metadata pointer flip.
- *"Why not Airflow/Kafka consumers?"* → Airflow is batch-scheduled and weak on long-running stateful retries; raw consumers make you build durability yourself.

---

## Story 6 — Conflict / disagreement  **FILL IN**

I can't write this one — it has to be a real memory. But here's the **most likely place it happened**, because the situation structurally creates conflict:

### Scaffold: deny-by-default security rollout

Enforcing per-service authorization allow-lists across 15 services means **every other team's service-to-service call breaks until it's explicitly permitted.** That always generates pushback — teams are blocked, they perceive security as bureaucracy, and someone senior asks for an exception.

Fill in these five beats from memory:

1. **Who disagreed, and what was their actual argument?** (Usually legitimate: "this is blocking my release.")
2. **What did you do first?** (Did you listen and understand the constraint before defending the design?)
3. **What did you concede?** (A story where you conceded nothing sounds rigid, not principled. Did you add a staged rollout, a permissive mode first, better tooling, self-service policy requests?)
4. **What did you hold firm on, and why?** (The non-negotiable — isolation can't have exceptions or it isn't a guarantee.)
5. **Outcome, and the relationship afterwards.** (Managers care that it ended well, not that you won.)

### Other candidate conflicts from your work

- Choosing the vector store / chunking strategy when someone preferred another option
- Pushing back on a feature that would have broken the isolation model
- Scope disagreement when the charter consolidated

**Delivery rule:** never make the other person look stupid. The best version is *"they were right about the cost, I was right about the constraint, and we found the sequencing that satisfied both."*

---

## Story 7 — A failure / something you got wrong  **FILL IN**

Managers ask this to test self-awareness. **Never answer with a disguised strength** ("I care too much"). Structure:

1. What you decided
2. Why it was wrong (own it without hedging)
3. How you discovered it
4. What you changed — *systemically*, not just "I was more careful"
5. What it cost

Candidate areas to search your memory for: an early design you had to reverse, an incident you caused or missed, something you shipped that didn't get adopted, an estimate you badly missed.

---

## Story 8 — Design rigour: the incremental re-ingest flaw

### ⚠️ Read this caveat first

This is a **real flaw in the codebase**, surfaced while analysing the ingestion pipeline. **Do not claim you discovered and fixed it in production unless you actually did.** Use it as a *technical discussion* answer — "here's a design weakness I'd address" — not as a leadership story with credit attached. If you raise it internally before the interview, it becomes legitimately yours.

### The content (safe to use as technical depth)

> "One design weakness I'd fix: incremental ingestion is append-only. When a source file changes, we re-chunk and re-embed the whole file and append the new vectors — but we never delete the old ones. And because document IDs are freshly minted UUIDs per run, the new copy can't overwrite or dedupe against the old one. So a single snapshot ends up holding two generations of the same document, retrieval returns both, and the citation dedup key can't merge them because the IDs genuinely differ — the user sees duplicate, conflicting sources.
>
> The fix is either delete-by-source before append, or content-hash document IDs so re-ingestion is an idempotent upsert. The second is better because it also makes golden retrieval test labels stable across rebuilds."

### Why this is valuable in an interview

It demonstrates the exact instinct an infrastructure team wants: **reasoning about idempotency, identity, and garbage collection.** Those are the same primitives behind dedup and GC in a blob store — which is this manager's home territory.

---

## Delivery rules for all NetApp stories

1. **Lead with the layer, not the domain.** "Platform infrastructure — scheduling, orchestration, multi-tenancy" lands better with an infra manager than "AI agent platform."
2. **One number per claim**, and only numbers you can defend: 15 services, 10,000 workloads/day, 2,000 parallel units, 10+ SDK adopters, 60% idle reduction.
3. **Narrate ~40 seconds, then stop.** Let them pull the detail. Over-explaining was the failure mode in the earlier round.
4. **Match the story to the question.** Story 3 for technical interviewers, Story 1 for "biggest achievement," Story 2 for influence.

---

## Consistency warnings (fix before interviewing)

1. **Tenure claim.** `behavioural-questions.md` says *"For the last two years I've been building AgentStudio,"* but the resume says **NetApp: March 2026 – Present** (~6 months) and that's what the Adobe manager was told. These contradict. Pick one and make it true everywhere.
2. **Resume dates.** Microsoft reads *"June 2022 - Present"* while NetApp reads *"March 2026 - Present"* — both can't be Present. Microsoft should be **June 2022 – March 2026**.
3. **Two competing "why leave" narratives exist.** `behavioural-questions.md` argues *rented intelligence / sovereignty-vs-data-flywheel*; `why-me.md` argues *org consolidation + feedback loop + first-party scale*. Both are defensible — **pick one primary** and keep the other as backup. Telling both in one conversation sounds like reason-shopping.
