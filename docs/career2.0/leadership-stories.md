# Leadership & Impact Stories

Senior-narrative stories that show impact **beyond code** — investigation, architectural
judgment, and organizational follow-through. Narrate each with the **spoken script first**, then
expand into the beats, and go deep only if the interviewer probes.

---

## Story 1 — Driving AutoDQ adoption to ~95% (DIME DQ)

**Arc:** investigation → root-cause diagnosis → architectural fix → organizational follow-through.
**Signals it sends:** ownership, deep technical debugging (JVM/Spark), systems thinking, and
leadership (you built an accountability loop).

### 🎙️ Narrate this first (~40s)
> "Adoption of our AutoDQ module was stalled — teams weren't onboarding. I ran stakeholder
> meetings and traced the blocker to a **JAR dependency collision**: DIME's fat JAR was clashing
> with Synapse's native library versions in the JVM classloader. I proposed decoupling it with a
> **sidecar pattern** — DIME runs in its own isolated environment and reports results back via an
> API — which eliminated the dependency conflict. Then I built a **Grafana adoption dashboard** so
> uptake was visible across teams; that accountability loop is what drove us to **~95% adoption**."

### The beats (expand as needed)
1. **Symptom** — adoption stuck; teams hesitant to onboard.
2. **Investigation** — stakeholder meetings to find the *real* blocker instead of guessing.
3. **Root cause** — a fat-JAR dependency collision with Synapse's libraries.
4. **Fix** — the sidecar pattern to isolate DIME's dependency tree.
5. **Follow-through** — a Grafana dashboard → visibility → accountability → adoption.

---

### Deep dive (only if probed)

#### 1. The fat-JAR problem
- A **JAR** = packaged Java/Scala code + dependencies you submit to a Spark cluster.
- A **fat / uber JAR** = your code **plus all** its libraries bundled into one file.

```
Normal JAR:  your_code.jar   (just your code, ~50 KB)
Fat JAR:     dime_dq.jar     (code + deequ + spark + hadoop + …, ~200 MB)
```

- **The collision:** Synapse already has its own library versions on the cluster.

```
Synapse cluster has:  hadoop-3.2.jar, spark-3.1.jar, json-2.8.jar
DIME fat JAR brings:  hadoop-3.1.jar, spark-3.0.jar, json-2.9.jar
```

Two versions of the same class in one JVM → `NoSuchMethodError`, `ClassNotFoundException`, or
(worst) silent wrong results. This is **dependency hell / jar-version misalignment**. A *thin* JAR
would reuse the cluster's libraries; a *fat* JAR insists on its own copies → clash.

#### 2. The sidecar solution
A **sidecar** is a separate process that runs **alongside** the main one but is **decoupled** — its
own container, its own JVM, its own dependency tree — communicating via API / event / shared storage.

```
Without sidecar:                          With sidecar:
┌───────────────────────────────┐         ┌────────────────┐   ┌───────────────────┐
│ Synapse Pipeline              │         │ Synapse        │──►│ DIME DQ Sidecar   │
│ (code + DIME + deps) collide  │         │ Pipeline(code) │   │ (own env & deps)  │
└───────────────────────────────┘         └────────────────┘   └───────────────────┘
```

The pipeline no longer loads DIME's JARs → **zero shared classloader → zero collision.** Same
pattern Kubernetes uses for logging agents, Envoy proxies, and monitoring collectors.

#### 2b. Where does the sidecar run? (deployment options + the compliance tradeoff)
Once you decide to decouple DIME into a sidecar, the next question is **where it runs**. Three
options, each with a real tradeoff:

- **Option 1 — inside the existing Synapse cluster.** No new infra, but this is the original
  **fat-JAR collision** problem; only viable if you resolve the dependency clash (e.g., shading).
- **Option 2 — a separate cluster in the *customer's* resource group (RG):**

```
Customer's Azure Subscription
┌─────────────────────────────────────────┐
│  Customer RG                             │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │  Synapse     │  │  DIME DQ Cluster │ │
│  │  Pipeline    │  │  (you provision) │ │
│  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────┘
```
  - **Pros:** low latency; **data stays inside the customer's boundary.**
  - **Cons:** you need provisioning permissions in the customer's subscription; the customer pays
    for the extra cluster; you own its lifecycle (scaling, patching, teardown); every new resource
    triggers a security/compliance review; blast radius sits inside the customer's environment.

