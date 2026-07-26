# Experience Summary — AI-Driven Alerting & Data Quality (Microsoft)

Interview-ready reference for the data-platform / observability work: what the résumé
bullets mean, what was *actually* built, the core concepts, a rehearsed STAR story, and
the follow-up questions to expect. Everything here is framed to be **honest and defensible**
under deep technical questioning.

---

## 1. The résumé bullets

> **Alerting & telemetry:** Designed and implemented a high-scale AI-driven alerting and
> telemetry system that automatically integrated predefined, ML-informed alerts into
> published data assets, reducing manual monitoring setup effort by ~90% and improving
> anomaly detection accuracy across AI workloads.

> **Data quality:** Built an automated data quality service for large-scale AI/ML training
> datasets, enforcing schema, freshness, and distribution checks critical for downstream
> model reliability — achieving 95% adoption across multiple teams in the Commerce Cloud
> and AI organization.

---

## 2. Where the "AI" actually is (say this clearly)

There are **two different senses** of AI in these bullets. Being able to name the
difference is what makes you sound like you understand your own work:

- **Bullet 1 — AI is *in* the system.** Anomaly-detection models make the alerts "smart"
  (dynamic, learned thresholds instead of static numbers).
- **Bullet 2 — the system *serves* AI.** It's ML data infrastructure (data-centric AI /
  MLOps) that guarantees training-data reliability upstream of every model.

---

## 3. What I actually built (the honest technical core)

The detection logic was a **statistical anomaly-detection model**, not a deep-learning model:

1. Read pipeline run history from **Azure Log Analytics** using **KQL**.
2. Computed the **difference between consecutive runs** to build a per-pipeline history of
   "normal" behavior (cadence / volume deltas).
3. Fit a simple **Gaussian model per pipeline** — mean (μ) and standard deviation (σ) over
   a rolling window — and set a **dynamic threshold at μ + 1.5σ**. Runs outside that band
   were flagged as anomalies. Because μ and σ came from each pipeline's own history, the
   threshold was **dynamic and per-asset**, not hardcoded.
4. Made it **zero-touch**: when a data asset was published, monitoring was **auto-integrated
   from predefined templates**, so no team manually configured alerts. → this is the ~90%
   effort reduction.
5. Alerts routed into the incident/alerting flow so issues surfaced **before** downstream
   consumers silently consumed bad data.

**The problem this solved — "silent staleness" / "data downtime":** a pipeline stops
refreshing without hard-failing; the table still exists but with stale data; downstream
consumers (dashboards, ML training) keep reading it unaware. Freshness is the #1 pillar of
data observability (Freshness, Volume, Schema, Distribution, Lineage).

---

## 4. Core concepts — quick reference

**Statistical model** — a probabilistic description of how data behaves, with parameters
estimated from data. Three ingredients: (1) an assumption about the distribution,
(2) parameters, (3) fitting those parameters to data. μ + 1.5σ qualifies because it assumes
a normal distribution, has parameters (μ, σ), and estimates them from history.

**Gaussian (normal distribution)** — the "bell curve," fully defined by mean (μ, center) and
standard deviation (σ, spread).

**Empirical rule (68–95–99.7):**

| Range | % of values inside |
|---|---|
| μ ± 1σ | ~68% |
| μ ± 1.5σ | ~87% |
| μ ± 2σ | ~95% |
| μ ± 3σ | ~99.7% |

**Why 1.5σ** — a sensitivity dial. μ ± 1.5σ treats ~87% of runs as normal and flags the
~13% most extreme as anomalies. 1.5σ leans toward catching problems early (more sensitive,
a few more false positives); 2σ/3σ are more conservative.

**Is it ML?** Estimating μ and σ from data and flagging low-probability points is
legitimately **unsupervised Gaussian anomaly detection** (taught as an unsupervised ML
technique). It is *not* deep learning. Safe phrasings: "statistical anomaly detection,"
"dynamic statistical thresholding," "unsupervised Gaussian anomaly detection." The résumé's
"ML-informed" is fully justified. **Avoid** "trained a deep/custom ML model."

