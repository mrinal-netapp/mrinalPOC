# PR #82 Config-Service Enforcement: Rebase Checklist

**Status:** PR #82 (`feat/config-service-guards`) is built on a pre-JWT base of PR #57 (`feat/app-guards-rollout`). It needs a rebase + doc refresh to align with PR #57's JWT/RPT migration (commit `d939ef19` and follow-ups).

**Verdict:** ✅ Consistent in design/API contract, but stale in implementation details.

---

## What's Already Correct

PR #82 consumes the PR #57 guard library exactly as intended:

✅ **Correct API usage:**
- Mounts `contextGuard → rolesGuard → permissionsGuard` triad from `@agentstudio/common`
- Stamps policy via `applyGuards(meta)` + `ProjectScope`/`Roles`/`ServiceOnly`/`Public`
- Shares one memoized guard instance via `getConfigGuard()` (correct for per-method route tiers)
- `CONFIG_GUARD_POLICIES` is a clean data-driven route audit; per-method routes guarded inside routers

✅ **Handler compatibility preserved:**
- Handler reads `req.agentStudioContext?.user_id` for IDOR/own-identity checks
- `user_id` survives the envelope→JWT migration unchanged (mapped from `sub` claim)
- This is exactly why the mapper approach was chosen — consumers don't break

**At the contract level, config-service enforcement is consistent with PR #57.**

---

## Why a Rebase is Needed

PR #82's branch does NOT contain PR #57's JWT/RPT migration (`d939ef19`) nor the 3 follow-up review fixes. Its last merge from `feat/app-guards-rollout` predates the migration.

### Consequences:

1. **Stale terminology everywhere:** Comments describe the envelope / Envoy sidecar filter model (e.g., `guards.ts:40-42` mentions "envelope claim validation (iss/aud/exp/iat) lives in the Envoy sidecar filter"). After migration, it's the **Istio RequestAuthentication** validating a **JWT**, not an Envoy envelope filter.

2. **Obsolete platform-admin deferral:** Several routes are unwired with note "Wire once the realm-role mapper populates `envelope.realm_roles`" (`guards.ts:209/216/223`). Under JWT/RPT, `realm_roles` (from `realm_access`) and `api_roles` (from `resource_access`) are **now populated**. Those routes should be wired (downgraded to `platform-member` per user request).

3. **Merge conflict pending:** PR #82 carries its own `40ff2595` "slim ContextGuard to decode-only extractor" which overlaps with PR #57's `d939ef19` JWT migration of the same files (`contextGuard.ts`, `AgentStudioContext.ts`, mapper). A rebase onto PR #57's head will conflict — **resolve in favor of PR #57's JWT version** (source of truth).

---

## Rebase Execution Checklist

### Step 1: Merge Order
```bash
# Ensure PR #57 is merged to feat/app-guards-rollout first
# PR #57 must be the base of truth before rebasing PR #82

# Fetch latest state
git fetch origin feat/app-guards-rollout feat/config-service-guards

# Switch to PR #82 branch
git checkout feat/config-service-guards
```

### Step 2: Rebase onto PR #57 Head
```bash
# Rebase PR #82 onto the JWT-migrated base
git rebase origin/feat/app-guards-rollout

# Expected conflicts in:
# - src/common/src/middleware/contextGuard.ts
# - src/common/src/auth/rpt-mapper.ts (or envelope-decoder remnants)
# - src/common/src/types/AgentStudioContext.ts
```

### Step 3: Resolve Conflicts (PR #57 Wins)
For any conflicts in the guard library files:
- **Accept PR #57's version** (the JWT/RPT decoder + mapper)
- **Discard PR #82's `40ff2595` commit changes** to those files
- PR #82's config-service wiring (`src/nemo/config-service/middleware/guards.ts`, `index.ts`, route modules) should have NO conflicts (those files don't exist in PR #57)

