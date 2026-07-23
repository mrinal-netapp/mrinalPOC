# Post-PR-57/82 Request Flow: JWT/RPT Guards + Enforcement

This diagram shows the complete end-to-end request path after PR #57 (guard library) and PR #82 (config-service enforcement) merge.

## Complete Request Path (Project Route Example)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                  POST-PR-57/82: JWT/RPT GUARD FLOW                               │
│             (Project Route: GET /api/v1/projects/proj-abc/datasets)              │
└──────────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│   1. CLIENT     │  GET /api/v1/projects/proj-abc/datasets
│                 │  Authorization: Bearer <access-token>
└────────┬────────┘        │
         │                 │ Plain Keycloak JWT (issued to agentstudio-gui)
         │                 │
         ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│   2. GATEWAY (agent-studio-api)                    [PR 141, not in PR 57/82]   │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ UMA Ticket Exchange                                                       │ │
│   │ • Extract projectId from URL → "proj-abc"                                │ │
│   │ • POST /realms/nemo/protocol/openid-connect/token                        │ │
│   │     grant_type=urn:ietf:params:oauth:grant-type:uma-ticket               │ │
│   │     audience=agent-studio-api                                             │ │
│   │     token=<access-token>                                                  │ │
│   │ • Keycloak returns RPT with authorization.permissions                     │ │
│   │ • Cache RPT for 5min by (userId, projectId)                              │ │
│   │ • Replace Authorization header                                            │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
         │
         │ GET /api/v1/projects/proj-abc/datasets
         │ Authorization: Bearer <RPT>
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│   3. ISTIO SIDECAR (config-service pod)                                         │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ RequestAuthentication (Keycloak JWKS)                                     │ │
│   │ ✓ Signature valid?                                                        │ │
│   │ ✓ iss === "https://auth.agentstudio.local:8443/realms/nemo"?            │ │
│   │ ✓ aud === "agent-studio-api"?                                            │ │
│   │ ✓ exp > now?                                                              │ │
│   │                                                                            │ │
│   │ ❌ Any check fails → 401 (BEFORE app sees the request)                   │ │
│   │ ✅ All checks pass → forward to config-service:8080                      │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
         │
         │ (RPT validated, signature trusted)
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│   4. CONFIG-SERVICE: Express Middleware Chain          [PR 57 + PR 82]          │
│                                                                                  │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ A. applyGuards(ProjectScope('member', {paramName: 'projectId'}))         │ │
│   │                                                                            │ │
│   │    Stamps route policy metadata onto req._guardMetadata:                 │ │
│   │    { projectScope: { scope: 'member', paramName: 'projectId' } }         │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
│         │                                                                        │
│         ▼                                                                        │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ B. contextGuard()                                        [PR 57 core]     │ │
│   │                                                                            │ │
│   │    1. Check metadata.public || metadata.serviceOnly? → NO, continue      │ │
│   │                                                                            │ │
│   │    2. Extract Bearer token from Authorization header                     │ │
│   │       "Bearer eyJhbGc...header.eyJzdWI...payload.signature"              │ │
│   │       ❌ Missing/empty → 401 token_missing                               │ │
│   │                                                                            │ │
│   │    3. decodeJwtPayload(token):                                           │ │
│   │       • Split on '.' → [header, payload, signature]                      │ │
│   │       • base64url-decode payload segment (NO signature verify)           │ │
│   │       • JSON.parse()                                                      │ │
│   │       ❌ Malformed → 401 token_malformed                                 │ │
│   │                                                                            │ │
│   │    4. resolveUrlProjectId(req, metadata):                                │ │
│   │       • metadata.projectScope.paramName = 'projectId'                    │ │
│   │       • req.params['projectId'] = "proj-abc"                             │ │
│   │                                                                            │ │
│   │    5. mapRptToContext(payload, "proj-abc"):                              │ │
│   │                                                                            │ │
│   │       ┌──────────────────────────────────────────────────────────────┐   │ │
│   │       │  RPT Payload → AgentStudioContext                            │   │ │
│   │       │  ────────────────────────────────────────────────────────    │   │ │
│   │       │  sub                  → user_id: "kc-uuid-alice"             │   │ │
│   │       │  email                → user_email: "alice@example.com"      │   │ │
│   │       │  preferred_username   → preferred_username: "alice.test"     │   │ │
│   │       │                                                                │   │ │
│   │       │  realm_access.roles (?? [])                                  │   │ │
│   │       │    → realm_roles: []      ← ABSENT on RPT!                   │   │ │
│   │       │                                                                │   │ │
│   │       │  resource_access["agent-studio-api"].roles (?? [])           │   │ │
│   │       │    → api_roles: ["platform-member"]  ← authoritative source │   │ │
│   │       │                                                                │   │ │
│   │       │  authorization.permissions                                    │   │ │
│   │       │    .find(p => p.rsname === "project:proj-abc")               │   │ │
│   │       │      ✓ Found: {rsname: "project:proj-abc", scopes:["member"]}│   │ │
│   │       │    → project_id: "proj-abc"                                   │   │ │
│   │       │    → project_scopes: ["member"]                               │   │ │
│   │       │                                                                │   │ │
│   │       │  ❌ Missing sub/email/preferred_username → 401 token_shape_invalid│ │
│   │       └──────────────────────────────────────────────────────────────┘   │ │
│   │                                                                            │ │
│   │    6. Attach to request:                                                  │ │
│   │       req.agentStudioContext = {                                          │ │
│   │         user_id: "kc-uuid-alice",                                         │ │
│   │         user_email: "alice@example.com",                                  │ │
│   │         preferred_username: "alice.test",                                 │ │
│   │         realm_roles: [],                                                  │ │
│   │         api_roles: ["platform-member"],                                   │ │
│   │         project_id: "proj-abc",                                           │ │
│   │         project_scopes: ["member"]                                        │ │
│   │       }                                                                    │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
│         │                                                                        │
│         ▼                                                                        │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ C. rolesGuard()                                          [PR 57 core]     │ │
│   │                                                                            │ │
│   │    1. Check metadata.public? → NO                                        │ │
│   │    2. Check metadata.roles? → undefined (no Roles() on this route)       │ │
│   │       → PASS (no role enforcement needed)                                │ │
│   │                                                                            │ │
│   │    (If Roles('platform-admin') were declared:)                           │ │
│   │      granted = new Set([...realm_roles, ...api_roles])                   │ │
│   │               = ["platform-member"]                                       │ │
│   │      required.some(r => granted.has(r))                                  │ │
│   │      ❌ "platform-admin" NOT in granted → 403 role_required              │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
│         │                                                                        │
│         ▼                                                                        │
│   ┌──────────────────────────────────────────────────────────────────────────┐ │
│   │ D. permissionsGuard()                                    [PR 57 core]     │ │
│   │                                                                            │ │
│   │    1. Check metadata.public || metadata.serviceOnly? → NO                │ │
│   │    2. Check metadata.projectScope? → YES                                 │ │
│   │       required scope: 'member', paramName: 'projectId'                   │ │
│   │                                                                            │ │
│   │    3. Resolve URL project ID:                                            │ │
│   │       urlProjectId = req.params['projectId'] = "proj-abc"                │ │
│   │       ❌ Missing → 403 project_id_missing                                │ │
│   │                                                                            │ │
│   │    4. Check context has project_id:                                      │ │
│   │       ctx.project_id = "proj-abc" ✓                                      │ │
│   │       ❌ undefined → 403 context_project_id_missing                      │ │
│   │                                                                            │ │
│   │    5. Check URL matches context (IDOR/URL-spoof guard):                 │ │
│   │       urlProjectId === ctx.project_id?                                   │ │
│   │       "proj-abc" === "proj-abc" ✓                                        │ │
│   │       ❌ Mismatch → 403 project_id_mismatch                              │ │
│   │                                                                            │ │
│   │    6. Check scope rank (admin=3, member=2, viewer=1):                    │ │
│   │       required = rank('member') = 2                                      │ │
│   │       granted  = max(rank(ctx.project_scopes))                           │ │
│   │                = max(rank(['member'])) = 2                               │ │
│   │       granted >= required? → 2 >= 2 ✓                                    │ │
│   │       ❌ Insufficient → 403 scope_insufficient                           │ │
│   │                                                                            │ │
│   │    ✅ ALL CHECKS PASS                                                     │ │
│   └──────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────┘
         │
         │ (Guards passed, context validated and trusted)
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│   5. HANDLER: listDatasets(req, res)                        [PR 82 wiring]      │
│                                                                                  │
│   const ctx = req.agentStudioContext;  // TypeScript knows the shape           │
│   const userId = ctx.user_id;          // "kc-uuid-alice"                      │
│   const projectId = ctx.project_id;    // "proj-abc" (guaranteed === URL)      │
│                                                                                  │
│   // Business logic can TRUST this context - all validation done by guards     │
│   const datasets = await datasetsRepo.findByProject(projectId);                │
│   res.json(datasets);                                                           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Token Structure Comparison