---

## 5. Rehearsed STAR story

### S — Situation
At Microsoft we published data assets that many downstream teams and AI/ML workloads relied
on. A recurring problem was **silent staleness**: a pipeline would stop refreshing without
failing, so the table still existed but with old data, and consumers kept reading it
unaware — causing bad dashboards and unreliable models. Manual monitoring didn't scale:
every pipeline had a different refresh cadence, and static thresholds either spammed false
alerts or missed real issues.

### T — Task
Automatically detect these anomalies across many published assets — without teams manually
configuring alerts, and with thresholds that adapt to each pipeline's own behavior.

### A — Action
- Pulled pipeline run history from **Azure Log Analytics** (KQL).
- Computed differences between consecutive runs to model each pipeline's "normal."
- Fit a **Gaussian model per pipeline** (μ, σ over a rolling window); alert threshold at
  **μ + 1.5σ** → dynamic, per-asset thresholds.
- Made monitoring **zero-touch** — auto-integrated from predefined templates on asset
  publish.
- Routed alerts into the incident flow so issues surfaced before consumers were affected.

### R — Result
- Cut manual monitoring setup effort by **~90%**.
- **Improved anomaly detection** vs static thresholds — fewer false positives, caught silent
  staleness earlier.
- Increased **reliability for downstream consumers and AI/ML workloads**.

### Spoken version (~75s)
> "At Microsoft, we published data assets that a lot of downstream teams and AI/ML workloads
> relied on. One recurring problem was what I'd call *silent staleness* — a pipeline would
> stop refreshing without actually failing, so the table still existed but with stale data,
> and consumers kept reading it without realizing. That led to bad dashboards and unreliable
> models.
>
> The challenge was scale: we had many pipelines, each with a different refresh cadence, so
> hardcoded thresholds didn't work — they either flooded us with false alerts or missed real
> issues.
>
> So I built a dynamic detection approach. I read pipeline run history from Azure Log
> Analytics with KQL, computed the differences between consecutive runs, and fit a simple
> statistical model per pipeline — the mean and standard deviation over a rolling window —
> and set the alert threshold at mean plus 1.5 sigma. Since the threshold came from each
> pipeline's own history, it adapted automatically per asset.
>
> Then I made it zero-touch: when a data asset was published, monitoring got auto-integrated
> from predefined templates, so no team had to set anything up manually. That automation cut
> monitoring setup effort by around 90%, and the adaptive thresholds meaningfully improved
> anomaly detection — we caught stale data before it silently reached consumers."

### 30-second version
> "At Microsoft I built automated anomaly detection for our published data assets. The main
> problem was silent staleness — pipelines that stopped refreshing without failing, so
> consumers unknowingly read stale data. I read pipeline run history from Log Analytics,
> computed a per-pipeline statistical baseline — mean plus 1.5 standard deviations over a
> rolling window — for dynamic thresholds, and auto-integrated the monitoring whenever an
> asset was published. That cut manual monitoring setup by about 90% and caught stale data
> before it reached downstream consumers."

---

## 6. Follow-up questions to expect

**"Why not just static thresholds?"**
At thousands of assets, static thresholds either flood you with false alerts or miss real
drift, and every metric has different seasonality. Learned per-asset baselines scale and cut
alert fatigue.

**"Why 1.5σ?"**
Sensitivity choice — leans toward catching problems early, accepting a few more false
positives. 2σ/3σ would be more conservative.

**"How would you improve it?"**
- **Robust statistics:** median + MAD instead of mean + std (a few anomalies inflate σ and
  mask future anomalies).
- **Seasonality:** flat μ/σ ignores weekday/weekend or hour-of-day patterns → group by time
  bucket or use seasonal decomposition.