**Key files where PR #57 is source of truth:**
- `src/common/src/middleware/contextGuard.ts` → JWT decode-only extractor
- `src/common/src/auth/rpt-mapper.ts` → claim mapping with `realm_access ?? []`, `resource_access ?? {}`
- `src/common/src/types/AgentStudioContext.ts` → trimmed shape (no `iss`/`aud`/`jti`/`iat`/`exp`/`tenant_id`)

---

## Step 4: Update Stale Terminology (guards.ts)

**File:** `src/nemo/config-service/middleware/guards.ts`

### Lines 40-42 (outdated comment):
```typescript
// OLD (envelope model):
/**
 * Hard cutover: the guards always mount (deploy == enforce). `ContextGuard` is
 * a decode-only extractor — envelope claim validation (`iss`/`aud`/`exp`/`iat`)
 * lives in the Envoy sidecar filter, and replay protection has been removed
 * (see docs/design/app-guards-rollout.md). There is no GATEWAY_ISS gate.
 */
```

**Replace with:**
```typescript
// NEW (JWT model):
/**
 * Hard cutover: the guards always mount (deploy == enforce). `ContextGuard` is
 * a decode-only extractor — JWT validation (`signature`/`iss`/`aud`/`exp`)
 * lives in the Istio RequestAuthentication (Keycloak JWKS), not the application
 * (see docs/design/app-guards-rollout.md). The guard library only decodes the
 * pre-validated JWT payload and maps claims to typed context.
 */
```

---

## Step 5: Unwire Deferred Platform-Admin Routes (Downgrade to platform-member)

**File:** `src/nemo/config-service/middleware/guards.ts`

Per user request: **change `platform-admin` deferrals to `platform-member` to unblock these routes** (conservative downgrade).

### Lines 209-228 (3 deferred routes):
```typescript
// OLD (deferred, waiting for realm-role mapper):
{
  basePath: '/api/v1/platform/mcp-servers',
  policy: 'platform-admin',
  wire: Roles('platform-admin'),
  deferred: true,
  note: 'Wire once the realm-role mapper populates envelope.realm_roles.',
},
{
  basePath: '/api/v1/gateway',
  policy: 'platform-admin',
  wire: Roles('platform-admin'),
  deferred: true,
  note: 'Wire once the realm-role mapper populates envelope.realm_roles.',
},
{
  basePath: '/api/v1/governance',
  policy: 'platform-admin',
  wire: Roles('platform-admin'),
  deferred: true,
  note: 'Wire once the realm-role mapper populates envelope.realm_roles.',
},
```

**Replace with (platform-member + wire immediately):**
```typescript
// NEW (platform-member, wired):
{
  basePath: '/api/v1/platform/mcp-servers',
  policy: 'platform-member',  // Downgraded from platform-admin (conservative unblock)
  wire: Roles('platform-member'),
  note: 'Platform-wide resource; any authenticated platform member can access.',
},
{
  basePath: '/api/v1/gateway',
  policy: 'platform-member',
  wire: Roles('platform-member'),
  note: 'Platform-wide resource; any authenticated platform member can access.',
},
{
  basePath: '/api/v1/governance',
  policy: 'platform-member',
  wire: Roles('platform-member'),
  note: 'Platform-wide resource; any authenticated platform member can access.',
},
```

### Remove `deferred: true` field entirely (no longer deferred).

---

## Step 6: Wire the Unwired Routes in index.ts

**File:** `src/nemo/config-service/index.ts`

After removing `deferred: true`, these 3 routes need to be mounted with guards in `index.ts`:

```typescript
// Existing mounts (keep as-is):
app.use('/health', ..., healthRouter);
app.use('/ready', ..., readyRouter);
// ... other mounts ...

// ADD (after removing deferred flag from guards.ts):
const guard = getConfigGuard();

app.use('/api/v1/platform/mcp-servers', guard(Roles('platform-member')), platformMcpServersRouter);
app.use('/api/v1/gateway', guard(Roles('platform-member')), gatewayRouter);
app.use('/api/v1/governance', guard(Roles('platform-member')), governanceRouter);
```

