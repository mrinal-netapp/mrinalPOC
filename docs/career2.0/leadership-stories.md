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

*Add more stories below as you develop them (e.g., a cross-team migration, an incident you led,
a mentoring/scope-expansion story) — same format: spoken script → beats → deep dive → guardrails.*