### Before PR 57: Base64 Envelope
```
Header:  X-Agent-Studio-Context: eyJ1c2VyX2lkIjoiLi4uIn0=
         └─ base64(JSON)

Decoded: {
  user_id: "...",
  project_id: "...",
  realm_roles: [...],
  api_roles: [...],
  project_scopes: [...],
  iss: "...",      ← validation claims
  aud: "...",
  jti: "...",
  iat: 0,
  exp: 0,
  tenant_id: "..."
}

Validated by:  Envoy external-auth filter (signature, exp, iss, replay)
Decoded by:    envelope-decoder.ts (base64 → JSON.parse)
```

### After PR 57: Keycloak JWT/RPT
```
Header:  Authorization: Bearer eyJhbGc...header.eyJzdWI...payload.signature
         └─ Standard JWT (header.payload.signature)

Payload (project route RPT):
{
  // Standard OIDC claims
  sub: "kc-uuid-alice",
  email: "alice@example.com",
  preferred_username: "alice.test",
  iss: "https://auth.agentstudio.local:8443/realms/nemo",
  aud: "agent-studio-api",
  azp: "agentstudio-gui",
  exp: 1718456000,
  iat: 1718455700,

  // realm_access: ABSENT on RPT (stripped by UMA exchange)

  // Client roles (authoritative on project routes)
  resource_access: {
    "agent-studio-api": {
      roles: ["platform-member"]  ← mirrored from realm role composite
    }
  },

  // UMA authorization (only on RPT, not plain tokens)
  authorization: {
    permissions: [
      {
        rsid: "uuid-of-resource",
        rsname: "project:proj-abc",  ← matches URL project
        scopes: ["member"]
      },
      {
        rsname: "project:another-project",  ← user has access to multiple
        scopes: ["admin"]
      }
    ]
  }
}

Validated by:  Istio RequestAuthentication (signature, exp, iss, aud)
Decoded by:    rpt-mapper.ts (base64url payload → JSON → mapRptToContext)
Mapped to:     req.agentStudioContext (consumed fields only)
```