- **Option 3 — a managed container (Azure Container Instance / Function) in *your* subscription:**

```
Your Managed Subscription          Customer RG
┌─────────────────────┐           ┌──────────────────┐
│  DIME DQ Container  │◄──data────│  Synapse Pipeline│
│  (you control it)   │───result─►│                  │
└─────────────────────┘           └──────────────────┘
```
  - **Pros:** no footprint in the customer's RG; you fully control compute + lifecycle.
  - **Cons:** **data leaves the customer's boundary → compliance/privacy concerns.**

**Tradeoff at a glance:**

| Approach | Pros | Cons |
|---|---|---|
| Option 2 — separate cluster in customer RG | Low latency; data stays in customer boundary | Provisioning in customer RG; customer pays; lifecycle burden |
| Option 3 — your managed container | No customer-RG footprint; you control it | Data leaves customer boundary → compliance/privacy |

**The compliance catch (the senior insight):** for most enterprise customers — finance, healthcare,
government — **data cannot leave their subscription boundary.** That kills Option 3 and pushes you
back to Option 2, or to making Option 1 work inside the existing cluster. The technically cleanest
solution (managed container in your infra) hits a **compliance wall** — so the architecture is
driven by the *constraint*, not just elegance. That's exactly the kind of tradeoff real
architecture discussions turn on.

#### 2c. How the pipeline and DIME communicate (event-driven via Event Hub)
**What we used: Option B — event-driven via Azure Event Hub.** The two clusters never talk
directly; Event Hub is the broker.

```
Pipeline completes
   → writes data to ADLS
   → publishes "data ready" event to Event Hub (path, table, run ID)
   → DIME DQ cluster (subscribed) picks up the event
   → reads data from ADLS, runs Deequ checks
   → writes results to a results store (ADLS / SQL / Cosmos)
   → Grafana reads results → dashboard
```

**Why event-driven wins here:**
- Clusters never need each other's IP/endpoint — Event Hub decouples them.
- If DIME is down, **events queue up in Event Hub** — no data loss, pipeline not blocked.
- Fully **async** — the pipeline doesn't wait for DQ to finish.
- Adding more DQ consumers later = just another subscriber.

**Alternatives considered (know these for "why not X?"):**

| Option | How | Why not (vs B) |
|---|---|---|
| A — shared ADLS storage | both read/write a shared ADLS path | needs polling → higher latency / busy-wait |
| C — direct REST call | pipeline `POST /validate`, waits | tightest coupling; pipeline blocks and depends on DIME being up |

*(In practice A + B combine: the event carries the ADLS **path**, and DIME reads the actual data from ADLS.)*

**How to say it (~30s):**
> "The Synapse pipeline and DIME DQ cluster communicate via an event-driven pattern on Azure Event
> Hub. When a pipeline completes, it publishes a completion event with metadata — the ADLS path,
> table name, and run ID. DIME is subscribed, picks up the event, runs Deequ checks against the data
> in ADLS, and writes results to a store that Grafana reads. The clusters never talk directly —
> Event Hub is the broker — so if DIME is down, events queue up without losing data or blocking the
> pipeline."

**Follow-ups:**
- *"Same event processed twice?"* → Event Hub is **at-least-once**, so the DQ job is **idempotent** — re-running on the same data gives the same result, no duplicate alerts.
- *"How do you know if DIME failed?"* → a **dead-letter** topic for events that fail after retries, monitored separately.
- *"Latency?"* → Event Hub delivery is sub-second; DQ latency depends on dataset size + Spark startup (Synapse cold start can be 2–5 min).
- *"Event Hub vs Service Bus?"* → Event Hub = high-throughput streaming (millions/sec, retention); Service Bus = transactional/command messaging. Pipeline-completion events at scale → Event Hub.

#### 3. The Grafana adoption dashboard
Fixing the technical blocker isn't enough — you still need teams to onboard, and without visibility
adoption is invisible and no one feels accountable.

```
Makes adoption quantifiable:
- Which teams have onboarded DIME DQ?
- Which pipelines have DQ checks configured?
- What % of assets are covered?
- Trend over time — is adoption growing?
```

Visibility to leadership changes behavior: a team visibly behind at 20% coverage gets asked why →
prioritizes it. You turned a soft adoption problem into a **self-correcting feedback loop.**

