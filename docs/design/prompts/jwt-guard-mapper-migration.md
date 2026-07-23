# Task: Adopt JWT/RPT strategy in the application guards (PR 57/82) — mapper approach

## Goal
Switch the application guard stack from the **base64 envelope** model
(`X-Agent-Studio-Context` header → `req.agentStudioContext`) to the **Keycloak
JWT/RPT** model defined in PR 141 (`docs/design/agent-studio-security-stack.md`),
WITHOUT changing the role/scope guards, decorators, route wiring, or handlers.
Keep the internal contract `req.agentStudioContext` (do NOT migrate to `req.user`).
Confine the wire-format change to the context decoder via a claim-mapping layer.

## Hard constraints / decisions (settled — do not deviate)
- Keep `req.agentStudioContext` as the internal field. Do NOT introduce `req.user`.
- Do NOT change `rolesGuard`, `permissionsGuard`, `decorators`/`applyGuards`/
  `Public`/`ServiceOnly`/`ProjectScope`, route wiring (`CONFIG_GUARD_POLICIES`),
  or any of the 50 route handlers. The mapper must produce a context whose
  consumed fields match today's shape so these stay untouched.
- Decode-only in-process. Do NOT verify signature/iss/aud/exp in the library —
  Istio RequestAuthentication validates the JWT at every sidecar hop before the
  request reaches app code (same trust model as the old Envoy envelope filter).
- Collapse the RPT's multi-project permissions to the SINGLE project in the URL,
  so `permissionsGuard`'s existing `urlProjectId === ctx.project_id` and
  scope-rank logic keep working unchanged.