---

## Alternate Path: Public Route

```
┌──────────────┐
│   CLIENT     │  GET /health
│              │  (no Authorization header needed)
└──────┬───────┘
       │
       ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  GATEWAY → SIDECAR → CONFIG-SERVICE                                            │
│                                                                                │
│  applyGuards(Public())      → stamps metadata.public = true                   │
│  contextGuard()              → bypass (metadata.public)                        │
│  rolesGuard()                → bypass (metadata.public)                        │
│  permissionsGuard()          → bypass (metadata.public)                        │
│                                                                                │
│  Handler: healthCheck()      → no req.agentStudioContext (not needed)         │
│           res.json({status:'ok'})                                              │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Alternate Path: Service-Only Route

```
┌───────────────────┐
│ AGENT-SERVICE POD │  POST /api/v1/deployments {...}
│   (workload)      │  (no user Authorization header)
└─────────┬─────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  ISTIO MESH                                                                    │
│  ┌──────────────────────────────────────────────────────────────────────────┐ │
│  │ AuthorizationPolicy (workload-to-workload)                                │ │
│  │   - sourceNamespace: "agentstudio-services"                               │ │
│  │   - sourcePrincipal: "cluster.local/ns/.../sa/agent-service"             │ │
│  │   ✅ Allowed workloads pass                                               │ │
│  │   ❌ External/user requests rejected at mesh                              │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────────────────────┐
│  CONFIG-SERVICE                                                                │
│                                                                                │
│  applyGuards(ServiceOnly())  → stamps metadata.serviceOnly = true             │
│  contextGuard()              → bypass (metadata.serviceOnly)                   │
│  rolesGuard()                → bypass (metadata.serviceOnly)                   │
│  permissionsGuard()          → bypass (metadata.serviceOnly)                   │
│                                                                                │
│  Handler: createDeployment() → no req.agentStudioContext                      │
│           (workload identity from mTLS cert, not user token)                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## Error Response Format