#### 4. Overcoming adoption resistance (the change-management play)
**First, frame the resistance as legitimate** — engineers protecting their systems, not ignorance:
- inline DQ adds code to *their* pipeline → "what if it crashes?"
- another Deequ dependency → "remember the JAR collision?"
- sampling adds latency → "our SLA is already tight"
- if DQ fails, does *my* pipeline fail? → "I own uptime, not you"
- who defines 'good data'? → "you don't know our data"

**Lever 1 — Shadow mode (make it safe to try).** DQ runs alongside the pipeline but **logs only,
never blocks**. Teams see what *would* have failed, at zero risk.
> "We introduced a shadow mode — checks ran alongside the pipeline but never blocked it, so teams
> could see what would have failed without risking their pipelines before committing to enforcement."

**Lever 2 — Benchmarks (kill FUD with data).** Measure, don't argue:
```
Pipeline without DQ:     4m 32s
+ DQ (10% sample):       4m 41s   ← ~9s (<5%) overhead
+ DQ (100% scan):        6m 10s   ← too slow → offline only
```
> "We benchmarked representative pipelines and showed 10% sampling added under 5% overhead for 95%
> of pipelines; for SLA-tight ones we offered offline-only DQ with zero inline overhead."

**Lever 3 — Tiered adoption ramp (no all-or-nothing).**
```
Stage 1: Offline only        → zero pipeline risk, just Grafana monitoring → builds trust
Stage 2: Inline shadow mode  → checks run, never block → validate rules on their data
Stage 3: Enforce P0 only     → block on null-PK / schema; the rest still shadow
Stage 4: Full enforcement    → team owns their DQ rules
```
> "We gave teams a ramp — offline monitoring, then optional shadow mode, then enforcement — so they
> chose their own pace, which removed the all-or-nothing resistance."

