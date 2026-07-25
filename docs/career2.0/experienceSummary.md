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