All guard failures return structured JSON with machine-readable error codes:

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "code": "token_missing",
  "message": "Authorization bearer token is required"
}
```

**403 Forbidden:**
```json
{
  "error": "Forbidden",
  "code": "scope_insufficient",
  "message": "requires project scope >= member, have [viewer]"
}
```

### Error Codes by Status

**401** (Authentication failures):
- `token_missing` — Authorization header absent or empty
- `token_malformed` — JWT structure invalid or payload isn't JSON
- `token_shape_invalid` — Missing required claims (sub/email/preferred_username)

**403** (Authorization failures):
- `role_required` — User lacks required role
- `project_id_missing` — URL has no project param when one is required
- `context_project_id_missing` — RPT has no permission for ANY project
- `project_id_mismatch` — URL project ≠ context project_id (IDOR guard)
- `scope_insufficient` — User has viewer, route needs member/admin

**500** (Configuration/wiring errors):
- `context_decode_internal_error` — Mapper threw unexpected error
- `scope_unknown` — Required scope isn't admin/member/viewer (fail closed)
- `rolesguard_missing_context` — ContextGuard didn't run first (wiring bug)
- `permissionsguard_missing_context` — ditto

---

## Key Behaviors

### Multi-Project Permission Collapse
The RPT can carry permissions for **multiple** projects the user has access to:
```json
"authorization": {
  "permissions": [
    { "rsname": "project:proj-abc", "scopes": ["member"] },
    { "rsname": "project:proj-xyz", "scopes": ["admin"] }
  ]
}
```

The mapper **collapses** to the **single** URL project (`"proj-abc"` from the route param), so `permissionsGuard`'s existing `urlProjectId === ctx.project_id` check keeps working unchanged. The context only exposes one project at a time.

### realm_access Absent on RPT
The UMA/RPT exchange **strips the `realm_access` claim entirely**. On project routes:
- `realm_roles` will be `[]`
- **All roles come from `resource_access["agent-studio-api"].roles`** (the `api_roles` field)
- This works because platform roles (e.g., `platform-member`) are **mirrored** as identically-named client roles on the `agent-studio-api` client

The `rolesGuard` unions `realm_roles ∪ api_roles`, so the role check passes regardless of which bucket contains the role.

### Decode-Only Library
The guard library **never** verifies JWT signatures, `iss`, `aud`, `exp`, or `iat`. That's the **Istio sidecar's job** via `RequestAuthentication`. The library only:
1. base64url-decodes the JWT payload segment
2. Maps claims → typed context
3. Enforces role/scope policy on the typed context

This is a **zero-trust model**: the sidecar validates at every hop before the request reaches app code.
