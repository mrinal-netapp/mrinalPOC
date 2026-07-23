# Helm values convergence strategy

Source of truth for how AgentStudio's per-tier Helm `values*.yaml` files are
organized across clouds, and how we prevent per-cloud configuration drift from
reaching a cluster.

## Problem statement

AgentStudio ships a set of per-tier umbrella charts under
`deployments/helm/<tier>/`. Each tier has a base `values.yaml` plus a forked
overlay per environment:

```
deployments/helm/services/
  values.yaml          # base
  values-local.yaml    # KIND / Docker Desktop / k3d / minikube
  values-aks.yaml      # Azure
  values-gke.yaml      # GCP
  values-eks.yaml      # AWS
```

At deploy time `helm_upgrade_tier` (`mk/tier-helm.mk`) composes them:

```
helm upgrade --install <release> <chart> \
  -f values.yaml \
  -f values-<cloud>.yaml   # only if the file exists
  <tier-set --set flags> <tier extras> <HELM_EXTRA_ARGS>
```

This fork-per-cloud layout produces two recurring failures:

1. **Dropped cloud value.** A developer adds a value while testing with
   `values-local.yaml`, mirrors it to one or two cloud overlays, and forgets the
   rest. Nothing flags the omission until the missing-value cluster misbehaves.
2. **Works local, breaks in cloud.** A change is E2E-tested on local, but the
   local overlay does not exercise the cloud-only code paths (different secret
   names, storage classes, workload identity), so the regression only surfaces
   after a cloud deploy.

### Evidence in the current tree

The `services` tier shows the drift concretely:

- `metrics.serviceMonitor.enabled: true` is set per-service in
  `values-local.yaml` **and** `values-aks.yaml`, but is **absent** from
  `values-gke.yaml` and `values-eks.yaml`. No one can tell from the files
  whether that is intentional or a bug — this is failure mode #1.
- `config-service.env` diverges by cloud: AKS uses the
  `keycloak-bootstrap-admin-from-kv` secret, GKE/EKS use
  `keycloak-bootstrap-admin`, and local omits the override entirely — so local
  E2E never exercises that path. This is failure mode #2.

At the outset there was **no `values.schema.json`** anywhere in the tree, and the
PR pipeline (`.github/workflows/main.yml`) performed **no Helm rendering or
validation** — the overlays were first exercised at deploy time against a live
cluster. Both gaps have since been addressed (schemas for the high-risk tiers,
plus a `helm-validate` CI job that fails red on drift, though not yet a required
check); see the rollout plan below for current status.

## Goals

- A change that should apply everywhere lands in **one** place.
- A genuinely per-cloud value that is missing on a cloud is caught **before**
  it reaches a cluster (ideally at PR time).
- The day-to-day developer workflow stays simple and Helm-native.
- The approach works for **vendored third-party subcharts** (lakekeeper,
  bifrost, temporal, redis) whose templates we do not own.
- Reuse existing tooling and conventions where possible
  (`make verify-env-propagation`, `make lint-makefile`,
  `helm-tier-template-<cloud>`, `deploy-reusable.yml`).

## Approaches considered