**Accountability via Grafana** (builds on #3): adoption rates shown in engineering reviews shifted
the conversation from "we'll get to it" to "why are we behind." Social accountability drove more
adoption than any technical argument.

**The hardest objection — "who defines good data?"** AutoDQ's EmpiricalStrategy learns rules from
**each team's own** history (their schema, distributions, null rates). Reframe: *"these are your
rules, derived from your data"* — not imposed standards. That dissolved the "you don't understand
our data" pushback.

**Full interview answer (~60s):**
> "The resistance was legitimate — teams had been burned by dependency issues before, and inline DQ
> touching their pipelines was a real risk to their uptime. We handled it three ways. First, **shadow
> mode** — DQ ran alongside pipelines but never blocked them, so teams could validate the system
> wasn't going to break anything before committing. Second, **benchmarks** — we showed 10% sampling
> added under 5% overhead for most pipelines, and offered offline-only DQ for SLA-sensitive ones.
> Third, a **tiered adoption path** — offline monitoring → shadow mode → enforcement — so teams
> controlled the pace. The **Grafana adoption dashboard** made inaction visible in engineering
> reviews, which drove accountability without us pushing. And because AutoDQ learned rules from each
> team's own data, we could honestly say 'these are your rules, not ours' — which removed the 'you
> don't understand our data' objection. We went from near-zero voluntary adoption to ~95% coverage."

**Follow-up cheat sheet:**

| Follow-up | Answer |
|---|---|
| "Shadow mode showed too many false positives?" | "That's the point — teams tuned rules in shadow *before* enforcement; false positives there are free learning, not incidents." |
| "A team refused entirely?" | "Offline DQ needs zero pipeline changes — we monitored their quality anyway; Grafana visibility did the rest." |
| "Rule disagreements?" | "AutoDQ proposed, teams reviewed and approved — we were the platform, not the authority on their data." |
| "Hardest team to convince?" | Give a specific case (tight SLA / complex data) resolved by shadow mode + benchmarks. |

---

### The full picture (quick reference)

| Step | What it was | Why it mattered |
|---|---|---|
| Stakeholder meetings | Root-cause investigation | Found the real blocker vs. guessing |
| Diagnosed fat-JAR collision | Deep technical debugging | Required JVM classloading + Spark dependency knowledge |
| Proposed sidecar | Architectural solution | Decoupled DIME from the pipeline's dependency tree |
| Built Grafana dashboard | Adoption visibility | Turned a soft problem into a measurable metric with accountability |

### Follow-ups you might get
- *"How does a sidecar talk to the pipeline?"* → API/HTTP call, event, or shared storage — no shared classloader.
- *"Why not just shade/relocate the JAR?"* → Shading (renaming conflicting packages via the Maven Shade plugin) is a valid alternative; the sidecar was chosen because it **fully decouples environment + lifecycle** and matches how the rest of the platform runs. (Acknowledging the alternative shows depth.)
- *"How did you measure ~95% adoption?"* → the dashboard: onboarded teams / total, % of assets covered, and the trend over time.

### Honesty guardrails
- This was primarily **your** investigation + proposal; note where the team helped implement.
- Have the **measurement basis** for ~95% ready (straight from the dashboard).

---

## DIME DQ — Inline vs Offline Architecture (deep dive)

The core tension: inline and offline have **fundamentally different architectural constraints**.
*(This is the resolution of the "does it run in the same Spark context?" question.)*

```
Inline DQ:   runs DURING the pipeline, can BLOCK it   →  "don't write bad data"      (P0–P1)
Offline DQ:  runs AFTER the pipeline, only MONITORS   →  "alert if bad data landed"  (P3)
```

### Inline DQ — must run in the same Spark context
Inline validates the **in-memory DataFrame before it's written**. If DQ fails → the pipeline throws
→ data never lands in ADLS. You can't ship an in-memory DataFrame to another cluster over Event Hub.

```
Pipeline Spark Job
┌────────────────────────────────────────────┐
│  read source → transform / enrich           │
│       │                                      │
│       ▼                                      │
│  ┌─────────────────┐                         │
│  │  DIME DQ        │  ← runs HERE, inside     │
│  │  (Deequ checks) │    the same Spark ctx    │
│  └─────────────────┘                         │
│       ├── PASS → write to ADLS               │
│       └── FAIL → throw exception, stop       │
└────────────────────────────────────────────┘
```

**The JAR collision hits hardest here** (DIME must be in the same JVM). Three ways to solve it:
- **Thin JAR + provided deps** — don't bundle Spark/Hadoop; use the cluster's. Lightweight, but DIME
  must compile against the exact versions Synapse runs.
- **JAR shading (relocation)** — rename DIME's conflicting packages so both versions coexist:
  `com.fasterxml.jackson… → com.dime.shaded.jackson…`. **Cleanest for inline — no sidecar, no separate cluster.**
- **Separate JVM on the same node (inline sidecar)** — serialize the DataFrame (Arrow/Parquet) over
  IPC to a DIME JVM on the same node. Works, but adds serialization overhead / latency.

### Offline DQ — fully decoupled
Data is already in ADLS, so there's no in-memory DataFrame to pass; it runs async and never blocks.
**This is where the sidecar + Event Hub pattern fits** (see 2b/2c):

```
Pipeline completes → writes ADLS → publishes event → [Event Hub] → DIME cluster picks up
   → reads ADLS → runs deeper Deequ checks → writes results → Grafana (+ P3 alert)
```

### The combined picture
```
Pipeline Spark Job:  ingest → transform → [INLINE DQ] → PASS: write ADLS / FAIL: throw
                                                │ completion event
                                                ▼
                                            Event Hub
                                                ▼
DIME DQ Cluster (offline):  reads ADLS → deeper checks (distribution, referential integrity,
                            drift, completeness) → results → Grafana → P3 alert
```

### What each layer checks
| Check | Inline (P0–P1) | Offline (P3) |
|---|---|---|
| Null checks | Yes — block bad data | Yes — monitor trend |
| Schema validation | Yes — hard stop | Yes — drift detection |
| Row count | Yes — zero rows = fail | Yes — historical comparison |
| Enum / value validity | Yes | Yes |
| Statistical distribution | No — too expensive inline | Yes — vs baseline |
| Referential integrity | No — needs full dataset | Yes |
| Freshness | Yes — simple timestamp | Yes — deeper staleness |
| Cross-table consistency | No | Yes |

### Key design principle
- **Inline:** fast, cheap checks that protect downstream *immediately*; runs *in* the pipeline Spark
  context; JAR collision solved via **shading or thin JAR**.
- **Offline:** deep, expensive checks that monitor health *over time*; runs in a *separate* cluster
  via Event Hub; JAR collision is **irrelevant** (fully isolated environment).

### How to say it (~40s)
> "Inline and offline DQ have fundamentally different constraints. Inline must run inside the
> pipeline's Spark context because it validates in-memory DataFrames before they're written — if it
> fails, the pipeline throws and no bad data lands. We solved the JAR collision for inline with
> **JAR shading** — relocating DIME's conflicting packages so both versions coexist in one JVM.
> Offline is fully decoupled — the pipeline publishes a completion event to Event Hub, and the DIME
> cluster picks it up, reads the already-written data from ADLS, and runs deeper statistical checks
> that would be too expensive inline. The sidecar pattern only applies to offline — inline has to be
> in the same process by definition."

---

## DIME DQ — Scaling (data / pipeline / compute)

A "how does it scale?" question is really asking three things: **data scale, pipeline scale,
compute scale.** Answer all three.

### 1. Data scale — huge datasets
- **Sampling for inline** — don't scan 10B rows; a **10% statistical sample** catches schema/null/
  enum issues with high confidence without blocking. Deequ supports it: `.onData(df.sample(0.1))`.
  Full scans run offline.
- **Columnar pruning** — Parquet on ADLS is columnar, so load only the columns being validated.
- **Partition-aware checks** — Commerce data is partitioned by date/region; validate today's
  partition instead of a full-table rescan.

### 2. Pipeline scale — thousands of pipelines
- **Zero-touch AutoDQ** — a new pipeline auto-attaches monitoring; EmpiricalStrategy learns rules
  from the first N runs. No per-pipeline config. *(This is what you built — the direct answer.)*
- **Event Hub partitioning** — thousands of completion events fan out across partitions; consumers
  scale out to match throughput.
- **Results store scales** — Cosmos DB (low-latency per-pipeline lookup) / ADLS + Delta (history);
  Grafana reads aggregated views, not raw records.

### 3. Compute scale — bursty jobs
- **Autoscale** (Databricks/Synapse) — min nodes for steady state, burst for nightly batch
  completions, scale down after idle.
- **Event Hub as a shock absorber** — a burst of 500 events queues up (24h retention) and the
  cluster drains at its own pace → no overwhelm, no data loss. *(The key insight.)*
- **Priority queuing** — P0/P1 critical pipelines → high-priority topic processed first; P3 → low.

### Commerce Cloud angle (regional + compliance)
```
Region: US                          Region: EU
┌─────────────────────┐            ┌─────────────────────┐
│ Synapse Pipelines   │            │ Synapse Pipelines   │
│  → Event Hub (US)   │            │  → Event Hub (EU)   │
│  → DIME DQ (US)     │            │  → DIME DQ (EU)     │
│  → Results (US)     │            │  → Results (EU)     │
└──────────┬──────────┘            └──────────┬──────────┘
           └───────────────┬──────────────────┘
                           ▼
                 Central Grafana (aggregated metrics only — no raw data crosses regions)
```
Each region has its own Event Hub + DIME cluster, so transaction data **never crosses region
boundaries** (GDPR/SOX); only aggregated DQ metrics (pass rate, check counts) roll up centrally.

### Full interview answer (~45s)
> "Scaling hits three dimensions. For **data scale**, we sample for inline DQ — a 10% sample catches
> most issues without blocking — and push full scans offline. For **pipeline scale**, zero-touch
> AutoDQ means new pipelines get DQ configured automatically, and Event Hub handles the fan-out —
> thousands of completion events queue naturally and the DIME cluster drains them at its own pace.
> For **compute scale**, the cluster autoscales on Databricks, with Event Hub absorbing nightly
> bursts so it's never overwhelmed. In Commerce Cloud specifically, we deploy regionally — each
> region has its own Event Hub and DIME cluster so transaction data never crosses region boundaries,
> and only aggregated metrics flow to a central dashboard."

### Cheat sheet
| Question | Answer |
|---|---|
| "Huge datasets?" | Sampling inline, full scan offline, columnar pruning, partition-aware |
| "1000s of pipelines?" | Zero-touch AutoDQ, Event Hub partitioning, autoscale consumers |
| "Burst traffic?" | Event Hub as shock absorber, Databricks autoscale, priority queuing |
| "Multiple regions?" | Regional Event Hub + DIME clusters; only metrics cross regions |
| "Cost?" | Autoscale down when idle, sampling cuts compute, offline runs off-peak |

### Honesty guardrail
Separate **what you built** (sampling, zero-touch AutoDQ, Event Hub fan-out, inline/offline split)
from **how you'd scale it further** (regional multi-namespace, Cosmos DB, autoscale tuning, priority
topics). For "how would you scale?" it's fine to reason about design — just phrase it as *"we did X;
I'd extend with Y"* rather than implying all of it shipped.

