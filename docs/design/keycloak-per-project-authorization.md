# Keycloak Per-Project Authorization

Status: Implemented in [PR #31](https://github.com/NetApp-Nemo/AgentStudio/pull/31), partial slice of the platform security design.

This doc explains the problem this PR solves, why we chose Keycloak Authorization Services as the source of truth, how the implementation lives inside the existing **workflow-engine** (we did not introduce a new microservice), and what is intentionally deferred to follow-on PRs.

It is meant to be read end-to-end by a reviewer who has not seen the platform-wide security design. Where deeper background helps, it points to the [platform security architecture](https://github.com/NetApp-Nemo/agent-studio/blob/feature/platform-designs/docs/platform-designs/agent-studio-security-architecture.md) (mainly §3.1 and §8).

Related: [Platform HLD](platform-hld.md) · [Workflows](workflows.md)

---

## 1. Problem statement

A "project" in Agent Studio is a unit of isolation: a project owns its data sources, datasets, knowledge bases, agents, S3 bucket, Iceberg warehouse and namespace. Until this PR, project access control was effectively binary — anyone authenticated against Keycloak could create projects and operate on any project. There was no notion of "Alice is admin of Project A but only viewer of Project B".

We need a system that:

1. Lets us record, per project, which users are members and with what role (`admin`, `member`, `viewer`).
2. Is **the** source of truth for that mapping — so different services (today: workflow-engine; future: API gateway, config-service, NestJS controllers) agree on who has access to what without having to reconcile a private DB cache.
3. Survives restarts, partial failures, and concurrent requests. Adding a member must not partially apply (e.g. policy created but permission not updated).
4. Has a clean lifecycle tied to project create / delete: when a project is deleted, all of its authz state in Keycloak goes with it.
5. Does not require building a homegrown ACL engine or persisting another copy of membership in our database.

## 2. Why Keycloak Authorization Services

Keycloak is already our identity provider (it brokers Azure Entra ID). Its **Authorization Services** module is purpose-built for resource-scoped, scope-based access control: it can store resources (projects), policies (which user can do what), and permissions (which scopes are bound to which resource for which policy). It also issues **RPTs** (Requesting Party Tokens) — JWTs whose `authorization.permissions[]` claim lists exactly the scopes the bearer holds on a given resource. That gives us:

- A single, externally-managed source of truth that every service can query the same way.
- Native, audited APIs for CRUD on resources/policies/permissions (no schema migrations, no ad-hoc tables).
- A natural way to project membership into request-time tokens later (the gateway will exchange a user access token for an RPT scoped to the project being accessed; this PR does **not** implement that step — see §6).

The platform security design (§8) settled on this model. This PR is the first concrete implementation of it.

## 3. Where this code lives (and where it does not)

This is a recurring question on review, so it gets its own section.

- **All of the workflow logic and write endpoints ship inside `workflow-engine`** (`src/nemo/workflow-engine`). The new membership *write* REST endpoints (`POST /api/v1/projects/:projectId/members`, `DELETE /api/v1/projects/:projectId/members`, `PUT /api/v1/projects/:projectId/members/role`) are served by workflow-engine because they are Temporal workflow starts (`StartProjectAddUser`, `StartProjectRemoveUser`, `StartProjectChangeRole`) wearing REST clothing. The target member is identified by **email in the request body** (no `:userId` path param); workflow-engine resolves the email to a Keycloak userId via config-service before starting the workflow.
- The membership *read* endpoint (`GET /api/v1/projects/:projectId/members`) lives in `config-service`. It is a pure Keycloak Authorization Services query with no Temporal involvement, so it belongs with the rest of config-service's read APIs. (PR #31 originally landed it in workflow-engine because the Authz Admin client was already wired in Go; this was corrected in the follow-up commit per review comment r3321434919.) The caller's own project list is served by `GET /api/v1/projects` (see §5.5), which joins the caller's Keycloak memberships onto config-service project metadata; the former `GET /api/v1/users/:userId/projects` endpoint was folded into it and removed.
- The Keycloak writes are done by **Temporal activities** (in workflow-engine), invoked from project lifecycle workflows (`ProjectInitWorkflow`, `ProjectDeleteWorkflow`) and from new membership workflows (`ProjectAddUserWorkflow`, `ProjectRemoveUserWorkflow`, `ProjectChangeRoleWorkflow`).

The platform design doc (§8.2) suggests that `config-service` could own these writes. We chose `workflow-engine` for this PR because:

- Project create/delete is already a workflow-engine workflow (it provisions the bucket, warehouse, and namespace). Adding "and create the Keycloak resource" as another step in the same workflow keeps the transactional story coherent and gives us Temporal's retry/idempotency guarantees for free.
- Membership operations have the same story: they are short, ordered sequences of Keycloak calls (e.g. add member = "create policy" then "update permission") that must be durable and idempotent. That is exactly what Temporal workflows are good at.
- It avoids cross-service chatter (config-service → workflow-engine → Keycloak) for an operation that is fundamentally workflow-engine's job.

This is a pragmatic choice; if we later want config-service to own membership instead, the activity contracts are clean enough to lift-and-shift.

## 4. Identity model recap (what Keycloak holds)

There are two independent axes:

| Axis | Source | Purpose |
| ---- | ------ | ------- |
| Tenant realm role | Entra ID group → Keycloak realm role (`platform-admin` / `platform-member`) | Admission to the platform; reaching tenant-admin endpoints; permission to **create** projects |
| Project scope | Per-project membership in Keycloak Authorization Services (`admin` / `member` / `viewer`) | What the user can do **inside** a specific project |

The two axes are independent. `platform-admin` does not auto-grant `admin` on every project, and project `admin` does not escalate to tenant-admin. The only automatic cross-axis grant is at project creation: the creator is added as `admin` of the new project.

The Keycloak shape per project is:

- One **resource** named `project:{projectId}`, of type `urn:agent-studio:resource-types:project`, URI `/projects/{projectId}`, scopes `admin`, `member`, `viewer`.
- One **user-based policy** per `(userId, projectId, scope)` — named `usr-{userId}-proj-{projectId}-{scope}`.
- One **scope permission** per `(projectId, scope)` — named `perm-proj-{projectId}-{scope}`. Decision strategy is `AFFIRMATIVE`: any one positive policy grants the scope.

The Keycloak client `agent-studio-svc-config` holds `manage-authorization` (on `realm-management`) and `uma_protection` (on `agent-studio-api`). Workflow-engine authenticates as this client to call the Admin Authorization API. The credentials are mounted from the Helm secret `keycloak-oidc-secrets` as `KEYCLOAK_AUTHZ_CLIENT_ID` / `KEYCLOAK_AUTHZ_CLIENT_SECRET`.

> Naming note: the platform design uses scope `user`. We renamed to `member` everywhere (realm JSON, activities, routes) because "user" was confusing alongside "userId" in the same APIs. Functionally it is the same persona.

## 5. What this PR implements

### 5.1 Bootstrap and realm config

- `agent-studio-realm.json` declares the project resource type, the three scopes, and the `agent-studio-svc-config` client with the right scope mappings.
- A bootstrap Job (`realm-bootstrap`) reconciles `authorizationSettings` on `agent-studio-api` after realm import, because nested `authorizationSettings` is not propagated by `kcadm update realms` (KEYCLOAK-19156).
- `keycloak-setup` patches the secret `keycloak-oidc-secrets` with the live `agent-studio-svc-config` client secret so workflow-engine can authenticate.

### 5.2 Keycloak client (`internal/clients/keycloak.go`)

A new `KeycloakAuthzClient` wraps the **Admin Authorization API** (`/admin/realms/{realm}/clients/{clientUUID}/authz/resource-server/...`). It covers:

- Resource CRUD (`CreateResource`, `GetResourceByName`, `DeleteResource`).
- Policy CRUD (`CreatePolicy`, `GetPolicyByName`, `ListPolicies`, `DeletePolicy`).
- Scope permission CRUD (`CreateScopePermission`, `GetScopePermission`, `UpdateScopePermission`, `DeletePermission`).
- A small internal token cache so we don't re-fetch the service-account access token on every call.

We initially used the Protection API for resource ops, but `agent-studio-svc-config` cannot call the Protection API (only the resource server itself can). Switching everything to the Admin Authz API removed an entire class of 403s and meant we only need one credential.

### 5.3 Activities (`internal/activities/keycloak_*.go`)

Thin wrappers around the client, wired as Temporal activities:

| Activity | What it does |
| -------- | ------------ |
| `RegisterProjectResourceActivity` | Create the `project:{projectId}` resource. Idempotent — 409 is success. |
| `DeleteProjectResourceActivity` | Best-effort cleanup of policies, permissions, and the resource. |
| `GrantProjectRoleActivity` | Create user policy; create-or-update scope permission to include it. |
| `RevokeProjectRoleActivity` | Remove user policy from the scope permission; delete the policy. |
| `GrantInitialAdminActivity` | Convenience for project init: grant the creator `admin` on the new project. |

### 5.4 Workflows (`internal/workflows/project_*.go`)

Project lifecycle workflows pick up new Keycloak steps:

- `ProjectInitWorkflow` now also: registers the project resource; persists the Keycloak resource ID; grants the creator `admin`.
- `ProjectDeleteWorkflow` adds a Step 5.5 between warehouse cleanup and bucket delete that removes the Keycloak resource and its associated policies/permissions. It is best-effort (warns on failure) so a stuck Keycloak does not block bucket cleanup.

Three new workflows handle membership mutations:

- `ProjectAddUserWorkflow` → `GrantProjectRoleActivity`.
- `ProjectRemoveUserWorkflow` → `RevokeProjectRoleActivity` (revokes all roles the user holds on the project).
- `ProjectChangeRoleWorkflow` → revoke old role, then grant new role.

All three are idempotent against retried executions and tolerate the obvious race conditions (policy already exists, permission missing, etc.).

### 5.5 HTTP routes

The membership API is split across two services along the natural seam:

| Method & path | Service | Why |
| ------------- | ------- | --- |
| `GET    /api/v1/projects/:projectId/members` | `config-service` (`routes/projectMembershipRoutes.ts`) | Pure Keycloak query, no Temporal |
| `GET    /api/v1/projects` (caller-scoped) | `config-service` (`routes/projectRoutes.ts`) | Caller's Keycloak memberships joined onto project metadata |
| `POST   /api/v1/projects/:projectId/members` | `workflow-engine` (`internal/server/routes/project_membership.go`) | Starts `ProjectAddUserWorkflow` (member by `email` in body; resolve-or-create) |
| `DELETE /api/v1/projects/:projectId/members` | `workflow-engine` | Starts `ProjectRemoveUserWorkflow` (member by `email` in body; 404 if unknown) |
| `PUT    /api/v1/projects/:projectId/members/role` | `workflow-engine` | Starts `ProjectChangeRoleWorkflow` (member by `email` in body; 404 if unknown) |

The API gateway proxies `/config/api/v1/*` to config-service and `/workflow/api/v1/*` to workflow-engine in the standard way, so callers reach the right handler without knowing the split.

Implementation details worth knowing:

- **Reads do not use a DB cache.** They query Keycloak's policy store directly (filter on the `usr-...-proj-...` naming convention) and return the parsed result. We considered shadowing membership in `config-service.projects_members` but decided against it for this PR — Keycloak already has the data, and a second store means consistency bugs. We can add a cache later behind a feature flag if read latency becomes a problem.
- **The reads in config-service share the parsing contract with workflow-engine.** `config-service/services/KeycloakAuthzClient.ts` mirrors `workflow-engine/internal/clients/keycloak.go::KeycloakAuthzClient` exactly — same OAuth2 client_credentials flow, same `agent-studio-svc-config` credentials (mounted optionally so charts without per-project authz still install), same `ListPolicies` query shape, same `parsePolicyName` semantics (the role is the segment after the *last* hyphen following `-proj-`, so UUIDs with hyphens parse correctly).
- **Writes are admin-gated.** `requireProjectAdmin` does a real Keycloak lookup for an `admin` policy bound to the caller and project. It does not just check "you are authenticated".
- **`GET /api/v1/projects` is caller-scoped** (it returns only the projects the authenticated caller is a member of, with their role). Membership comes from Keycloak (`usr-{callerSub}-proj-` prefix query); the project ids are then joined onto config-service's project metadata. This replaces the former `/users/:userId/projects` endpoint, which was an own-identity-only lookup (`callerSub === userId`, else 403) flagged in security review as an open enumeration surface — folding it into the metadata-bearing list endpoint removes that surface entirely (there is no `userId` path param to abuse).
- The Keycloak Authz client instance is process-wide and reused across requests in both services, so we don't burn a service-account token on every call.

### 5.6 Tests

- Unit tests for the Keycloak client (HTTP-level, table-driven).
- Workflow tests for add/remove/change-role idempotency and policy-name parsing.
- A live smoke test (`deployments/scripts/keycloak/per-project-smoke.sh`) that runs the full §5 lifecycle against a real Keycloak and asserts acceptance criteria A-1 through A-11.

## 6. What this PR does NOT do (and why)

The platform design (§8.3–§8.5) describes a fuller end-to-end story. The pieces listed below are intentionally **not** in this PR — they are larger surface-area changes that belong with the API gateway / NestJS work, and folding them into this PR would have made it un-reviewable.

| Deferred piece | Where it will live | Why deferred |
| -------------- | ------------------ | ------------ |
| Gateway UMA-ticket exchange and signed `x-agent-studio-context` envelope (§8.3, §6.3) | `apigateway-service` | Requires changes to gateway request pipeline + envelope signing key infra. Independent of writing the Keycloak data. |
| `PermissionsGuard` + `@ProjectScope` decorators on project-scoped controllers (§8.4) | NestJS services and Go services with project-scoped routes | Cannot meaningfully enforce per-project scopes downstream until the envelope exists. |
| RPT cache invalidation hook (`POST /internal/rpt-cache/invalidate`, §8.5) | Wired from membership mutation path → gateway | Only valuable once the gateway is caching RPTs. |
| Moving provisioning ownership to `config-service` | Future refactor if alignment with §8.2 is preferred | Behavior is equivalent; only the owning service differs. |

The current PR's enforcement story is therefore: **mutation endpoints are admin-gated using a live Keycloak query**, and downstream services do not yet enforce per-project scopes from a token. That is good enough to start exercising membership end-to-end and to unblock the gateway/envelope work, without claiming more than we have.

## 7. Operational notes

- `agent-studio-svc-config` credentials are sensitive (they can edit any policy/permission in the realm). They are mounted via the Helm secret `keycloak-oidc-secrets` and read by both workflow-engine (membership writes) and config-service (membership reads), which share the same client and parsing contract (see §5.5). Rotation is the standard Keycloak client-secret rotation flow.
- The `DeleteProjectResourceActivity` is best-effort: if Keycloak is partially down during project deletion, we log warnings and continue, so that the bucket / warehouse cleanup still happens. Reconciliation can be done by re-running the delete workflow.
- All log lines that include user-controlled strings (project IDs, user IDs, roles, error strings) are sanitized via `strconv.Quote` to avoid log-injection (CodeQL `go/log-injection`).

## 8. References

- Source of the model: [agent-studio-security-architecture.md](https://github.com/NetApp-Nemo/agent-studio/blob/feature/platform-designs/docs/platform-designs/agent-studio-security-architecture.md), especially §3.1 (clients, roles) and §8 (per-project authz, RPT, enforcement, cache invalidation).
- Realm JSON: `deployments/helm/identity/realms/agent-studio-realm.json`
- Keycloak client: `src/nemo/workflow-engine/internal/clients/keycloak.go`
- Activities: `src/nemo/workflow-engine/internal/activities/keycloak_project_resource.go`, `keycloak_membership.go`
- Workflows: `src/nemo/workflow-engine/internal/workflows/project_init.go`, `project_delete.go`, `project_membership.go`
- Routes (writes, workflow-engine): `src/nemo/workflow-engine/internal/server/routes/project_membership.go`
- Routes (reads, config-service): `src/nemo/config-service/routes/projectMembershipRoutes.ts`
- Keycloak authz client (config-service): `src/nemo/config-service/services/KeycloakAuthzClient.ts`
- Smoke test: `deployments/scripts/keycloak/per-project-smoke.sh`