Four approaches were evaluated. **Approach C is the implemented one** and is
detailed in the rest of this document. The other three were rejected; their full
write-ups (pros/cons/verdict) are in the
[appendix](#appendix--alternatives-considered) so this section stays focused on
what shipped.

- **Approach A — Status quo + process discipline.** Keep the fork-per-cloud
  overlays and rely on reviewers to keep them in sync. *Rejected* — it is the
  current state and solves neither failure mode.
- **Approach B — Single-file conditional (`cloudValues` map + `global.cloud`).**
  Collapse overlays into one cloud-keyed map resolved in templates. *Rejected* as
  a blanket solution (large subchart template surgery, impossible for vendored
  subcharts, nil-fragile), but the `cloudValues` map is retained in a limited,
  tier-level role.
- **Approach C — Helm-native layering + guardrails (recommended, implemented).**
  Keep Helm's native `values.yaml` + per-environment overlays, but shape the base
  for cloud, add `values.schema.json` / `required` contracts, and add a parity
  linter + render gate in CI. Detailed below.
- **Approach D — External templating (Helmfile / Kustomize / jsonnet).** Add an
  outer templating layer to render per-cloud variants. *Rejected for now* —
  disproportionate migration cost, and it does not itself add the validation that
  prevents drift.

## Recommended approach (Approach C) in detail

### Layering model

```
values.yaml             # cloud-shaped base: correct on AKS/GKE/EKS as-is
  + values-local.yaml   # the single strip-down overlay (disable monitors, dev storage/ports)
  + values-<cloud>.yaml # only irreducible deltas: storage class, secret names, WI client IDs
```

Composition order is unchanged in `helm_upgrade_tier` — base first, overlay
last, then `--set` flags and `HELM_EXTRA_ARGS` retain last-write-wins.

### Direction of defaults (the key decision)

The base is shaped for **cloud**, and `values-local.yaml` opts *out*. So:

- A value added to `values.yaml` is automatically present on all three clouds.
- The only way to "forget" a value now lands on **local** — the developer's own
  E2E box, where it surfaces immediately.
- The dangerous direction (a cloud silently missing a value) is no longer the
  default.

Anything moved from a cloud overlay *into* the base must be safe to render on
local too, or be explicitly disabled in `values-local.yaml` — otherwise the
breakage simply moves from cloud to local.

### Guardrail stack

1. **`values.schema.json` per tier** — declare the genuinely required keys that
   have no safe default (e.g. `global.storageClass`, `global.endpoint`, the
   config-service admin-secret env). Helm validates the coalesced values against
   the schema on every `template`/`install`, so a missing/empty critical key
   fails the **render** before any cluster mutation. Catches failure mode #2.
2. **In-template `required`** for values that must be non-empty at install but
   cannot be expressed structurally (e.g. a per-cloud secret name). The chart
   refuses to render rather than emitting a broken Deployment.
3. **Values-parity linter** (`make lint-values`, modeled on
   `scripts/lint-makefile-conventions.sh`): for each tier it computes the
   leaf-key set of every overlay and reports two problems:
   - **DRIFT** — a key set on some **hyperscaler** overlays but not all. Parity
     is compared **only across `aks`/`gke`/`eks`** (`HYPERSCALER_ENVS` in the
     script). `values-local.yaml` is intentionally excluded: it is the
     deliberate strip-down of the cloud-shaped base, so parity-checking it
     against the clouds produces noise, not signal. A key set on aks+gke but
     missing on eks (the real failure mode #1) still fails loudly.
   - **ORPHAN** — an overlay key (in **any** overlay, `local` included) that has
     no entry in the tier's base `values.yaml`, so Helm silently ignores it
     (usually a typo or a renamed key). Local is still orphan-checked so dev
     overlay typos are caught.
   Intentional exceptions live in a per-tier `.values-parity-allow.yaml`
   (reviewed cross-cloud differences such as `azureClientId`, plus a small set
   of orphan-suppress entries for keys a sub-chart consumes but the parent base
   does not declare). Turns failure mode #1 into a red check.

The `cloudValues` map from Approach B is retained **only** for tier-level
toggles (storage class, endpoint, ports, monitor enable) where it is cheap and
lintable — never pushed down into per-subchart blocks.

### CI workflow

**Shipped (PR-time).** `main.yml` has a `helm-validate` job that runs
`make helm-validate` — the parity linter (`make lint-values`) followed by
`helm template` of the render-validated tiers across all four clouds, with
`values.schema.json` enforced during render. No cluster contact.

- The job **fails red** on any drift/schema/render error — it no longer carries
  `continue-on-error`, so it is no longer advisory.
- It does **not** block merges yet. A failing job that is not in the
  branch-protection required checks shows a red ✗ but GitHub still permits the
  merge. To make it merge-blocking, add `Helm Validate` to the required status
  checks for `main` + `release/**` — no further YAML change needed.
- It runs on every PR (not path-filtered) alongside the other `main.yml` jobs.
- **Render coverage.** The gate render-validates `platform`, `llm-gateway`,
  `services`, `console`, `workers`, and `edge`. The `identity` tier is
  parity-linted but rendered separately via `helm-identity-template-<cloud>`
  (it needs a hostname), so it is outside this job's render loop; a
  `values.schema.json` for identity is tracked as a Phase 4 follow-up.


### Developer workflow (day-to-day)

- **Value is the same everywhere:** edit `values.yaml`. All clouds inherit it.
- **Local cannot do it:** add the disable/override to `values-local.yaml` only.
  Local is not parity-checked, so this won't trigger a drift failure — but the
  key must exist in the base `values.yaml` (override an existing key) or the
  linter flags it as an ORPHAN. Genuinely local-only keys not in base are the
  only case that needs an orphan-suppress entry in `.values-parity-allow.yaml`.
- **Genuinely per-cloud value:** add to each `values-<cloud>.yaml`. Forgetting
  one fails the PR via `make lint-values` ("set for {aks} but missing for
  {gke,eks}"); a missing critical key also fails the render via the schema.
- Developers run `make helm-tier-template-aks|gke|eks` locally before pushing —
  the same command CI runs — so feedback is immediate, not post-merge.

## Rollout plan

Phases are ordered low-risk-first; each is additive and safe to ship
independently.

| Phase | Scope | Outcome | Status |
| --- | --- | --- | --- |
| **0. Render gate** | `helm-validate` + per-cloud `helm-validate-<cloud>` targets in `mk/validate.mk` rendering all tiers offline. | Immediate safety net; enumerates current drift without touching values. | Done — targets in place and wired into `main.yml` as the `helm-validate` job (fails red on drift; not yet a required check). |
| **1. Parity linter** | `scripts/lint-values-parity.py` + `make lint-values` + per-tier allow-lists seeded from today's intentional differences. Parity compares the three hyperscalers only; `local` is orphan-checked but not drift-checked. | Failure mode #1 becomes a CI failure. | Done — all 7 tiers have allow-lists; runs in CI via `make helm-validate`. |
| **2. Schema contracts** | `values.schema.json` for the highest-risk tiers first (`services`, `platform`, `workers`) + `required` guards for must-have secret/env keys. | Failure mode #2 becomes a render-time failure. | Done for `services`, `platform`, `workers` (permissive `additionalProperties: true`, validated against every overlay). |
| **3. Converge layering** | Re-shape base to cloud-defaults tier by tier; shrink overlays to deltas; (optionally) introduce a `cloudValues` map for tier-level toggles. | Removes the structural cause of drift. | Partial (`services` converged; remaining tiers pending). |

## Appendix — alternatives considered

Full write-ups of the rejected approaches (summarized in
[Approaches considered](#approaches-considered)) and the reasoning behind not
pushing conditionals into subcharts.

### Approach A — Status quo + process discipline

Keep the fork-per-cloud layout and rely on reviewers / checklists to keep the
overlays in sync.

**Pros**
- Zero engineering effort.
- No change to the deploy path or developer habits.

**Cons**
- Does not actually solve the problem; both failure modes are human-error
  driven and reviewers already miss them today.
- Drift is invisible until a cluster breaks.

**Verdict:** rejected — it is the current state.

### Approach B — Single-file conditional (`cloudValues` map + `global.cloud` selector)

Collapse the overlay files into a single `values.yaml` that holds a cloud-keyed
map, select the active cloud with `--set global.cloud=<cloud>`, and move the
per-cloud selection logic into the chart templates / `_helpers.tpl`.

```yaml
global:
  cloud: local            # overridden at deploy: --set global.cloud=<cloud>
  cloudValues:
    local: { storageClass: standard,     serviceMonitor: false }
    aks:   { storageClass: anf-nfs,      serviceMonitor: true  }
    gke:   { storageClass: gcnv-nas-rwx, serviceMonitor: true  }
    eks:   { storageClass: fsxn-nas,     serviceMonitor: true  }
```

Templates then resolve values via `index .Values.global.cloudValues
.Values.global.cloud "<key>"` (often wrapped in a helper).

**Pros**
- All clouds are visible side-by-side in one block, so a missing entry is
  visually obvious.
- The map is trivially lintable (assert every `cloudValues.<cloud>` has the
  same sub-keys).
- Works cleanly for **tier/umbrella-level** values (storage class, endpoint,
  gateway port, monitor toggles passed via `global`).

**Cons**
- **`values.yaml` cannot hold conditionals** — it is static data, never
  templated. The branching logic must move into templates, which is a large,
  invasive change.
- **Subchart blast radius.** Each subchart reads its own flat values (e.g.
  `agent-service/templates/serviceaccount.yaml` reads
  `.Values.serviceAccount.azureClientId`). Making those cloud-conditional means
  rewriting every subchart's `serviceaccount.yaml` / `deployment.yaml` /
  `servicemonitor.yaml` / `_helpers.tpl` — roughly 6 files per service × ~9
  services × multiple tiers. Only the parent's `global` tree is auto-shared with
  subcharts, so the map must live under `global` and every consumer site becomes
  a verbose `index` expression.
- **Impossible for vendored subcharts.** We do not control lakekeeper / bifrost
  / temporal / redis templates, so those tiers still need overlay files anyway —
  the model is not uniform.
- **Nil-fragile and silent.** A typo in `global.cloud` or a missing map entry
  renders *empty* (no ServiceAccount, no ServiceMonitor) with no error — arguably
  worse than a visible file fork. Mitigating this requires wrapping every lookup
  in a `required` helper, adding yet more template code.

**Verdict:** rejected as a blanket solution; the `cloudValues` map is retained
in a **limited** role for tier-level toggles only (see recommended approach).

### Approach D — External templating (Helmfile / Kustomize / jsonnet)

Introduce an outer layer (e.g. Helmfile environments, or Kustomize overlays
post-`helm template`) to render per-cloud variants.

**Pros**
- Powerful environment modeling; DRY across clouds.

**Cons**
- Adds a new tool and mental model on top of an already-sophisticated
  Make + Helm pipeline (`mk/cloud/*.mk`, `helm_upgrade_tier`,
  `deploy-reusable.yml`).
- Large migration cost and a steeper on-call learning curve.
- Does not directly add the *validation* that actually prevents the drift —
  we would still need a schema/linter on top.

**Verdict:** rejected for now — disproportionate to the problem; revisit only if
layering needs outgrow Helm's native `-f` merge.

### Why per-subchart conditionals were not adopted

For a single first-party service (`agent-service`), making its four cloud-varying
values (`serviceAccount.create`, `serviceAccount.azureClientId`,
`workloadIdentity.enabled`, `metrics.serviceMonitor.enabled`) conditional via the
`cloudValues` map requires editing:

- the parent `values.yaml` (add `global.cloud` + `global.cloudValues`),
- the subchart `values.yaml` (extend the `global` stub for nil-safety),
- `templates/serviceaccount.yaml`, `templates/deployment.yaml`,
  `templates/servicemonitor.yaml`, and `_helpers.tpl` (resolve via `index`),
- `mk/tier-helm.mk` (pass `--set global.cloud=<cloud>`),

then deleting the per-cloud overlay blocks — ~6 files per service, repeated for
~9 services per tier across multiple tiers, and impossible for vendored
subcharts. The recommended approach achieves the same drift protection through
base-default direction + schema/`required` + a parity linter, without any
subchart template surgery.

## Related docs

- `docs/deployment/env-propagation-matrix.md` — how deploy-time env vars flow
  into Helm `--set` lines (`make verify-env-propagation`).
- `docs/deployment/makefile-target-conventions.md` — Make target naming +
  `make lint-makefile` (the linter pattern the parity linter mirrors).
- `docs/deployment/deployment-design.md` — overall tiered deployment
  architecture.