- **Recency:** EWMA (exponentially weighted moving average) weights recent runs more.
- **Contamination:** trim/winsorize the training window so past incidents don't poison the
  baseline.
- **Next step up:** Kusto's built-in `series_decompose_anomalies()` (handles trend +
  seasonality automatically); SR-CNN via Azure Anomaly Detector for harder signals.

**"How did you get labels to train it?"**
Mostly **unsupervised** — we model *normal* behavior and flag deviations. Engineer feedback
on true/false alerts tuned sensitivity over time.

**"How is this different from a simple cron / job-success check?"**
A job can succeed but land empty or partial data ("refreshed but zero rows"). So we paired
**freshness with volume checks** — not just *did it update*, but *did it update with the
expected amount of data*. A cron check can't catch silent partial loads.

**"What was the ML part exactly?"**
Unsupervised Gaussian anomaly detection with dynamic per-pipeline thresholds. For harder
signals we evaluated/integrated more advanced detectors (Kusto anomaly functions, Azure
Anomaly Detector's SR-CNN).

---

## 7. Sample KQL (illustrative)

```kql
Telemetry
| make-series RunMetric = avg(metric_value) on Timestamp step 1h by PipelineId
| extend (anomalies, score, baseline) = series_decompose_anomalies(RunMetric, 1.5)
| mv-expand Timestamp, RunMetric, anomalies, score
| where anomalies == 1   // flagged deviation from learned baseline
```

Or the explicit μ + 1.5σ form:

```text
mu    = avg(delta) over rolling window per pipeline
sigma = stdev(delta) over rolling window per pipeline
alert if current_delta > mu + 1.5 * sigma   // dynamic, per-asset threshold
```

---

## 8. Honesty guardrails (keep these in mind)

- Call it a **statistical / Gaussian anomaly-detection model**, not a deep ML model.
- "ML-informed alerts" and "dynamic thresholds learned from data" are accurate.
- If you defined the scenarios and an ML team built more advanced detectors, say exactly
  that: "I owned the platform and problem definition — scenarios like silent staleness — and
  integrated detection into the publishing/alerting pipeline." That's true *and* impressive.
- Let the automation-at-scale story (~90% reduction, 95% adoption) carry the impact; let the
  anomaly detection support it — don't claim ML depth you can't defend.


---

## 9. Data Quality Service — DIME DQ v2.0 / AutoDQ (bullet 2)

DIME DQ v2.0 is a data-quality framework built on **Amazon Deequ**, running as **Spark
jobs** on Databricks/Synapse over **ADLS**. Its **AutoDQ** engine learns rules from a
dataset's own history instead of engineers hand-writing them. It's event-driven — a **WCE
(Work Completion Event)** triggers the pipeline.

Pipeline: `WCE → Metrics Collector → Suggester → Validator → Grafana`

- **Metrics Collector** — Spark job; profiles data (null count, min/max, std dev, distinct count).
- **Suggester (AutoDQ)** — reads ~last 100 runs; auto-generates rules via a custom
  **EmpiricalStrategy** (Z-score, mean ± k·σ) with a 5% tolerance buffer and a 5-run burn-in.
  Rule types: completeness, range, datatype, uniqueness, enum.
- **Validator** — runs auto + manual rules on new data; emits Compliance metrics.

### Worked example — `locationmappingsnapshot`

**1) Metrics (Metrics Collector)** — profile of `LocationId`:
- `ApproxCountDistinct = 230` — HyperLogLog estimate of distinct values.
- `DataType` histogram: Unknown 69.2% (~4.61M, mostly null) · String 30.8% (~2.05M)
  → ~6.67M rows, only ~31% populated.

**2) Rules (Suggester)** — auto-generated enum checks (allowed values learned from history):
- `allCloud ∈ {Public}`, `locationType ∈ {AzureRegion}`,
  `azureCloud ∈ {RX,EX,FF,PB,BF,DC,MC,BC}`
