# Single-guard rollout — config-service ↔ workflow-engine handoff

Goal of this doc: list **every** workflow that crosses config-service and
workflow-engine, the HTTP hops each one makes in **both** directions, the guard
**lane** each hop takes, and the **exact conditions** under which enabling the
merged guard on **both** services breaks nothing (so `ProjectInitWorkflow` and
friends keep working).

Companion to `single-guard-mesh-identity.md` (design) and
`single-guard-e2e-flow.md` (flow). config-service guard = PR #268
(`unifiedGuard.ts`). workflow-engine guard = PR #272 (`guard.go`). Mesh
`X-Service-Caller` inject+strip = PR #274 (`envoyfilter-service-caller.yaml`).

---

## TL;DR — the one rule that prevents breakage

The merged guard authorizes east-west by **`X-Service-Caller`** (mesh-injected),
**not** by the service-account token — and the SA token is being removed. So for
every service→service hop below:

> **A route may be switched to the merged guard only once the mesh injects
> `X-Service-Caller` for that hop (PR #274). Until then, that route must keep
> accepting the existing token (global `createAuthMiddleware` / current
> `AuthMiddleware`).**

Both guards therefore ship **gated OFF** (`UNIFIED_GUARD_SMOKE`). Order to flip,
per route group:

1. PR #274 injects `X-Service-Caller` for the caller→target principals.
2. Enable the guard on the target route group (`UNIFIED_GUARD_SMOKE=true` on
   PR #268 / PR #272).
3. Drop the SA token from the caller (PR #249 SA-disable toggles — the "SA goes"
   step).

Do them out of order and the hop 401s. There is **no token fallback** by design.

---

## PR merge and rollout order

**Merge to `main`** (all guards ship gated OFF — safe to land before enablement):

| Order | PR | What |
| --- | --- | --- |
| 1 (anytime) | **#152** | Design docs (this doc, e2e flow, mesh-identity spec) |
| 2 | **#249** | Mesh `RequestAuthentication` + per-service SA-disable toggles |
| 3 | **#274** | Per-pair mesh authz + `X-Service-Caller` inject/strip EnvoyFilter |
| 4 | **#268** | config-service unified guard (`UNIFIED_GUARD_SMOKE` off by default) |
| 5 | **#272** | workflow-engine unified guard (`UNIFIED_GUARD_SMOKE` off by default) |

#268 and #272 can merge in either order (or together) while gated off. #274 does
not block merging #268/#272, but **must be deployed before enabling guards on
east-west (service-lane) routes**.

**Enable after deploy** (per route group — the TL;DR rule above):

1. Deploy **#249** mesh policies (`RequestAuthentication` on inbound paths).
2. Deploy **#274** (`X-Service-Caller` inject+strip + per-pair allow-list).
3. Enable **`UNIFIED_GUARD_SMOKE=true`** on config-service (**#268**).
4. Enable **`UNIFIED_GUARD_SMOKE=true`** on workflow-engine (**#272**).
5. Flip **SA-disable toggles** (**#249**) per hop — only after step 2 works for
   that caller→target pair.

**Identity model (Scenario A — canonical end-state):** north-south user traffic
forwards the RPT; the unified guard decodes it (sidecar already validated the
signature). Do **not** enable `MESH_DELEGATED_AUTH` header-reading (**#249**) on
a service that runs the unified guard — #268/#272 bypass that path. #249's
`RequestAuthentication` and SA-disablement remain prerequisites; only the
header-reading identity mode is superseded.

---

## Workflow inventory — both directions

For each workflow: **trigger** = the inbound HTTP call that starts it (and the
lane on the *target's* guard); **callbacks** = HTTP the workflow's activities
make back (and the lane on *that* target's guard). Lanes:

- **U** = user lane (user/RPT; config-service also enforces per-project scope)
- **S** = service lane (`X-Service-Caller`)
- **P** = public (auth-exempt)

| Workflow | Trigger → workflow-engine (caller, route, lane) | Callbacks → config-service (route, lane) |
| --- | --- | --- |
| **ProjectInitWorkflow** | config-service forwards **user** RPT → `POST /projects/:id/init` — **U** | `POST /internal/projects/:id/gateway-setup` **S**; `PUT /projects/:id` **S**; `POST /projects/:id/service-account` **S**; `POST /internal/users/resolve-or-create` **S** |
| **ProjectDeleteWorkflow** | config-service **SA** → `DELETE /projects/:id/delete` — **S** | `POST /internal/projects/:id/gateway-teardown` **S**; `DELETE /projects/:id/buckets/:name` **S** |
| **ProjectAddUser / RemoveUser / ChangeRole** | UI **user** (direct) → `POST\|DELETE /projects/:id/members`, `PUT /members/role` — **U** + `requireProjectAdmin` | Keycloak only (no config-service callback). Resolve email → `POST /internal/users/resolve(-or-create)` **S** (from the route handler, pre-workflow) |
| **DatasetImportWorkflow** | config-service **SA** → `POST /projects/:id/datasets/:id/import` — **S** | `GET /projects/:id/service-account` **S**; `PUT /projects/:id/datasets/:id/status` **S**; `PUT .../datasets/:id/facets/stats` **S** |
| **DataAcquisitionWorkflow** (acquire) | gui **user** (direct) **+** config-service **SA** → `POST /projects/:id/datasets/:id/acquire` — **dual (U+S)** | `GET .../datasets/:id` **S**; `GET .../datasources/:id` **S**; `PUT .../datasets/:id/status` **S**; `PUT .../datasets/:id/facets/acquisition` **S**; `PATCH .../datasets/:id` **S**; (connector-worker) `POST .../credentials/:id/secret-data` **S** |
| **TableProcessingWorkflow** | config-service **SA** → `POST /projects/:id/datasets/:id/process` — **S** *(no prod caller today)* | `GET /projects/:id/service-account` **S**; `PUT .../datasets/:id/status` **S** |
| **DatasetDeleteWorkflow** | config-service **SA** → `POST .../datasets/:id/terminate`, `DELETE .../datasets/:id` — **S** | none |
| **KnowledgeBaseCreationWorkflow** | config-service **user** (KB routes forward RPT) **+** SA (schedule fan-out) → `POST .../knowledgebases/:id/create` — **dual (U+S)** | `GET /projects/:id/service-account` **S**; `PUT .../knowledgebases/:id` **S**; `PUT .../knowledgebases/:id/facets/embedding` **S** |
| **KnowledgeBaseDeleteWorkflow** | config-service **user** → `POST .../knowledgebases/:id/terminate`, `DELETE .../knowledgebases/:id` — **U** | none (S3 only) |
| **ScheduledKBSyncWorkflow** | Temporal schedule (no HTTP trigger) | `POST /projects/:id/knowledgebases/:id/create` **S** |
| **PipelineWorkflow** | config-service **SA** → `POST .../pipelines/:id/executions` (+ cancel/resume/terminate) — **S** | `PUT .../pipelines/:id/executions/:eid` **S**; `PUT .../executions/:eid/steps` **S** (currently **unauth** — see risks) |
| **VolumeScanWorkflow** | config-service **SA** → `POST /connectors/volume-scan` — **S** | `GET .../datasources/:id` **S**; `PATCH /internal/datasources/:pid/:id/scan-result` **S** |
| **VolumeBrowseWorkflow** | UI **user** (direct) → `POST /connectors/volume-browse` — **U** | `GET .../datasources/:id` **S** |
| **ConnectorInteractiveWorkflow** | UI **user** (direct) → `POST .../connectors/:id/test`; config-service **SA** → `.../terminate` — **dual** | (connector-worker) `POST .../credentials/:id/secret-data` **S** |
| **ExplorerList / ExplorerSession** | UI **user** (direct) → `POST /explore/session`, `.../session/:sid/list`; config-service **SA** → `/explore/session/preflight/list` — **dual** | (connector-worker) `POST .../credentials/:id/secret-data` **S** |
| **ProjectVirtualKeyRotationWorkflow** | Temporal schedule | `GET /internal/projects/gateway-rotation-targets` **S**; `POST /internal/projects/:id/gateway-rotate` **S**; `.../gateway-rotate-complete` **S** |
| **MCPHealthCheckWorkflow** | Temporal schedule | `GET /internal/mcp-servers/health-eligible` **S**; `PATCH /internal/mcp-servers/:id/status` **S** |
| **DependencyLineageSyncWorkflow** (reference-edge reconcile) | Temporal schedule | `POST /internal/reference-edges/reconcile` **S**; `GET /internal/reference-edges/graph-data` **S**; `PUT /internal/reference-edges/lineage-facet/:pid` **S** |
| **ArtifactGCWorkflow** | Temporal schedule | none (local NFS + git) |
| **Eval workflow** (`POST /workflows`) | config-service **SA** → `POST /workflows` (+ cancel/signal); gui **user** → cancel — **dual** | reads via agent-service; not config-service |
| Workflow **status/result/logs** | UI **user** (direct) → `GET /workflows/:id/{status,result,logs}` — **U** | none |
| Workflow **progress** | workers + config-service poll + WE self — **tokenless** → `GET\|POST\|DELETE /workflows/:id/progress` — **P** | none |

---

## What this means for each guard

### workflow-engine guard (PR #272) — route → policy

- **public:** `/health`, `/metrics`, `GET|POST|DELETE /workflows/:id/progress` (workers/self, tokenless — MUST stay exempt or import/KB/acquire stall).
- **user:** `POST /projects/:id/init`; `POST|DELETE /projects/:id/members`, `PUT /members/role` (keep `requireProjectAdmin`); KB `terminate`/`DELETE`/`versions`/`rollback`; `volume-browse`; `connectors/:id/test`; `explore/session(+/:sid/list)`; `GET /workflows/:id/{status,result,logs}`.
- **dual (user + internalAllowed):** `datasets/:id/acquire`; KB `create`; `POST /workflows/:id/cancel`.
- **service (internalAllowed):** project `delete`; datasets `import`/`process`/`terminate`/`DELETE`/`schedule`; KB `schedule`; `POST /workflows` + `/signal`; pipelines `terminate`/`executions`/`executions/:id/{cancel,resume}`; `explore/session/preflight/list`; `connectors/volume-scan`; `connectors/:id/terminate`.
- Keep workflow-engine's **`userClaims` populated** in gin context (the guard's user lane sets it) so `requireProjectAdmin` / project_init keep working unchanged.

### config-service guard (PR #268) — the rollout gap to close

PR #268 only smoke-wires 3 route groups. The callbacks table shows the **full**
set of config-service routes that workflow-engine/workers hit and that must be
`internalAllowed:true` before SA removal — many are **non-`/internal/`**:

`PUT /projects/:id`, `POST|GET /projects/:id/service-account`,
`DELETE /projects/:id/buckets/:name`, `PUT .../datasets/:id/status`,
`PUT .../datasets/:id/facets/{stats,acquisition}`, `GET .../datasets/:id`,
`PATCH .../datasets/:id`, `GET .../datasources/:id`,
`PUT .../knowledgebases/:id`, `PUT .../knowledgebases/:id/facets/embedding`,
`POST .../knowledgebases/:id/create`, `POST .../credentials/:id/secret-data`,
`PUT .../pipelines/:id/executions/:eid(/steps)`, plus all the `/internal/*`.

Each must be **dual** (`{ user:{...}, internalAllowed:true }`) — they serve UI
users too.

---

## "Nothing breaks" — the local two-service test

Default (guard gated **off**): global auth handles SA tokens → all workflows
work unchanged. The test below proves the **end-state** (guards on) also works.

Setup (OrbStack, no mesh): deploy config-service + workflow-engine from their
branch images, both with `UNIFIED_GUARD_SMOKE=true`. Because there's no mesh to
inject `X-Service-Caller`, the test injects it **on the callbacks** to simulate
PR #274 (this is the explicit stand-in for the EnvoyFilter in
`envoyfilter-service-caller.yaml`):

- **User-lane entries:** real/minted RPT → `POST /projects/:id/init`, KB delete,
  `GET /workflows/:id/status` → expect **200/403** per scope, never a spurious 401.
- **Service-lane entries (both directions):** set `X-Service-Caller=spiffe://…/sa/<caller>`
  on each hop:
  - config-service → workflow-engine: `DELETE /projects/:id/delete`, dataset
    `import`, `POST /workflows` → **200**.
  - workflow-engine → config-service: `PUT /projects/:id/datasets/:id/status`,
    `PUT /projects/:id`, `POST /projects/:id/service-account`,
    `POST /internal/projects/:id/gateway-setup`, `POST /internal/users/resolve-or-create`
    → **200**.
- **Negative:** same service-lane calls **without** `X-Service-Caller` → **401**
  (proves the SA token is no longer the authorizer — the reason ordering matters).
- **Progress:** `POST /workflows/:id/progress` tokenless → **200** (worker path
  intact).

Pass criterion: every workflow's trigger **and** its callbacks return non-401 on
their designated lane; the only 401s are the intended negatives.

---

## Risks / must-not-forget

1. **Ordering (the TL;DR rule).** Enabling a guard on a route before PR #274
   injects `X-Service-Caller` for that hop → 401. Deploy #274 first, enable
   target guard second, drop SA token last (#249 toggles).
2. **`*/progress` must stay public** on workflow-engine or kb/dataset/connector
   workers stall (they post progress tokenless).
3. **`PUT .../pipelines/:id/executions/:eid(/steps)`** is currently called with
   **no auth header** (`PersistExecutionStatus`/`PersistStepResult` use a raw
   client). Under a guard these become service-lane and need `X-Service-Caller`
   — give those activities the header (PR #274) or they 401 once global auth is
   removed.
4. **KB/init are user-forwarded**, not SA — they stay user-lane and are
   unaffected by SA removal; do **not** flip them to service-only.
5. **config-service rollout breadth:** #268's smoke covers 3 groups; the full
   callback set above must be `internalAllowed` before SA removal, or
   workflow-engine callbacks 401.