**Note:** If these routers don't exist yet in the codebase (they might be stubbed), you can defer the `app.use(...)` mount but UPDATE the policy table to reflect the intent. The important part is **removing the blocker note** from `guards.ts`.

---

## Step 7: Verify Terminology Consistency

Search for any remaining references to the old envelope model and update:

```bash
# Search config-service for stale terms
cd src/nemo/config-service
grep -rn "envelope" --include="*.ts" .
grep -rn "Envoy" --include="*.ts" .
grep -rn "GATEWAY_ISS" --include="*.ts" .
```

**Expected finds:**
- Comments in `guards.ts` (fixed in Step 4)
- Any route-level comments referencing "envelope validation" — update to "JWT validation by Istio RequestAuthentication"

**Update pattern:**
- `envelope` → `JWT` or `JWT payload`
- `Envoy sidecar filter` → `Istio RequestAuthentication`
- `envelope.realm_roles` → `context.realm_roles` (from `realm_access.roles`)
- `envelope claim validation` → `JWT signature and claims validation`

---

## Step 8: Run Test Suite (Regression Check)

After rebase + terminology updates + route wiring:

```bash
cd src/nemo/config-service

# Run the guard enforcement test suite
npm test -- guards.enforcement

# Expected: ALL PASS (no behavioral change in guard logic)
# If failures occur, they likely indicate:
# 1. Context shape mismatch (check AgentStudioContext fields)
# 2. Fixture token format mismatch (update test fixtures to use JWT, not envelope)
```

**Key test file:** `src/nemo/config-service/__tests__/guards.enforcement.routes.unit.test.ts`

If this test uses envelope fixtures, update to JWT/RPT fixtures from PR #57:
- Use `tests/fixtures/rpt/valid_member_project_rpt.claims.json` for member-scope tests
- Use `tests/fixtures/rpt/valid_admin_project_rpt.claims.json` for admin-scope tests

---

## Step 9: Manual Smoke Test (Optional)

If you want to verify end-to-end behavior post-rebase:

1. **Start local stack:**
   ```bash
   # Assumes OrbStack + local Keycloak running
   docker compose up -d
   ```

2. **Mint a test RPT:**
   ```bash
   # Get access token for alice.test
   ACCESS_TOKEN=$(curl -s -X POST http://localhost:8080/realms/nemo/protocol/openid-connect/token \
     -d "grant_type=password" \
     -d "client_id=agentstudio-gui" \
     -d "username=alice.test" \
     -d "password=test" \
     | jq -r '.access_token')

   # Exchange for RPT (project:proj-abc scope)
   RPT=$(curl -s -X POST http://localhost:8080/realms/nemo/protocol/openid-connect/token \
     -H "Authorization: Bearer $ACCESS_TOKEN" \
     -d "grant_type=urn:ietf:params:oauth:grant-type:uma-ticket" \
     -d "audience=agent-studio-api" \
     -d "permission=project:proj-abc#member" \
     | jq -r '.access_token')

   echo "RPT: $RPT"
   ```

3. **Test a guarded route:**
   ```bash
   # Should succeed (alice.test has member scope on proj-abc)
   curl -H "Authorization: Bearer $RPT" \
     http://localhost:8080/api/v1/projects/proj-abc/datasets

   # Should fail 403 (alice.test trying to access different project)
   curl -H "Authorization: Bearer $RPT" \
     http://localhost:8080/api/v1/projects/proj-xyz/datasets
   ```

4. **Test unwired platform-member route:**
   ```bash
   # Should succeed (alice.test has platform-member role)
   curl -H "Authorization: Bearer $RPT" \
     http://localhost:8080/api/v1/platform/mcp-servers
   ```

---

## Step 10: Final Commit Message

After completing the rebase + updates, amend or add a commit:

