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
