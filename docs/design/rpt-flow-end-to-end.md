# RPT Flow — End to End

> How the Keycloak Requesting Party Token (RPT) travels from the browser login
> all the way to the per-project scope check inside `config-service`, and why it
> must stay intact on every hop.
>
> Companion to [`single-guard-mesh-identity.md`](./single-guard-mesh-identity.md)
> and [`single-guard-e2e-flow.md`](./single-guard-e2e-flow.md).

---

## Why the RPT matters

A standard Keycloak **Access Token** carries identity (`sub`, `email`, realm
roles). An **RPT** (Requesting Party Token — obtained via a UMA token exchange)
carries both identity *and* fine-grained authorization:

```json
{
  "sub":   "user-123",
  "email": "mrinal@netapp.com",
  "authorization": {
    "permissions": [
      { "rsname": "project:abc", "scopes": ["member"] },
      { "rsname": "project:xyz", "scopes": ["admin"]  }
    ]
  }
}
```

The `authorization.permissions[]` array is the **source of truth for
per-project scope**. `config-service`'s unified guard (`unifiedGuard.ts`)
decodes this to enforce `project:member` / `project:admin` access without an
extra Keycloak round-trip per request. This is the irreducible app-side check
described in §10 of `single-guard-mesh-identity.md`.

---

## Phase 1 — User obtains the RPT from Keycloak

```
Browser                              Keycloak
  │                                     │
  │── 1. Login (username + password) ──►│
  │◄── 2. Access Token (AT) ───────────│
  │       { sub, email, realm_roles }   │
  │                                     │
  │── 3. UMA token exchange ───────────►│
  │     POST /token                     │  Keycloak evaluates which project
  │     grant_type=uma-ticket           │  resources the user holds policies
  │     audience=agent-studio-api       │  for and embeds them in the RPT.
  │                                     │
  │◄── 4. RPT ─────────────────────────│
  │       { sub, email,                 │
  │         authorization.permissions[] }
```

The RPT is a signed JWT. Keycloak is the only entity that can issue or modify
its `authorization.permissions[]` — callers cannot forge or extend it.

---

## Phase 2 — RPT travels north-south to config-service

```
Browser          Edge Gateway        Istio Sidecar       config-service app
  │                   │                    │                     │
  │ GET /projects/abc │                    │                     │
  │ /datasets         │                    │                     │
  │ Authorization:    │                    │                     │
  │ Bearer <RPT>      │                    │                     │
  │──────────────────►│                    │                     │
  │                   │                    │                     │
  │                   │ ① Validates RPT    │                     │
  │                   │   signature (JWKS) │                     │
  │                   │                   │                     │
  │                   │ ② Forwards SAME   │                     │
  │                   │   RPT intact ─────►                     │
  │                   │   Authorization:   │                     │
  │                   │   Bearer <RPT>     │                     │
  │                   │                   │                     │
  │                   │            ③ RequestAuthentication       │
  │                   │              validates sig again         │
  │                   │              (defense in depth)          │
  │                   │              peer = edge gateway         │
  │                   │              NOT in service allow-list   │
  │                   │              → no X-Service-Caller set   │
  │                   │                   │                     │
  │                   │                   │── ④ forwards ──────►│
  │                   │                   │   request + RPT     │
```