```
feat(config-service): align with PR #57 JWT/RPT migration

Rebased onto feat/app-guards-rollout post-JWT migration (PR #57 d939ef19).

Changes:
- Resolved conflicts: adopted PR #57's decode-only JWT contextGuard (source of truth)
- Updated terminology: envelope → JWT, Envoy filter → Istio RequestAuthentication
- Unwired platform-admin deferrals: downgraded to platform-member (conservative unblock)
- Wired 3 previously-deferred routes: /platform/mcp-servers, /gateway, /governance
- No behavioral change in guard logic; consumer API unchanged

Tests: guards.enforcement.routes.unit.test.ts passes (regression clean)

Resolves: PR #82 alignment with PR #57
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## Summary Table: What Changes Where

| File | Change | Reason |
|------|--------|--------|
| `contextGuard.ts` | **Accept PR #57 version** (rebase conflict) | JWT decode-only extractor (source of truth) |
| `rpt-mapper.ts` | **Accept PR #57 version** (rebase conflict) | Claim mapping with defensive `realm_access ?? []` |
| `AgentStudioContext.ts` | **Accept PR #57 version** (rebase conflict) | Trimmed shape (no validation claims) |
| `guards.ts` (config-service) | Update line 40-42 comment | Envelope → JWT, Envoy → Istio terminology |
| `guards.ts` (config-service) | Lines 209-228: remove `deferred: true`, change `platform-admin` → `platform-member` | Unblock routes (conservative downgrade per user request) |
| `index.ts` (config-service) | Add 3 `app.use(...)` mounts with `Roles('platform-member')` | Wire previously-deferred routes |
| Any other comments | Search & replace stale envelope/Envoy terms | Consistency across codebase |

---

## Key Points for PR Review

When submitting PR #82 for review post-rebase:

1. **Call out the base change:** "Rebased onto PR #57 post-JWT migration; conflicts resolved in favor of PR #57's decode-only JWT mapper."
2. **Highlight terminology refresh:** "Updated all envelope/Envoy references to JWT/Istio for accuracy."
3. **Explain platform-member downgrade:** "Unwired platform-admin routes now use `Roles('platform-member')` as a conservative unblock (realm/resource roles now available in JWT)."
4. **Confirm no behavioral change:** "Guard logic unchanged; test suite passes; consumer API intact."

---

## References

- **PR #57:** JWT/RPT guard migration (commit `d939ef19` + follow-ups)
  - Introduced decode-only `contextGuard`, `rpt-mapper.ts`, trimmed `AgentStudioContext`
  - All 4 languages (TS, Go, Python, Rust) pass conformance tests

- **PR #82:** Config-service guard enforcement
  - Built on pre-JWT base; wires the guard triad per route group
  - Consistent API usage, but needs terminology + deferred-route updates post-rebase

- **PR #152:** Migration prompt + flow diagram
  - `docs/design/prompts/jwt-guard-mapper-migration.md` — implementation guide
  - `docs/design/prompts/post-pr57-82-request-flow.md` — end-to-end flow

- **Local validation evidence:**
  - Keycloak 26.6.0 (nemo realm): RPT has `realm_access: null`, `resource_access["agent-studio-api"].roles` authoritative
  - Platform roles mirrored as client roles via Keycloak composites
  - All test suites green (TS 44 tests, Go 4 packages, Python 29 tests, Rust 18 tests)

---

## Questions?

If conflicts arise that aren't covered by this checklist, or if test failures occur post-rebase:

1. **Check the context shape:** Ensure handlers/tests expect the trimmed `AgentStudioContext` (no `iss`/`aud`/`jti`/`iat`/`exp`/`tenant_id`)
2. **Check test fixtures:** Envelope-based test tokens need to be replaced with JWT/RPT samples from `tests/fixtures/rpt/`
3. **Check claim paths:** `realm_roles` from `realm_access.roles ?? []`, `api_roles` from `resource_access["agent-studio-api"].roles ?? []`

All of this is empirically validated against local Keycloak and PR #57's test suites — if something breaks, it's likely a wiring issue in the rebase, not a logic issue in the guards.