---

## DIME DQ — AutoDQ Rule Learning & the AI/ML Angle

This is where you can **legitimately claim AI/ML** in AutoDQ without overselling: it's
**unsupervised rule induction** — learning DQ constraints from historical data instead of humans
hand-writing them.

> **⚠️ Deequ reality check (verified against the Deequ source):**
> - Deequ's **constraint suggestion uses named `ConstraintRule`s, not "strategies":**
>   `CompleteIfCompleteRule`, `RetainCompletenessRule` (with a `WilsonScoreIntervalStrategy`),
>   `RetainTypeRule`, `CategoricalRangeRule`, `FractionalCategoricalRangeRule`,
>   `NonNegativeNumbersRule`, `UniqueIfApproximatelyUniqueRule`.
> - **`EmpiricalStrategy` / `MeanStrategy` are NOT Deequ classes** — they're your team's **custom
>   abstractions** in the DIME Suggester, which was built *on top of* Deequ. (Deequ's multiple
>   *Strategies* — `OnlineNormalStrategy`, `BatchNormalStrategy`, `HoltWinters` — live in the
>   separate **anomaly-detection** module, not in constraint suggestion.)
> - So say: *"we built a **custom Suggester on top of Deequ** with our own statistical
>   (z-score / mean±σ) rule-learning, and added a **numeric range rule Deequ doesn't provide by
>   default**."* Accurate, and it shows you *extended* the framework.