## Verified background
- Today's guard chain: `applyGuards(meta) → contextGuard() → rolesGuard() →
  permissionsGuard() → handler`. Only `contextGuard` produces
  `req.agentStudioContext`; the other guards are pure consumers.
- `contextGuard` today: read `X-Agent-Studio-Context` → `decodeEnvelope`
  (base64url → JSON.parse → `isAgentStudioContext` shape check) → attach. Decode
  only; `Public()`/`ServiceOnly()` bypass it.
- `rolesGuard`: requires ≥1 of `ctx.realm_roles ∪ ctx.api_roles` to match the
  `Roles(...)` metadata.
- `permissionsGuard` (verified logic): for `ProjectScope(scope)` it (1) requires
  `ctx.project_id`, (2) checks `urlProjectId === ctx.project_id`, (3) requires
  `max(rank(ctx.project_scopes)) >= rank(required)` with hierarchy
  `admin(3) ⊇ member(2) ⊇ viewer(1)`. `ProjectScopeName = 'admin'|'member'|'viewer'`.
- The RPT is a standard Keycloak-signed JWT with one extra top-level
  `authorization` claim. Shape below is the ACTUAL token captured from the local
  Keycloak (`nemo` realm, Keycloak 26.6.0), not the illustrative PR 141 sample:
  ```json
  {
    "iss": "https://auth.agentstudio.local/realms/nemo",
    "aud": "agent-studio-api",
    "azp": "agentstudio-gui",
    "sub": "<keycloak user uuid>",
    "exp": 1718456000, "iat": 1718455700,
    "resource_access": { "agent-studio-api": { "roles": ["platform-member"] } },
    "preferred_username": "jane.doe",
    "email": "jane.doe@example.com",
    "authorization": {
      "permissions": [
        { "rsid": "<uuid>", "rsname": "project:projyha57hbh", "scopes": ["admin"] },
        { "rsid": "<uuid>", "rsname": "project:projf5ggndg1", "scopes": ["admin"] }
      ]
    }
  }
  ```
  The gateway performs a UMA-ticket exchange to upgrade the user access token to
  an RPT for project-scoped URLs (`/api/v1/projects/:projectId/*`) and forwards it
  as `Authorization: Bearer <RPT>`. Non-project requests forward the plain access
  token (no `authorization` claim).
- IMPORTANT (verified against local Keycloak): the UMA/RPT exchange **drops the
  `realm_access` claim entirely** — it is absent from the RPT. Roles survive only
  in `resource_access["agent-studio-api"].roles` (the platform roles are mirrored
  as identically-named client roles on `agent-studio-api`). So on project routes
  `resource_access` is the AUTHORITATIVE role source; `realm_access` will be
  missing. The plain (non-project) access token still carries both `realm_access`
  and `resource_access`.

## Implementation

### 1. `AgentStudioContext` (src/common/src/auth/AgentStudioContext.ts) — trim
Keep ONLY the fields the guards/handlers consume; REMOVE the sidecar-validation
fields the app never reads (no optional-field hack — just drop them):
```ts
export interface AgentStudioContext {
  user_id: string;
  user_email: string;
  preferred_username: string;
  realm_roles: string[];
  api_roles: string[];
  project_id?: string;
  project_scopes?: ProjectScopeName[];
}
// REMOVE: iss, aud, jti, iat, exp  (validated at the sidecar; not consumed in-process)
// REMOVE: tenant_id  (confirmed unused by guards/handlers; only Azure connector
//                     provider metadata uses a "tenant_id" key, unrelated to auth)
```
Update `isAgentStudioContext` to assert only the retained required fields
(`user_id`, `user_email`, `preferred_username`, `realm_roles`, `api_roles`).

### 2. Replace `decodeEnvelope` with `mapRptToContext` (same file or sibling)
Decode-only mapper from RPT claims → `AgentStudioContext`:
```
sub                                          → user_id
email                                        → user_email
preferred_username                           → preferred_username
realm_access.roles            (?? [])        → realm_roles   // absent on RPT/project routes → []
resource_access["agent-studio-api"].roles (?? []) → api_roles   // authoritative role source on project routes
authorization.permissions
  .find(p => p.rsname === `project:${urlProjectId}`)?.scopes (?? []) → project_scopes
  → project_id = urlProjectId  ONLY IF a matching permission exists
```
- Signature: `mapRptToContext(payload: Record<string, unknown>, urlProjectId?: string): AgentStudioContext`.
- For non-project requests (no `urlProjectId` / no `authorization`), leave
  `project_id`/`project_scopes` undefined — matches today's tenant-wide envelope.
- Throw a structured error (reasons `token_malformed` | `token_shape_invalid`)
  on decode/shape failure; `contextGuard` maps these to 401.

### 3. `contextGuard` (src/common/src/middleware/contextGuard.ts) — thin edit
- Read the JWT from `Authorization: Bearer <token>` (configurable header name),
  not `X-Agent-Studio-Context`.
- base64url-decode the JWT PAYLOAD segment (the middle part); do NOT verify the
  signature (sidecar did). JSON.parse it.
- Resolve the URL project id the same way `permissionsGuard` does (route param /
  resolver) so the mapper can scope permissions; pass it to `mapRptToContext`.
- Attach result to `req.agentStudioContext`.
- Missing token → 401 `token_missing`. Decode/shape failure → 401 with the
  structured reason. Keep `Public()`/`ServiceOnly()` bypass unchanged.

### 4. DO NOT CHANGE
`rolesGuard`, `permissionsGuard`, `decorators`/`applyGuards`/`withGuards`/
`Public`/`ServiceOnly`/`Roles`/`ProjectScope`, all route wiring
(`CONFIG_GUARD_POLICIES` and every `applyGuards(...)`), and all 50 handlers.
They read `req.agentStudioContext` with the same field names the mapper produces.

## Notes
- Role vocabulary already aligns: RPT `scopes` use `member`/`viewer`/`admin`,
  matching `ProjectScopeName` — `permissionsGuard`'s RANK logic is unchanged.
- `resource_access["agent-studio-api"].roles` is the `api_roles` source and is the
  authoritative role source on project routes (the RPT drops `realm_access`).
  Verified the client id is exactly `agent-studio-api`. Read `realm_access.roles`
  defensively (`?? []`) — it is legitimately absent on RPTs.
- Keep the single-project collapse: do NOT expose multi-project permissions in the
  context, or `permissionsGuard` would need changes (explicitly out of scope here).
- `tenant_id` is intentionally dropped: it is not present in the RPT and not
  consumed anywhere on the auth context (verified — the only `tenant_id` usage is
  unrelated Azure connector provider config).

## Validation
- Unit: `mapRptToContext` (sub→user_id, email→user_email, roles from
  `resource_access["agent-studio-api"].roles` with `realm_access` absent — the RPT
  case; permission match by `project:{urlProjectId}` → scopes, permission miss →
  empty scopes, non-project token with `realm_access` present → realm_roles set,
  no project fields).
- Unit: `contextGuard` with a JWT payload → 401 on missing/malformed token; 200
  path attaches a correctly-mapped context; `Public()`/`ServiceOnly()` still bypass.
- Unchanged: `rolesGuard`/`permissionsGuard` tests still pass (they build the
  context directly); update only fixtures that previously built base64 envelopes.
- Regression: re-run the full guard enforcement suite (must stay green: all 50
  routes / existing enforcement cases) against the new contextGuard.

## Out of scope / do NOT do
- Do NOT migrate to `req.user`.
- Do NOT verify signature/iss/aud/exp in-process.
- Do NOT change rolesGuard, permissionsGuard, decorators, routes, or handlers.
- Do NOT expose multi-project permissions in the context (single-project collapse).
- Do NOT add or carry `tenant_id` on the context.