- All `checkLevel: Warning`, `priority: 3` (offline, non-blocking).
- `LocationId` gets **no** rule: 230 distinct (>10 → not enum), not unique (not a PK),
  mixed type (String+Unknown → datatype skipped).

**3) Results (Validator)** — Compliance per rule:
- Predicate form: `` `allCloud` IS NULL OR `allCloud` IN ('Public') ``
- All three = **1.0** → 100% compliant. Below 1.0 would signal enum/schema drift
  (an unexpected category entered the data).

**Takeaway:** profile → auto-generate rules → enforce → visualize — the data's own history
defines the rules that guard its future.


---

## 10. DIME DQ — Usage scenarios & failure handling

### Usage scenarios
1. **Manual DQ only** — publisher hand-writes rules (`rules.json`); the Validator runs only
   those. Use when the team knows its domain constraints and wants deterministic,
   hand-authored gates.
2. **AutoDQ + Manual DQ** — the Suggester auto-generates rules from history **and** manual
   rules run; the Validator merges both. This is the adoption driver: broad coverage cheaply
   **plus** control over the rules that matter.
3. **AutoDQ only (offline)** — only auto-suggested rules run (priority 3, non-blocking).
   Onboard a dataset with zero manual effort.

### Inline vs Offline
- **Inline DQ** — runs *during* pipeline execution; P0–P1 high-criticality checks; can
  **fail or warn** the pipeline based on severity. A hard quality gate.
- **Offline DQ** — runs *after* data lands; broader checks (completeness, anomalies, enum);
  **monitors without blocking**. Priority 3 by default.

### Priority mechanism
`P0` (highest) → `P3` (low). Inline runs priority ≤ 1; offline runs priority == 3.

### Failure handling (key design decisions)
- **Snooze inline DQ** — *problem:* inline DQ is a hard gate; if it fails for a run it keeps
  blocking the publisher on later runs. *Solution:* the publisher can **snooze** the inline
  check to publish despite the failure → converts a *blocking* failure into a
  **non-blocking, publisher-controlled** decision. Balances strict gates with agility.
- **Ignore bad metrics from the Suggester (baseline poisoning)** — *problem:* the Suggester
  learns from historical metrics; a faulty run's metrics poison the learned rules
  (garbage in → garbage rules). *Solution:* the publisher **marks bad runs** so the Suggester
  excludes those `resultKeys` when generating rules:

```bash
az dime config set --deployment-name '<deployment>' --file file.json
# file.json → "key": "@dataset-id.dq.offline.ignoreresultkeys", "value": [2024021919, 2024021923]
```

### Config via Azure CLI
`az dime config set` writes overrides to the config store: enable/disable AutoDQ, override
thresholds, modify rule priorities, deactivate rules, snooze inline checks.

---

## 11. DIME DQ — How AutoDQ generates rules (Suggester internals)

The Suggester (Scala, on top of Deequ) turns history into rules:

1. **Gather history** — connects to the Metrics Repository (JSON in ADLS), pulls the last
   ~100 successful runs, extracts per-column profiles (min, max, mean, distinct count) +
   total row count. Filters complex columns (nested structs, raw dates) and user-ignored ones.
2. **Per-column rule generation** — for each column, builds up to five rule types:
   - **Completeness** — historical completeness % → EmpiricalStrategy (Z-score) → "≥ X% complete".
   - **Range** — historical min/max → EmpiricalStrategy bounds **+ 5% tolerance** → "values in [Y, Z]".
   - **DataType** — if always one inferred type → "must be Integer/String…" (skips if mixed).
   - **Uniqueness** — if distinct/total == 1.0 historically → primary key → "100% unique".
   - **Enum** — if < 10 distinct string values → categorical → "must be in this list".
3. **Burn-in (`minimumRuns = 5`)** — won't emit completeness/range/anomaly rules until ≥5
   runs of history (cold-start guard).
