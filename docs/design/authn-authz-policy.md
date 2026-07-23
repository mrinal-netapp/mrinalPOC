# AuthN + AuthZ Policy — AgentStudio (Simplified Guard)

> **Scope:** config-service + workflow-engine · **Context:** PR #274 (mesh
> AuthorizationPolicy, merged) + PR #318 (unified guard, simplified model).

---

## 1. The two-layer model

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1 — MESH  (infrastructure, always on)                │
│                                                             │
│  AuthN:  mTLS between every pod (SPIFFE certs)              │
│  AuthN:  JWT signature/iss/aud/exp validated at sidecar     │
│  AuthZ:  AuthorizationPolicy (PR #274) — per-pair           │
│          allow-list. Only named workloads reach named        │
│          services.                                           │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  LAYER 2 — APP GUARD  (PR #318, UNIFIED_GUARD_SMOKE=true)   │
│                                                             │
│  ONE question: does this request carry a JWT with email?    │
│                                                             │
│  YES (user) → enforce per-route scope (viewer/member/admin) │
│  NO  (service/worker) → next(), mesh already decided        │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. North-South flow (Browser → config-service)

```mermaid
sequenceDiagram
    participant B as Browser
    participant E as Edge Gateway
    participant KC as Keycloak
    participant S as config-service sidecar
    participant G as unifiedGuardGlobal
    participant H as handler

    B->>E: GET /api/v1/projects/abc/datasets Bearer plain-JWT
    E->>E: RequestAuthentication validates JWT sig/iss/aud/exp
    E->>KC: UMA ticket exchange permission=project:abc
    KC-->>E: RPT authorization.permissions project:abc scopes=member
    E->>S: mTLS + Bearer RPT
    S->>S: mesh-require-jwt requestPrincipal present ALLOW
    S->>G: request + RPT
    G->>G: GLOBAL_RULES lookup policy=viewer GET
    G->>G: payload.email present runUserChecks
    G->>G: find project:abc scopes=member RANK[member]>=RANK[viewer] pass
    G->>H: next() + req.agentStudioContext + req.user set
    H-->>B: 200
```

---

## 3. East-West flow (Worker → config-service)

```mermaid
sequenceDiagram
    participant W as dataset-processor no token
    participant S as config-service sidecar
    participant G as unifiedGuardGlobal
    participant H as handler

    W->>S: PUT /api/v1/projects/abc/datasets/d1/status no Authorization header mTLS SPIFFE cert
    S->>S: AuthorizationPolicy workers-dataset SPIFFE in allow-list ALLOW
    S->>G: request no Bearer token
    G->>G: GLOBAL_RULES lookup policy=member
    G->>G: payload.email absent !email true next() immediately
    G->>H: next() req.user NOT set
    H->>H: modifiedBy = req.user?.sub or undefined -> null
    H-->>W: 200
```

---

## 4. What each layer enforces

| Layer | What it checks | What it does NOT check |
| --- | --- | --- |
| **Mesh AuthN** (sidecar) | mTLS cert valid; JWT sig/iss/aud/exp; JWT present (north-south) | per-route verb restriction; project membership |
| **Mesh AuthZ** (PR #274) | caller workload in per-service allow-list | which route/verb called; user identity |
| **App Guard** (PR #318) | user has email claim; per-project scope (RPT); viewer/member/admin/roles | JWT signature (sidecar did it); service workload identity |

---

## 5. config-service guard flow

```mermaid
flowchart TB
    R[request] --> P{isPublicPath?}
    P -- yes --> N1[next]
    P -- no --> G[resolveGlobalPolicy method+path]
    G -- not in GLOBAL_RULES --> N2[next mesh is the gate]
    G -- in GLOBAL_RULES --> E{payload.email present?}
    E -- no --> N3[next worker or SA token passes]
    E -- yes --> U{policy.user set?}
    U -- no --> F1[403 user_not_allowed]
    U -- yes --> K{user kind?}
    K -- context --> N4[next any user passes]
    K -- roles --> RC{has required role?}
    RC -- yes --> N5[next]
    RC -- no --> F2[403 role_insufficient]
    K -- project --> SC{RANK held >= RANK required?}
    SC -- yes --> N6[next + req.agentStudioContext set]
    SC -- no --> F3[403 scope_insufficient or project_id_missing]
```

---

## 6. workflow-engine guard flow

```mermaid
flowchart TB
    R[request] --> ST[strip X-User-* headers always]
    ST --> L[lookup policy table method + FullPath]
    L -- not in table --> FC[user:true fail-closed default]
    FC --> E
    L -- public:true --> N1[next progress store]
    L -- user:true --> E{payload.email present?}
    E -- no --> N2[next worker or SA token passes]
    E -- yes --> S[set userClaims + X-User-* headers]
    S --> N3[next handler runs with user context]
```

---

## 7. Per-route AuthZ matrix

| Route group | AuthN gate | AuthZ gate |
| --- | --- | --- |
| `/api/v1/internal/**` | mTLS + allow-list (PR #274) | none at app — mesh only |
| `/api/v1/workspaces/**` | mTLS + allow-list | none at app |
| `/api/v1/buckets/**` (top-level) | mTLS + allow-list | none at app |
| `/api/v1/deployments/**` (writes) | mTLS + allow-list | none at app |
| `credentials/:id/secret-data` | mTLS + allow-list | none at app |
| `/api/v1/projects/:id/datasets/**` | mTLS + JWT sidecar | viewer (GET) / member (write) |
| `/api/v1/projects/:id/knowledgebases/**` | mTLS + JWT sidecar | viewer (GET) / member (write) |
| `/api/v1/projects/:id/agents/**` | mTLS + JWT sidecar | viewer (GET) / member (write) |
| `/api/v1/projects/:id/agent-teams/**` | mTLS + JWT sidecar | viewer (GET) / member (write) |
| `/api/v1/projects/:id/evaluation/**` | mTLS + JWT sidecar | viewer (GET) / member (write) |
| `/api/v1/projects/:id/datasources/**` | mTLS + JWT sidecar | member (all methods) |
| `/api/v1/projects/:id/credentials/**` | mTLS + JWT sidecar | member (all methods) |
| `/api/v1/projects/:id/models/**` | mTLS + JWT sidecar | member (all methods) |
| `/api/v1/projects/:id/pipelines/**` | mTLS + JWT sidecar | member (all methods) |
| `/api/v1/projects/:id` | mTLS + JWT sidecar | viewer (GET) / member (PATCH) / admin (PUT/DELETE) |
| `/api/v1/projects/:id/service-account` | mTLS + JWT sidecar | admin |
| `/api/v1/projects/:id/members/**` | mTLS + JWT sidecar | member |
| `/api/v1/projects/:id/buckets/**` | mTLS + JWT sidecar | member |
| `/api/v1/projects/:id/mcp-servers/**` | mTLS + JWT sidecar | member |
| `/api/v1/projects` (create/list) | mTLS + JWT sidecar | any valid user (context) |
| `/api/v1/deployments/**` (GET) | mTLS + JWT sidecar | any valid user (context) |
| `/api/v1/platform/**` | mTLS + JWT sidecar | platform-member role |
| `/api/v1/gateway/**` | mTLS + JWT sidecar | platform-member role |
| `/api/v1/governance/**` | mTLS + JWT sidecar | platform-member role |
| WE user routes (`/init`, `/members`, etc.) | mTLS + JWT sidecar | any valid user; handler self-checks |
| WE service routes (`/import`, `/process`, etc.) | mTLS + allow-list | none at app — !email → next() |
| WE `/workflows/:id/progress` | mTLS only | public — no JWT required |

---

## 8. Scope hierarchy

```
admin  ──┐
         ├── can do everything
member ──┤
         ├── can read + write resources
viewer ──┘
         └── can only read metadata (GET on content groups)

admin ⊇ member ⊇ viewer
(admin satisfies member requirement; member satisfies viewer requirement)
```

---

## 9. SA token transition (pre/post PR #249)

The guard uses `!payload?.email` — not `!payload` — to detect non-user callers:

| Caller | Token | `payload?.email` | Guard result |
| --- | --- | --- | --- |
| User (RPT) | JWT with email | present | scope-checked |
| Worker (post-PR#249) | no JWT | undefined | `next()` |
| SA token (pre-PR#249) | JWT, no email | undefined | `next()` |

Both tokenless workers and SA tokens reach the same `next()` path — no dual behaviour, no flag needed.

**After PR #249 merges** (SA tokens removed), one-line simplification per service:
```ts
// config-service: if (!payload?.email) → if (!payload)
// workflow-engine: if claims == nil || claims.Email == "" → if claims == nil
```

---

## 10. Security properties

| Property | Enforced by |
| --- | --- |
| Only allow-listed services reach config-service east-west | Mesh AuthorizationPolicy (PR #274) |
| JWTs are valid (sig/iss/aud/exp) | Istio RequestAuthentication (sidecar) |
| Users are scoped to their projects | App guard — RANK check on RPT |
| Viewers cannot write | App guard — `RANK[viewer](1) < RANK[member](2)` |
| Non-members blocked from projects | App guard — project not in RPT permissions |
| SA tokens pass pre-PR#249 | `!payload?.email` check |
| Forged X-User-* headers stripped | WE guard strip-then-set on every request |
| Workers carry no user identity | `req.user` not set on `!email` path |