**The RPT must not be stripped at the edge.** This is the key difference from
the `MESH_DELEGATED_AUTH` approach (see [§ Why not header-delegation](#why-not-header-delegation)).

---

## Phase 2b — config-service forwards RPT to workflow-engine

When config-service needs to call workflow-engine on behalf of a user (e.g., creating a project which triggers ProjectInitWorkflow), it **forwards the same RPT** to maintain the user context:

```
config-service        Istio Sidecar       Istio Sidecar       workflow-engine app
  app                  (CS egress)         (WE ingress)
  │                         │                    │                     │
  │ POST /projects/123/init │                    │                     │
  │ Authorization:          │                    │                     │
  │ Bearer <RPT> ───────────►                    │                     │
  │                         │                    │                     │
  │                         │ ① mTLS handshake  │                     │
  │                         │   SPIFFE:         │                     │
  │                         │   sa/config-service│                    │
  │                         │◄──────────────────►│                     │
  │                         │                    │                     │
  │                         │ ② AuthorizationPolicy (PR #274):         │
  │                         │    config-service  │                     │
  │                         │    → workflow-engine                     │
  │                         │    IN allow-list?  │                     │
  │                         │    YES ✅          │                     │
  │                         │                    │                     │
  │                         │ ③ EnvoyFilter:     │                     │
  │                         │    Strip client    │                     │
  │                         │    X-Service-Caller│                     │
  │                         │    (none present)  │                     │
  │                         │    Inject:         │                     │
  │                         │    X-Service-Caller: spiffe://.../sa/config-service
  │                         │                    │                     │
  │                         │ ④ RequestAuthentication:                 │
  │                         │    Validates RPT   │                     │
  │                         │    signature       │                     │
  │                         │                    │                     │
  │                         │                    │── ⑤ forwards ──────►│
  │                         │                    │   Authorization:    │
  │                         │                    │   Bearer <RPT>      │
  │                         │                    │   X-Service-Caller: │
  │                         │                    │   spiffe://...      │
  │                         │                    │                     │
  │                         │                    │    unifiedGuard:    │
  │                         │                    │    decodeJwtPayload()│
  │                         │                    │    → sub + email    │
  │                         │                    │    isUser = true    │
  │                         │                    │    ✅ USER LANE     │
  │                         │                    │    runUserChecks()  │
  │                         │                    │    (scope check)    │
  │                         │                    │                     │
  │                         │                    │    Policy allows    │
  │                         │                    │    user OR service  │
  │                         │                    │    (dual-lane)      │
  │                         │                    │                     │
  │                         │                    │    ✅ User context  │
  │                         │                    │    preserved!       │
  │                         │                    │                     │
  │◄──────────────────────────────────────────────── 201 Created ─────│
```

**Key points:**

1. **RPT forwarded intact** — config-service does NOT strip the user token when calling workflow-engine. This preserves the user context (`sub`, `email`, `authorization.permissions[]`).

2. **Dual-lane route** — `/projects/:id/init` accepts EITHER:
   - **User lane**: RPT with `admin` scope (user creating project via GUI)
   - **Service lane**: X-Service-Caller (internal retry/callback scenarios)

3. **User lane wins** — Because RPT is present with `sub + email`, workflow-engine's guard routes to USER LANE, not service lane. The presence of `X-Service-Caller` doesn't override this.

4. **Scope enforcement** — workflow-engine's guard decodes the RPT and enforces the same per-project scope as config-service. The user must have `admin` scope on the project being initialized.

5. **Attribution preserved** — Workflow activities triggered by ProjectInitWorkflow can attribute actions to the actual user (`req.user.sub` = original user ID), not to `config-service` as a service account.

6. **Why this matters**: If config-service called workflow-engine tokenless (service lane only), the workflow would lose user context. Audit logs would show "config-service did X" instead of "user@example.com did X via config-service". Per-project scope enforcement would also be bypassed.

**Contrast with pure service-to-service**:
```
workflow-engine → config-service (dataset status update)
  - No RPT (tokenless mTLS)
  - X-Service-Caller: spiffe://.../sa/workflow-engine
  - SERVICE LANE (no scope check)
  - req.user.sub = SPIFFE (not a user ID)
```

---

## Phase 3 — unifiedGuard decodes the RPT (PR #268)

```
config-service: unifiedGuardGlobal()
  │
  ├─ resolveGlobalPolicy("GET", "/api/v1/projects/abc/datasets")
  │   → viewerDual: { user: { kind:'project', scope:'viewer' }, internalAllowed:true }
  │
  ├─ decodeJwtPayload(req)
  │       RPT = header.PAYLOAD.signature
  │                    │
  │       base64url-decode PAYLOAD only        ← NO signature verify
  │       (Istio sidecar already verified ↑)   ← cheap decode, not crypto
  │       → { sub, email, authorization.permissions[] }
  │
  ├─ isUser = sub present AND email present  →  true
  │
  ├─ policy.user set  →  runUserChecks(kind='project', scope='viewer')
  │
  │   ┌──────────────────────────────────────────────────────────────┐
  │   │                SCOPE CHECK AGAINST RPT                      │
  │   │                                                              │
  │   │  projectId  = req.params.projectId  = "abc"                  │
  │   │  (extracted from path by unifiedGuardGlobal before routing)  │
  │   │                                                              │
  │   │  search permissions[] for rsname = "project:abc"            │
  │   │                                                              │
  │   │  found: { rsname:"project:abc", scopes:["member"] }  ✅     │
  │   │                                                              │
  │   │  RANK = { viewer:1, member:2, admin:3 }                     │
  │   │  granted  = RANK["member"] = 2                              │
  │   │  required = RANK["viewer"] = 1   (viewerDual for GET)       │
  │   │  2 ≥ 1  →  PASS ✅                                          │
  │   └──────────────────────────────────────────────────────────────┘
  │
  ├─ req.agentStudioContext = {
  │     user_id:        "user-123",
  │     user_email:     "mrinal@netapp.com",
  │     project_id:     "abc",
  │     project_scopes: ["member"]
  │   }
  ├─ req.user = { sub: "user-123", email: "mrinal@netapp.com" }
  │
  └─ next() ✅  →  handler runs
```

---

## Phase 4 — Scope hierarchy

```
admin  (3) ──── can do everything: DELETE project, manage members
  │
member (2) ──── read + write project resources (datasets, models, agents …)
  │
viewer (1) ──── read-only (GET endpoints that return metadata, not secrets)
```

The guard applies the minimum rank required per endpoint. Because the RPT
carries the *maximum* scope the user holds for the project, a `member` token
satisfies `viewer`-gated GETs automatically.

---

## East-west path (service lane) — RPT is NOT involved

When workflow-engine calls config-service over mTLS (no user context), there
is no RPT. The guard takes the **service lane** instead:

```
workflow-engine                  Istio Sidecar + EnvoyFilter      config-service
  │                                       │                             │
  │ tokenless mTLS                        │                             │
  │ SPIFFE = sa/workflow-engine           │                             │
  │──────────────────────────────────────►│                             │
  │                              peer in allow-list?                    │
  │                              YES → inject:                          │
  │                              X-Service-Caller: spiffe://...         │
  │                              strip any client-supplied copy         │
  │                                       │────────────────────────────►│
  │                                                     unifiedGuardGlobal()
  │                                                     decodeJwtPayload() → null
  │                                                     isUser = false
  │                                                     trustedServicePeer()
  │                                                       → "spiffe://..."
  │                                                     policy.internalAllowed?
  │                                                       → true (memberDual)
  │                                                     auditServiceLane(allow)
  │                                                     next() ✅
```

The service lane **skips** all RPT/scope logic — the mesh allow-list is the
authorization mechanism. `req.agentStudioContext` is not set; `req.user` is
seeded with `{ sub: spiffe-id }` for attribution only.

---

## Why not header-delegation?

`MESH_DELEGATED_AUTH` (PR #249) proposed letting the edge strip the token and
inject plain `X-User-*` headers:

```
Edge strips RPT → injects X-User-ID, X-User-Email
                            │
                  authorization.permissions[]  LOST ✂️
                            │
                  Guard cannot find "project:abc"
                  → cannot check scope
                  → every authenticated user can access every project  🔴
```

The RPT *must* travel to config-service so the guard can decode
`permissions[]`. `MESH_DELEGATED_AUTH` is therefore **not the end-state** —
it is superseded by the unified guard approach.

When `UNIFIED_GUARD_SMOKE=true`, `AuthMiddleware` (which reads `MESH_DELEGATED_AUTH`)
is never installed, making the flag dead code. Do not enable both flags
expecting the header-reading path to run.

---

## Summary

| Step | Who acts | What happens |
|---|---|---|
| 1 | Browser + Keycloak | UMA exchange → RPT issued (signed, contains `permissions[]`) |
| 2 | Edge Gateway | Validates RPT signature; forwards token intact |
| 3 | Istio sidecar | Validates RPT signature again; no `X-Service-Caller` for user traffic |
| 4 | `unifiedGuardGlobal()` | Resolves policy from path; extracts `projectId` from path |
| 5 | `decodeJwtPayload()` | Base64url-decodes payload (no sig verify — sidecar did it) |
| 6 | `runUserChecks()` | Finds `project:{id}` in `permissions[]`; checks scope rank |
| 7 | Handler | Receives `req.agentStudioContext` with `project_id` + `project_scopes` |

**The RPT is the single Keycloak-signed document that carries both identity
and authorization. It must travel intact to config-service on every
north-south request.**