4. **Output** — packages rules into `validationRules` JSON, writes to ADLS; the next run's
   Validator picks it up.

### EmpiricalStrategy (Z-score)
Given a metric's history \(x_1 \dots x_n\): compute mean \(\mu\) and std dev \(\sigma\), set
`bound = μ ± k·σ`. Same math as Z-score anomaly detection; used to derive completeness lower
bounds and numeric ranges. "Empirical" = derived from observed history. It's a **custom class
on top of Deequ**.

### EmpiricalStrategy vs Deequ's BatchNormalStrategy
Deequ's built-in **`BatchNormalStrategy(lowerDeviationFactor, upperDeviationFactor)`**
computes μ/σ in batch over history and flags values outside `μ ± k·σ` — same idea. Your
EmpiricalStrategy is essentially a **customized BatchNormalStrategy** that *emits rules*
(not just pass/fail), with the 5% tolerance and burn-in. (Deequ also has `OnlineNormalStrategy`
= running μ/σ, and `HoltWinters` = seasonal/trend.)

---

## 12. DIME DQ — Record-count anomaly detection

Per-column rules use EmpiricalStrategy on a column metric. **Record-count anomaly is
dataset-level**: it compares today's total row count to the historical baseline and flags
large changes. Two common implementations:
- **Relative rate-of-change** — flag if today's count deviates from the historical mean (or
  previous run) by more than X% (e.g., row count shouldn't halve or more than double).
- **Z-score on the Size series** — treat row count as its own metric, compute `μ ± k·σ` over
  recent runs, flag outside the band.

It differs from per-column rules because it operates on the **Size** metric at the dataset
level with a *change/relative* comparison. *(Confirm which variant your code uses.)*

---

## 13. DIME DQ — Adoption story (STAR → Amazon LPs)

- **S/T:** AutoDQ adoption was slow — teams hesitated to add it to their pipelines.
- **A:** Ran stakeholder meetings to find the blocker — the fat DIME jar collided with
  Synapse's dependency jars (**jar/version misalignment**). Proposed running **AutoDQ as a
  sidecar** to decouple it from the pipeline's dependency tree, and built a **Grafana adoption
  dashboard** to make uptake visible and drive accountability.
- **R:** Adoption reached **~95%** across teams.

**LP mapping:**
- **Customer Obsession** — prevents bad data reaching downstream consumers (dashboards, ML,
  APIs); proactive detection before customers notice; transparent Grafana reporting builds trust.
- **Insist on the Highest Standards** — standardized enterprise-grade DQ across ADF/Synapse/
  Databricks; automated statistical rule generation; inline gates enforce non-negotiable
  quality; self-adapting thresholds; governance (snooze/override/ignore) without impeding agility.

---

## 14. DIME DQ — Interview follow-ups
- **"Why Deequ?"** → Spark-native, scales to billions of rows via optimized aggregations,
  fits a JVM/Databricks stack; declarative checks + constraint suggestion + metrics repository.
- **"How does it scale?"** → checks compile to Spark aggregation jobs, run distributed on Databricks.
- **"Checks vs Analyzers?"** → Analyzers compute metrics; Checks assert constraints;
  VerificationSuite runs it and emits a report.
- **"How did you seed rules for many datasets?"** → AutoDQ constraint suggestion (auto-profiling) + burn-in.
- **"How do you avoid false positives?"** → 5% tolerance, burn-in, `checkLevel` Warning vs
  Error (soft vs hard gate), and ignore-bad-metrics.
- **"Freshness?"** → DIME's checks are completeness/uniqueness/range/enum/datatype/compliance/
  record-count-anomaly; map "freshness" to record-count anomaly / offline monitoring, or keep
  it for the bullet-1 alerting system (which genuinely did freshness/silent-staleness).


---

## 15. Goldman Sachs — Patch Management & DR (Oct 2021 – Jun 2022)

Analyst, Tier-1 investment-banking infrastructure. Stack: Java, Linux, Snowflake, Kubernetes.
Theme: reliability, fault tolerance, scale, compliance.

> **Honesty scope:** I did **not** build a distributed scheduler from scratch. I built
> **Kubernetes-based orchestration** (Jobs / a custom Operator) on top of an existing
> enterprise patch-management platform. **Kubernetes was the distributed scheduler**; my
> layer added controlled rollouts, retries, and idempotency. Don't claim "designed a
> scheduler" or Temporal for this role.

### Reworded bullets (honest + strong)
- Built **Kubernetes-based orchestration** (Jobs + a custom Operator) to automate
  large-scale patch rollouts across a **1M+ node fleet** on top of an enterprise
  patch-management platform *[confirm real tool: Ansible/AWX, BigFix, Satellite, or internal]*
  — with **staged/controlled rollouts, retries + backoff, and idempotent execution** via the
  operator reconcile pattern.
- Improved **rollout reliability to ~99.9%** and **reduced failed-patch incidents ~40%**
  through resilient distributed execution.
- Contributed to **disaster-recovery strategy** for Tier-1 apps (runbooks, failover
  automation, DR drills) — reduced downtime ~30%.
- Supported secure, compliant production via patching, release execution, and change management.

### What I actually built — K8s Operator + patch engine
- A `PatchRollout` **Custom Resource** describes a campaign (inventory, patch baseline, wave
  strategy, success threshold, max retries).
- The **operator reconcile loop** drives it wave by wave: launch → poll → gate on success
  rate → advance / halt (circuit breaker) / retry.
- The **execution engine** (e.g., Ansible/AWX via its job-template API, or a K8s Job running
  `ansible-playbook`) does the actual patching over SSH (`yum`/`apt` — idempotent).

Flow: `kubectl apply PatchRollout → operator → wave 1 (1%) → gate → wave 2 … → Grafana`

### How reliability improved (cause → effect)
- **Retries + backoff** → transient failures (unreachable node, temp lock, flaky call)
  auto-recover instead of counting as failures → raises success rate.
- **Idempotent execution** (reconcile loop + `state: latest`) → makes retries *safe* and lets
  partial failures resume cleanly.
- **Controlled rollout (canary → waves) + circuit breaker** → a bad patch hits ~1% of the
  fleet, not 100% → this is what cut failed-patch incidents ~40%.
- **Fault tolerance** → operator state in the CR/etcd resumes after a restart; K8s reschedules
  failed pods.
- **Measurement:** reliability = successful jobs / total (dashboard); incident counts before vs after.

### Where each claim comes from (defense)
- **Controlled rollout** → operator wave logic (+ Ansible `serial`).
- **Retries + backoff** → K8s Job `backoffLimit` / operator re-launch with backoff.
- **Idempotent execution** → reconcile loop **and** Ansible modules (`state: latest`).
- **Fault-tolerant** → operator state in etcd → resumes after restart; K8s reschedules failed pods.
- **Distributed** → Kubernetes is the distributed scheduler; the engine fans out over the fleet.

### DR concepts to know
RTO / RPO · active-active vs active-passive · hot/warm/cold standby · failover/failback ·
DR drills / game days · BCP. "30% downtime reduction" ≈ rehearsed runbooks + automated failover.

### Honesty guardrails
- Say **"Kubernetes orchestration on top of a patch platform,"** not "designed a distributed scheduler."
- **1M+ nodes** = the fleet scale, not a system you built for that capacity.
- Scope your role concretely ("I built the K8s automation piece"); avoid "Led" unless true.
- **Not Temporal** — this was Kubernetes. (Temporal is your NetApp work; use it only as an analogy.)
- Have the measurement story for 99.9% / 40% / 30% / 1M; flag any org-level numbers.

### Career through-line
The durable-execution patterns here — idempotent, retried, checkpointed — are the same ones
you later use with **Temporal** at NetApp: hand-rolled at Goldman, productized now.
