# config-service ↔ workflow-engine — end-to-end auth flow (post-merge)

> Companion to [`single-guard-mesh-identity.md`](./single-guard-mesh-identity.md).
> Shows the request flow once **three** changes are merged:
>
> - **PR #249** — mesh-delegated auth (`MESH_DELEGATED_AUTH`: identity from
>   `X-User-*` headers → `req.user`, no in-app JWT verify) + SA-token disable
>   (`DISABLE_SA_TOKEN_INJECTION`: east-west becomes tokenless mTLS) + edge
>   `mesh-require-jwt` relaxed to `principals: ["*"]`.
> - **This PR** — `unifiedGuard` on config-service: the user lane decodes the
>   RPT for per-project scope; the service lane reads `X-Service-Caller`.
> - **PR A** — Istio EnvoyFilter that injects `X-Service-Caller: <spiffe>` for
>   allow-listed principals only (stripping any client-supplied value).

## Lane summary

| | North–south (user) | East–west (service) |
| --- | --- | --- |
| Caller | browser → edge gateway | pod → pod |
| Identity carrier | Keycloak RPT (+ `X-User-*` headers) | mTLS SPIFFE → `X-Service-Caller` |
| config-service lane | user lane | service lane |
| Per-project scope | enforced (RPT `permissions[]`) | skipped (mesh allow-list authz'd) |

---

## 1. East–west: workflow-engine → config-service

The original `401 token_shape_invalid` case — background workflow, no user.

```mermaid
sequenceDiagram
    autonumber
    participant WE as workflow-engine
    participant SC as config-svc sidecar
    participant CS as config-svc app

    WE->>SC: PUT /internal/projects/abc/datasets/d1/status<br/>tokenless · STRICT mTLS · SPIFFE = sa/workflow-engine
    SC->>SC: RequestAuthentication — JWT optional (PR-249)
    SC->>SC: EnvoyFilter (PR A) — peer allow-listed →<br/>inject X-Service-Caller · strip client copy
    SC->>CS: forward request + X-Service-Caller
    CS->>CS: PR-249 shim — no X-User-ID → req.user unset · no 401
    CS->>CS: unifiedGuard — no user token →<br/>X-Service-Caller trusted → next() · no scope check
    CS-->>WE: 200
```

---

## 2. North–south: user → config-service

For contrast — the per-project scope path the service lane skips.

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant EG as Edge gateway
    participant SC as config-svc sidecar
    participant CS as config-svc app

    U->>EG: GET /projects/abc/datasets · Bearer RPT
    EG->>EG: validate RPT · inject X-User-* · forward RPT
    EG->>SC: mTLS · peer = edge gateway (NOT allow-listed)
    SC->>SC: EnvoyFilter — peer not allow-listed → no X-Service-Caller
    SC->>CS: forward request + X-User-* + RPT
    CS->>CS: PR-249 shim — X-User-ID present → req.user set
    CS->>CS: unifiedGuard — RPT sub+email → user lane →<br/>decode permissions[] · scope check on abc
    CS-->>U: 200 / 401 / 403
```

---

## 3. The guard decision (config-service, one route)

```mermaid
flowchart TD
    A[request] --> B{policy.public?}
    B -- yes --> H([next → handler])
    B -- no --> C{user token?<br/>sub + email present}
    C -- yes --> D{policy.user set?}
    D -- no --> X1[403 user_not_allowed]
    D -- yes --> E[run user policy:<br/>context / roles / project-scope]
    E -- pass --> H
    E -- fail --> X2[401 / 403]
    C -- no --> F{X-Service-Caller present?}
    F -- yes --> G{policy.internalAllowed?}
    G -- yes --> H
    G -- no --> X3[403 service_not_allowed]
    F -- no --> X4[401 token_missing_or_invalid]
```

---

## Reverse direction: config-service → workflow-engine

Mirror image, with one asymmetry: **workflow-engine does not run `unifiedGuard`**
(it is config-service-only). It uses PR #249's Go delegated middleware
(`internal/middleware/auth.go`):

- **User-initiated** (e.g. `POST /projects/:id/init`): config-service forwards
  the user context; workflow-engine resolves identity from `X-User-*` headers
  (e.g. `requireProjectAdmin`).
- **Background**: tokenless mTLS; the delegated middleware never 401s. If PR A
  also injects `X-Service-Caller` on workflow-engine's inbound, acting on it
  would be a separate Go-side change.

---

## Guarantees

| Property | Enforced by |
| --- | --- |
| Service is who it claims | STRICT mTLS / SPIFFE |
| Only allow-listed services reach the service lane | PR A EnvoyFilter injects `X-Service-Caller` for allow-listed principals only |
| #249's `principals:["*"]` re-tightened app-side | `unifiedGuard`: no `X-Service-Caller` ⇒ `401` (a non-allow-listed peer the mesh admitted still can't pass) |
| User cannot forge the service lane | user token → user lane first; mesh strips client `X-Service-Caller`; gateway SPIFFE not allow-listed |
| Per-project scope (the irreducible check) | `unifiedGuard` user lane decoding the RPT `permissions[]` |

## Assumptions

1. The edge keeps forwarding `Authorization: Bearer <RPT>` to config-service in
   delegated mode — the guard needs `permissions[]` for the scope check (#249's
   headers carry identity, not scopes/roles).
2. PR A injects **and strips** `X-Service-Caller`. Until it lands, the service
   lane has no producer in real traffic (works only where the header is set
   manually, e.g. tests / local).

---

## After both PRs merge: config-service **and** workflow-engine

Once the workflow-engine guard lands too — the **same merged guard** as
config-service (decode-only; the Istio sidecar validates signatures), with **no
per-project scope lane** (workflow-engine has no `permissions[]` in its claims) —
both services run the same two-lane model. workflow-engine is overwhelmingly a
*service-called* API; config-service is mixed.

### Topology — who calls whom, and which lane

```mermaid
flowchart TB
    U["Browser / user"]
    EG["Edge gateway<br/>validate RPT · inject X-User-*"]
    CS["config-service<br/>unifiedGuard (decode-only)"]
    WE["workflow-engine<br/>merged guard (Go, decode-only)"]
    WK["workers<br/>kb · dataset · connector · eval"]

    U -->|RPT| EG
    EG -->|user lane · RPT| CS
    EG -->|user lane · RPT| WE
    CS -->|service lane · X-Service-Caller| WE
    WE -->|service lane · X-Service-Caller| CS
    WK -->|service lane · X-Service-Caller| CS
    WK -->|service lane · X-Service-Caller| WE
```

### Round-trip — project init touches both guards and both lanes

```mermaid
sequenceDiagram
    autonumber
    participant U as User (UI)
    participant CS as config-service (unifiedGuard)
    participant WE as workflow-engine (guard)

    U->>CS: POST /projects · Bearer RPT
    Note over CS: USER lane (context)
    CS->>WE: POST /projects/{id}/init · forwards user RPT
    Note over WE: USER lane (decode-only · non-SA)
    WE-->>CS: 201 workflowId
    Note over WE: ProjectInit activities run (no user)
    WE->>CS: POST /internal/projects/{id}/gateway-setup · X-Service-Caller
    Note over CS: SERVICE lane → next()
    CS-->>WE: 200
    WE->>CS: POST /internal/users/resolve-or-create · X-Service-Caller
    Note over CS: SERVICE lane → next()
    CS-->>WE: 200
```

### Lane per direction

| Caller → target | Lane | Carrier |
| --- | --- | --- |
| user → config-service | user | RPT (per-project scope enforced) |
| user → workflow-engine (`/init`, `/members`) | user | decoded user token (non-SA) |
| config-service → workflow-engine | service | `X-Service-Caller` |
| workflow-engine → config-service | service | `X-Service-Caller` |
| workers → either | service | `X-Service-Caller` |

**Symmetric now:** both run the **same decode-only merged guard** — the Istio
sidecar validates JWT signatures at every hop and the guard base64-decodes. Both
share the same `X-Service-Caller` service lane (from the separate mesh
EnvoyFilter PR). The **only** difference: workflow-engine adds **no** per-project
scope lane (it has no `permissions[]` and never enforced one); per-project
authorization stays a config-service concern.