**DIME → Deequ mapping:**

| DIME rule | Deequ equivalent |
|---|---|
| Completeness | `RetainCompletenessRule` (+ interval strategy) |
| DataType | `RetainTypeRule` |
| Uniqueness | `UniqueIfApproximatelyUniqueRule` |
| Enum | `CategoricalRangeRule` / `FractionalCategoricalRangeRule` |
| **Range (min/max + 5% tolerance)** | **custom — not in Deequ's defaults** |

> **Ownership (don't undersell yourself):** the z-score / mean±σ logic is **standard statistics you
> implemented** in the Suggester — *own it.* Do **not** attribute basic z-score models to "an ML
> team": it's a few lines of stats, and it both undersells you and contradicts your ownership of the
> DQ module. Reserve *"partnered with a DS/ML team"* for genuinely advanced detection (SR-CNN,
> seasonal/Holt-Winters, trained models) — and only if it actually happened, framed as *"I defined
> the scenarios and integrated their output."*

### The learning strategy — EmpiricalStrategy (z-score / mean±σ)
AutoDQ uses a **single custom strategy**, `EmpiricalStrategy` (built on top of Deequ), that induces
rules from each column's history using **statistical (z-score / mean±σ) bounds** — the same Gaussian
idea as the alerting system, applied to data values. Per column it derives:

- **Completeness** — from the historical null-rate → lower bound (μ − k·σ) → "≥ X% complete".
- **Range (numeric)** — from historical min/max → statistical bounds **+ a 5% tolerance buffer** → "values in [Y, Z]".
- **Enum (categorical)** — if historically < ~10 distinct values → learned allowed set.
- **DataType** — if the inferred type was consistent → a type constraint.
- **Uniqueness** — if distinct/total ≈ 1.0 → primary-key uniqueness.

> "EmpiricalStrategy observes each column's historical distribution and induces constraints using
> z-score / mean±σ bounds — completeness thresholds, numeric ranges with a tolerance buffer, plus
> enum, type, and uniqueness checks. It's unsupervised rule learning — the same Gaussian foundation
> I used in the alerting system, applied to data values instead of pipeline run intervals."

*(One strategy — don't split it into a separate "MeanStrategy" unless that class actually existed in
your code. The μ ± k·σ math lives **inside** EmpiricalStrategy.)*

### Column-type intelligence (where the "smart" lives)
AutoDQ selects the strategy per column rather than blindly applying one:
- **Continuous numeric** (price, amount) → Gaussian bounds (μ ± k·σ)
- **Discrete numeric** (counts) → observed range
- **Categorical** (status, region) → learned enum set
- **Boolean / flag** → seen values only
- **High-cardinality key** (id) → uniqueness + completeness only (no value-range rule)

> "AutoDQ picks the right strategy per column based on type and cardinality — continuous numerics
> get Gaussian bounds, categoricals get empirical enum validation, high-cardinality keys get
> uniqueness checks — assembling the right rule set per column without human input."

### Suggester → (human review) → Validator
```
Raw data (ADLS) → Suggester (learn candidate rules) → [team reviews/approves] → Validator (enforce)
```
> "The Suggester is an AI assistant for data-contract definition — it *proposes* rules, humans
> *validate* domain correctness, the Validator *enforces*. As data shifts over months, the Suggester
> refreshes bounds automatically."

### The through-line to your alerting system
```
Alerting:  μ + 1.5σ on run intervals   ─┐  same Gaussian model,
AutoDQ:    μ ± k·σ  on column values    ─┘  unsupervised, learned from history, no labels
```
> "Same statistical foundation across both systems — Gaussian modeling, parameters learned from
> history, flagging low-probability observations. In alerting it's applied to pipeline behavior; in
> AutoDQ to data values. That consistency was intentional."

### "Is this really AI?" — the honest answer
> "It's **unsupervised statistical learning** — rule induction from data without labels, same family
> as anomaly detection. I won't call it deep learning — it's statistical ML, and that's exactly what
> fits the problem."

### Follow-up cheat sheet
| Question | Answer |
|---|---|
| "Is this really AI?" | "Unsupervised statistical learning — rule induction without labels; same family as anomaly detection." |
| "What if the historical data is dirty?" | "Bootstrapping — first N runs are observed without enforcement; manual seed option for critical columns where the team knows ground truth." |
| "How do rules update over time?" | "Suggester runs on a sliding window; if the distribution shifts (seasonal, new markets), bounds refresh automatically." |
| "What's k in the Gaussian bound?" | "Configurable per column; default ~2 (≈95%); critical columns like transaction amounts used 3σ to cut false positives." |
| "vs Great Expectations?" | "Same concept — GE is test-driven (you *write* expectations); AutoDQ *learns* them. Trade-off: flexibility vs automation." |

---

## Microsoft Commerce Cloud — Opening Pitch & Adoption Story (narration)

> **⚠️ Verify before using:** (1) **Area 2** is corrected to a single `EmpiricalStrategy` (z-score) —
> don't say "MeanStrategy" (not a confirmed class). (2) **Area 3** — your real JAR-collision fix was
> the **sidecar** (per your notes); "shading" is the *inline* alternative — claim what you did.
> (3) The adoption story frames non-blocking onboarding as **offline DQ + snooze** (your real
> features); if a distinct **"shadow mode"** actually existed, use that word. (4) Confirm the
> **~30% → ~95% / one-quarter** figures, or soften to "low adoption → ~95%."

### Opening frame (say this first)
> "At Microsoft Commerce Cloud I worked on two interconnected observability problems — pipeline
> health and data quality. Commerce Cloud processes transaction, catalog, pricing, and inventory
> data for Microsoft's commercial business globally, so bad or stale data has real downstream
> consequences on dashboards, ML training, and business decisions.
>
> I built two systems. First, a **dynamic alerting system** for pipeline health — detecting when
> pipelines silently stop refreshing without hard-failing. Second, I was a **core contributor to
> DIME DQ** — an automated data-quality platform built on Amazon Deequ, running as Spark jobs on
> Databricks and Synapse — which validates the data those pipelines produce.
>
> They're complementary: **alerting catches when pipelines run; DIME catches what they produce.**"

### Land the impact
> "Together these reduced manual monitoring effort by ~90% and reached ~95% DQ adoption across
> teams — neither happened automatically. The adoption story is the one I'm proud of, because it
> took both technical and organizational work."

### Area 1 — Dynamic alerting & telemetry
> "I owned the detection platform for pipeline health. I identified **silent staleness** as the core
> failure mode, defined the anomaly scenarios, and built the statistical detection layer:
> **per-pipeline Gaussian baselines** from consecutive-run deltas, a **dynamic threshold at μ+1.5σ**,
> queried via **KQL** against **Azure Log Analytics**. **Zero-touch** — monitoring auto-attaches on
> asset publish from predefined templates. ~90% less manual setup."

Terms to drop: Gaussian baseline, dynamic threshold, KQL, Azure Log Analytics, zero-touch, silent staleness.

### Area 2 — Data quality (DIME AutoDQ)  *(corrected: single strategy)*
> "On DIME I worked on the **AutoDQ** engine — the rule-learning layer. It uses a custom
> **`EmpiricalStrategy`** (built on Deequ) to learn constraints from each column's history using
> **z-score / mean±σ bounds** — completeness thresholds, numeric ranges with a tolerance buffer,
> enum sets, plus type and uniqueness checks. It picks the right constraint per column type, and the
> output is a suggested rule set teams review before enforcement. It's unsupervised rule learning."

Terms: AutoDQ, EmpiricalStrategy, Deequ, unsupervised rule learning, inline vs offline DQ.

### Area 3 — Architecture & integration  *(corrected: sidecar is the real fix)*
> "I also worked on the **inline vs offline DQ split** and the **Event Hub** communication between
> Synapse pipelines and the DIME cluster. **Inline** runs inside the pipeline's Spark context for
> blocking checks. **Offline** runs in a **separate cluster** triggered by pipeline-completion events
> via Event Hub — fully async, zero pipeline impact. We resolved the fat-JAR/dependency collision by
> decoupling DIME as a **sidecar** (isolated environment); *for inline mode the fix is JAR shading.*"

### The adoption story (situation → problem → tried → failed → worked → outcome)
> "DIME was technically solid — rule learning worked, checks were accurate, architecture was clean.
> But months after launch, adoption was stuck (~30%). Teams weren't onboarding.
>
> I ran stakeholder meetings. The message was consistent: engineers didn't trust that inline DQ
> wouldn't break their pipelines — they'd seen the JAR-collision issue, they had SLA commitments, and
> they felt DQ rules were being imposed by a platform team that didn't understand their data.
>
> My first instinct was to make the technical case — benchmarks, architecture. It didn't move the
> needle. So I changed approach, three ways.
>
> First, **make it safe to try**: teams could start with **offline DQ** — checks run alongside the
> pipeline but never block it, results logged and shown in Grafana — so they saw what would fail with
> zero risk. (And **snooze** let a publisher get past a failing inline check without being stuck.)
>
> Second, I **reframed the rules question**. The pushback was 'you don't know our data.' The honest
> answer: AutoDQ doesn't either — it *learns* it, from their own historical data. 'These are your
> rules, learned from your data — you just review and approve them' changed the conversation.
>
> Third, I built the **Grafana adoption dashboard** — coverage per team, trend over time — visible in
> engineering reviews. Within a couple of sprints, teams stuck at 0% were asking how to onboard — not
> because I pushed, but because their manager asked why they were the only red bar.
>
> We went from ~30% to ~95% adoption over the following quarter. The **technical** fix was
> non-blocking onboarding; the **organizational** fix was visibility."

### Why this story works
| They're evaluating | The story shows |
|---|---|
| Technical depth | You understood *why* resistance was rational (JAR history, SLA risk) |
| Communication | You stopped pushing technical arguments when they weren't working |
| Influence without authority | You drove adoption across teams you didn't own |
| Product thinking | Non-blocking onboarding = reduce risk to zero to lower the barrier |
| Organizational savvy | The dashboard made inaction visible; accountability did the work |
| Self-awareness | You tried something, it failed, you changed approach |

### Follow-ups
- **"What would you do differently?"** → "Ship non-blocking onboarding from day one as the standard path — start monitoring, graduate to enforcement — instead of launching with enforcement and walking it back."
- **"Teams that still refused?"** → "Offline DQ needs zero pipeline changes — we monitored their quality anyway; Grafana visibility did the rest. Once teams saw their scores, they wanted inline too."
- **"Hardest team?"** → "Tightest-SLA transaction pipelines — we offered offline-only permanently; they became our reference customers for the offline pattern."
- **"How did you measure success?"** → "Coverage % in Grafana **and** false-positive rate — high FPs make teams disable checks, so keeping FPs low mattered as much as coverage."

### One-liner (when time is short)
> "DIME was technically ready but adoption was stuck ~30%. I made onboarding non-blocking to remove
> pipeline risk, reframed AutoDQ rules as 'your data's own rules, not ours,' and built a Grafana
> adoption dashboard that made inaction visible in engineering reviews. ~95% in a quarter."

---

*Add more stories below as you develop them (e.g., a cross-team migration, an incident you led,
a mentoring/scope-expansion story) — same format: spoken script → beats → deep dive → guardrails.*
