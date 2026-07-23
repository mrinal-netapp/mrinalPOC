# Bifrost LLM gateway

AgentStudio uses **Bifrost** as the sole LLM gateway. (Earlier revisions used a LiteLLM proxy with a `LiteLLMClient`; both have been removed.)

## Scope

### In scope (this migration)

- Replace the LiteLLM proxy with **Bifrost as the sole LLM gateway** across config-service, agent-service, workflow-engine, and the GUI. The old `LiteLLMClient` is removed; all DB / wire fields renamed to `llmproxyGateway*`.
- **Per-project Bifrost governance**: 1 AgentStudio project ↔ 1 Bifrost team (`as-proj-{projectId}`) ↔ 1 Bifrost virtual key (`as-proj-{projectId}-vk`). Created by `ensureProjectGateway` from `ProjectInitWorkflow` Step 0, with idempotent lazy self-heal on first model / MCP register.
- **Per-project Bifrost cleanup on project delete** via `teardownProjectGateway`, invoked as **Step 0 of `ProjectDeleteWorkflow`** (`TeardownProjectLLMGatewayActivity`) — symmetric counterpart of the create-side `SetupProjectLLMGatewayActivity`. Drops per-project models (routing rules + VK `provider_configs` entries), MCP servers (Bifrost MCP client + VK `mcp_configs` entries), the VK itself, the team, and the K8s Secret. The handler captures `projects.metadata._gateway` before kicking the workflow off and forwards it in the workflow input so Step 0 can still find the VK / team to drop even after the project row in config-service Postgres is gone. Each step is fault-isolated and 404-tolerant; Step 0 failures log + continue (the user has explicitly asked for the project to go away).
- **VK bearer token storage** in a K8s `Opaque` Secret (`as-proj-{projectId}-vk`, key `virtual_key_token`) as the sole AgentStudio-side home. Single read point at `readProjectVirtualKeyToken` so the storage backend can be swapped later without touching callers. **Not mirrored** into config-service Postgres; existing values are scrubbed at startup.
- **Model registration**: shared provider key per credential (`as-cred-{credentialId}`), team-scoped routing rule (`as-model-{modelId}`, CEL `request.model == "<bindingName>"`, `scope: team`), VK `provider_configs` binding.
- **MCP server registration**: Bifrost MCP client (`{projectId}_{userName}`), VK `mcp_configs` binding, header allowlist for downstream pass-through.
- **Agent inference** via Bifrost's OpenAI-compatible endpoint `POST {bifrost}/litellm/v1/chat/completions` carrying the project VK as bearer. (Agno's `agno.models.litellm.LiteLLM` class is used as a transport-only SDK; it is **not** a connection to a LiteLLM gateway.)
- **Helm chart** with optional in-cluster Bifrost (`bifrost.enabled=true`) and an `values-external-bifrost.yaml` overlay for pointing at an external Bifrost (the Azure dev deployment, today).
- **Admin proxy routes** (`/api/v1/gateway/*`, `/api/v1/governance/*`) for ops / UI access to Bifrost provider keys, models, virtual keys, MCP clients.
- **Naming conventions** for teams / VKs / provider keys / routing rules / MCP clients / gateway model ids (see _Unique naming conventions_ below).
- **CodeQL hardening** of the new code paths: log injection, header injection, clear-text logging, tainted format strings, remote property injection on dynamic deployment maps.

### Out of scope (deferred follow-ups)

| # | Item | Why deferred / planned shape |
|---|------|------------------------------|
| 1 | **K8s Secret → managed Key Vault migration** for the VK bearer (and existing per-credential secrets in `CredentialService`). | K8s Secrets are base64-encoded in `etcd` only. Target: Azure Key Vault on AKS, AWS Secrets Manager on EKS, GCP Secret Manager on GKE, mounted via the **Secret Store CSI driver**. Single swap point at `readProjectVirtualKeyToken` — everything upstream consumes a `string`. Once this lands, **project deletion will additionally drop the Key Vault entry** (a new sub-step of `TeardownProjectLLMGatewayActivity`'s final stage, replacing today's K8s `Secret` delete) and the **Secret Store CSI driver will unproject the corresponding mounted file from any consumer pod** (agent-service pods that had the project's VK as a CSI-projected volume) — same mechanism that handles rotation today, just with the value going from "new revision" to "absent". No pod restart, no Helm redeploy. |
| 2 | **VK key rotation** as a purely **schedule-driven Temporal workflow** (`ProjectVirtualKeyRotationWorkflow`, fired by a Temporal `Schedule` — no operator-initiated trigger). | Each rotation: create a replacement VK on the same team in Bifrost → write the new bearer to the project's **Key Vault entry** (stable URI, new version) → flip `projects.metadata._gateway` to the new VK id → grace-period sleep → delete the retired VK. **Agent pods consume the rotated token via the Secrets Store CSI driver**; agent-service **registers a callback hook with the secrets store library** (filesystem watcher on the projected mount, or the CSI driver's rotation-reconciler event) so it invalidates its in-memory `llmproxy_gateway_api_key_for_model` cache when the VK is rotated — no pod restart, no Helm redeploy. Activities are idempotent so Temporal retries are safe. See **Lifecycle: rotation** for the full activity breakdown. |
| 3 | **VK expiry policy** — set `expires_in` on `createVirtualKey`. | Blocked on (2); without rotation, expiring the VK would just break the project. |
| 4 | **agent-summarizer migration to per-project VK**. | The summarizer (`src/nemo/agent-service/src/summarizer.py`) still falls back to the cluster master key via `llmproxy_gateway_api_key()` when its caller doesn't supply one. The summarizer is invoked from agent runs where a project context is available, so threading the project VK through is straightforward — but it touches the agent-service Python side rather than config-service, so it's kept as its own PR. The playground (`POST /api/v1/projects/:projectId/models/:id/infer`) **was** in this row too but is now fixed: it loads the project VK via `readProjectVirtualKeyToken(projectId)` and passes it as a per-call `apiKey` override into `chatCompletion`. |
| 5 | **Cascade cleanup of `models` / `mcp_servers` Postgres rows** on project delete. | Bifrost side is now fully cleaned by `teardownProjectGateway` (invoked as `ProjectDeleteWorkflow` Step 0), but config-service Postgres rows that reference the deleted project still leak. Either add `ON DELETE CASCADE` to the FK, or iterate-and-drop in the project-delete route. |
| 6 | **Per-project budgets / rate limits / allowed-model lists** populated on the VK. | The team + VK plumbing exists in Bifrost (`spend_limit`, `rate_limit`, `allowed_models`); wiring product UI + defaults is a separate workstream. |
| 7 | **Cost / usage observability cutover** — Prometheus scrape config + Grafana dashboards + GUI cost-usage panels migrated from LiteLLM-Proxy metric series (`litellm_*`) to Bifrost's Prometheus surface, plus per-project aggregation in the AgentStudio UI (token spend, request counts, error rates). | Bifrost exports its own `/metrics` endpoint (request counts, latencies, per-virtual-key spend, per-model token counts) and the 1-project ↔ 1-VK mapping established in this PR makes the join from Bifrost's `virtual_key` label → AgentStudio `project_id` trivial — but **none of that is wired in this PR**. Today the legacy Prometheus job still targets the (now-deleted) LiteLLM-Proxy pod and the GUI cost-usage panels still reference `litellm_*` series, so cost dashboards will render empty until the follow-up lands. **Upcoming PR** covers: (a) Prometheus scrape config pointed at the Bifrost service, (b) Grafana dashboard JSON updates with the new metric names, (c) GUI cost-usage panels migrated to the new series, (d) a label-rewrite step that maps Bifrost's `virtual_key` label to AgentStudio's `project_id` for the dashboards. Scoped out of this PR so the gateway swap itself can ship without blocking on dashboard rewrites. |
| 8 | **Multi-region / HA Bifrost** — replicated Bifrost pods, HA Postgres `config_store`, leader election. | Today: single in-cluster Bifrost pod, or single external Bifrost endpoint. |
| 9 | **Audit log of governance mutations** (who created / rotated / deleted which VK, when). | Today only structured `console.log` in config-service; needs a real audit sink. |
| 10 | **Provider-key sharing across non-AgentStudio tenants** (e.g. another internal team registering models through the same Bifrost). | `as-cred-{credentialId}` is namespaced to AgentStudio; multi-tenant key sharing needs a tenancy model on top of Bifrost teams. |
| 11 | **Forward agent-service identity headers through Bifrost to downstream MCP servers** (`Authorization` JWT, `X-User-ID`, `X-Project-ID`, `X-Session-ID`, `X-Agent-ID`, `X-Team-ID`, and any operator-configured `extraHeaders` allowlist) so downstream MCP servers can use that context to enforce authorization. | **Most of the plumbing is already in place** (built in earlier work, not new in this PR): agent-service already injects all six identity headers via `mcp_pool._mcp_header_provider` (covered by `tests/test_mcp_pool_headers.py`); `MCPServer.extraHeaders` column + OpenAPI + validators accept the per-server allowlist; `platformMcpRoutes` and `internalMcpHealthRoutes` already pass `extra_headers` into `gateway.addMCPServer`. **But there's a silent gap in the middle**: `BifrostGatewayClient.buildMcpClientBody`, `BifrostGatewayClient.editMCPServer`, and `mcpServerRoutes.buildGatewayServerConfig` don't actually include `extra_headers` in the body that goes to Bifrost — so today the value is stored in Postgres but Bifrost is never told to forward it. **Upcoming PR** closes those three wiring gaps end-to-end and adds an assertion test that the Bifrost POST body actually contains the `extra_headers` list. Pure plumbing fix, no schema changes. |
| 12 | **UUID-based model routing on the wire** via per-model Bifrost routing rules (`POST /api/governance/routing-rules`, CEL `request.model == "<uuid>"`). | An earlier revision of this PR created one rule per registered model so callers could send the bare AgentStudio UUID; removed because neither agent-service nor the playground ever did — both send the provider-prefixed `gatewayModelId` (e.g. `azure/<binding>`) which Bifrost dispatches natively from the VK's `provider_configs`. The `routingRuleId` / `routingPriority` fields written into `rateCardOverride._gateway` metadata were never read back. Re-add the helpers in `bifrostOps.ts` (the removal rationale lives in the file's comment block) and re-wire `BifrostGatewayClient.addModel` / `deleteModel` if we ever need true UUID-based routing on the wire. |

> The detailed plans for items (1) and (2) live further down in **Storage** and **Lifecycle: rotation** respectively. Items (4)–(5) recur in inline notes against the code paths they affect.

## MCP (Agno `MCPTools`)

Bifrost exposes a single aggregated endpoint: `POST {LLM_GATEWAY_URL}/mcp`. Each MCP client is registered with `name` = DB field `llmproxyGatewayServerName`. Tools are prefixed `{clientName}_*`. Config-service `testMCPConnection` / `listMCPTools` use `POST /api/mcp/tool/execute` and `GET /api/mcp/clients`.

**config-service** registers remote MCP servers via `POST /api/mcp/client` with a body like:

```json
{
  "name": "<llmproxyGatewayServerName>",
  "connection_type": "sse",
  "connection_string": "https://example.com/sse",
  "headers": {},
  "tools_to_execute": ["*"],
  "tools_to_auto_execute": ["*"]
}
```

(`headers` is always sent — from UI **Static Headers** JSON and **Header Parameters** (literal or credential-backed); `auth_type: "headers"` is set when the merged map is non-empty. Credential auth only fills `Authorization` / `x-api-key` if those keys are not already set in the UI. When the wizard restricts tools, both lists use the same allowed set.) Then `POST /api/mcp/client/{id}/reconnect` and list via `GET /api/mcp/clients`. DB fields `llmproxyGatewayServerName` / `llmproxyGatewayServerId` hold the Bifrost client name and id.

### Dynamic model aliases

Implemented in **config-service** `BifrostGatewayClient`:

1. `PUT /api/providers/{provider}` — append provider key `as-{modelUuid}` with `models: [providerModelId]` (Nemo-branches onboarding pattern).
2. The model is bound to the project's virtual key via `assignModelToProjectVirtualKey` — appends `{provider, allowed_models: [gatewayBindingName], key_ids: [providerKeyId]}` to the VK's `provider_configs`.

Callers (agent-service, playground) always send the provider-prefixed `gatewayModelId` (e.g. `azure/<binding>`) on the wire; Bifrost dispatches that natively from the VK's `provider_configs`, so AgentStudio does not create per-model Bifrost routing rules. (An earlier revision did — `POST /api/governance/routing-rules` with CEL `request.model == "<uuid>"` to allow UUID-based dispatch — but the rules were write-only state never read back, since neither caller ever sent the bare UUID. Removed; see `bifrostOps.ts` for the rationale and the out-of-scope follow-up if we ever need true UUID routing.)

Gateway metadata is stored on the Model entity as `rateCardOverride._gateway` (`gatewayProvider`, `keyName`, `bifrostTeamId`, `bifrostVirtualKeyId`).

### Per-project Bifrost team + virtual key

#### Motivation

Pre-Bifrost, every AgentStudio LLM call used a single cluster-wide gateway key. That gave us no per-project attribution, no isolation, and no governance hook (budgets, rate limits, allowed-model lists, MCP allowlists). Mapping `1 AgentStudio project → 1 Bifrost team → 1 Bifrost virtual key` gives us all three for free, using Bifrost's native governance primitives.

#### Resources created per project

| Resource | Name | Lives in | Holds the bearer? |
|----------|------|----------|-------------------|
| Bifrost team | `as-proj-{projectId}` | Bifrost `config_store` Postgres | No |
| Bifrost virtual key (VK) | `as-proj-{projectId}-vk` (`team_id` bound) | Bifrost `config_store` Postgres | **Yes** (source of truth) |
| K8s Secret (VK bearer token) | `as-proj-{projectId}-vk`, key `virtual_key_token` | Shared application namespace | **Yes** (AgentStudio-side sole home) |
| Project metadata cache | `projects.metadata._gateway = { teamId, teamName, virtualKeyId, virtualKeyName }` | config-service Postgres | **No** (intentionally — see Storage below) |

Owning module: `src/nemo/config-service/services/bifrost/bifrostProjectGovernance.ts`.

#### Storage

- **Bifrost side**: team, VK, governance rules, provider keys, routing rules all live in Bifrost's own Postgres `config_store` (Helm-rendered from `deployments/helm/llm-gateway/charts/bifrost/templates/configmap.yaml`). Bifrost is the source of truth for the bearer token value; it's write-only via the API (`createVirtualKey` returns it once at creation, and there's no read-back).
- **AgentStudio side**:
  - **Sole home for the VK bearer token**: a K8s `Opaque` Secret named `as-proj-{projectId}-vk` in the shared application namespace, written by `K8sSecretService`. `readProjectVirtualKeyToken` reads only from here; if it's missing or unreadable, callers (`llmproxy_gateway_api_key_for_model` in agent-service) raise `MissingProjectVirtualKeyError` rather than silently degrading.
  - **Non-secret identifier cache**: `projects.metadata._gateway` in config-service Postgres holds `{teamId, teamName, virtualKeyId, virtualKeyName}` — used by `ensureProjectGateway` to short-circuit re-listing Bifrost on every call. **No bearer token, by design** — config-service Postgres does not have secret-grade RBAC / audit / encryption-at-rest controls. An earlier revision mirrored the token here as a fallback; that write path was removed and existing values are scrubbed at startup by `scrubProjectMetadataVirtualKeyToken` in `db/postgres.ts`.

> ⚠️ **K8s Secret is temporary.** Medium-term plan: move the VK bearer token (and existing per-credential secrets in `CredentialService`) into a managed Key Vault per cloud — Azure Key Vault on AKS, AWS Secrets Manager on EKS, GCP Secret Manager on GKE — surfaced via the Secret Store CSI driver. Drivers: K8s Secrets are only base64-encoded in `etcd`, vs Key Vault is encrypted-at-rest with managed keys + per-secret read audit logs in the cloud KMS + centralised rotation primitives. `readProjectVirtualKeyToken` is the **single swap point**; everything upstream of it consumes a `string`.

#### Lifecycle: creation

| Trigger | Path |
|---------|------|
| Project create | `POST /api/v1/projects` → `ProjectInitWorkflow` Step 0 → `SetupProjectLLMGatewayActivity` (Go) → config-service `POST /api/v1/internal/projects/:projectId/gateway-setup` → `ensureProjectGateway(projectId)` |
| Lazy self-heal | First `addModel` / `addMCPServer` also calls `ensureProjectGateway` so registration is not blocked if Step 0 hadn't completed; also re-creates if the cached ids point at a team/VK that was deleted out-of-band |

`ensureProjectGateway` is idempotent:
1. Verify cached ids against Bifrost (`getTeam`, `getVirtualKey`); short-circuit on cache hit.
2. Create team `as-proj-{projectId}` if missing.
3. Create virtual key `as-proj-{projectId}-vk` bound to that team if missing. Capture bearer token from the create response.
4. Persist bearer token to K8s Secret (create-then-update semantics, 409-tolerant).
5. Mirror `{teamId, virtualKeyId, virtualKeyName, virtualKeyToken?}` to `projects.metadata._gateway`.

Bifrost VK `PUT` is full-replace (not merge), so `mergePutVirtualKey` reads-then-writes to avoid dropping sibling fields (`team_id`, `provider_configs`, `mcp_configs`).

#### Lifecycle: usage (agent-service consumption)

- config-service `GET /models/:id` inlines the VK bearer as `gatewayApiKey` in the response body (sourced via `readProjectVirtualKeyToken(projectId)` which prefers the K8s Secret, falls back to the metadata mirror).
- agent-service `AgentFactory` builds the Agno model wrapper (`agno.models.litellm.LiteLLM` — the Python class name Agno gave it; this is a transport-only SDK that builds an OpenAI-compatible HTTP call to **Bifrost**, NOT a connection to a LiteLLM gateway, which we replaced with Bifrost) with `api_key = llmproxy_gateway_api_key_for_model(model_info)` — that helper returns the project VK token, or raises `MissingProjectVirtualKeyError` if absent (so a missing Secret surfaces loudly instead of silently bypassing team-scoped routing).
- Every agent chat completion goes to `POST {bifrost}/litellm/v1/chat/completions` with `Authorization: Bearer <project-vk>`. The path component `/litellm/v1` is **Bifrost's own endpoint name** for its OpenAI-compatible / LiteLLM-API-compatible shim — it is served by Bifrost, not by a LiteLLM proxy. Bifrost evaluates the matching routing rule + MCP config from THAT virtual key.

#### Lifecycle: rotation

**Not implemented today.** No expiry is set on the VK (`createVirtualKey` omits `expires_in`), so Bifrost holds the bearer forever until we explicitly rotate. Rotation depends on item (1) above (Key Vault migration); rotating into a K8s Secret only would not give us the audit / observation primitives we want from a managed secret store.

**Planned shape** (follow-up PR, lands together with — or just after — the Key Vault migration):

1. **Owner**: a new **Temporal scheduled workflow** `ProjectVirtualKeyRotationWorkflow`, registered on the existing workflow-engine worker. Driven entirely by a Temporal `Schedule` — either `@every 90d` per project, or a single fan-out schedule that iterates active projects and starts one workflow execution per project — which gives us retries, exactly-once semantics, and observable history out of the box. **No operator-initiated trigger**: rotation is purely schedule-driven so the cadence is auditable and uniform across projects, and no on-call human can accidentally rotate a busy project at a bad time.

2. **Workflow steps** (each step is its own Temporal activity so partial failures retry idempotently):
   1. `CreateReplacementVirtualKeyActivity` — call Bifrost `POST /api/governance/virtual-keys` for a new VK bound to the same team. New name suffixed with a rotation generation (`as-proj-{projectId}-vk-rN`). Capture the new bearer from the create response (single chance — Bifrost does not read back tokens).
   2. `WriteRotatedTokenToKeyVaultActivity` — write the new bearer into the **managed Key Vault** (Azure Key Vault / AWS Secrets Manager / GCP Secret Manager — same backend the Secret Store CSI driver mounts from after item (1) lands). The secret URI / name stays stable (`as-proj-{projectId}-vk`); only the **value version** changes. Cloud KMS audit log captures the write.
   3. `UpdateProjectGatewayMetadataActivity` — config-service `POST /api/v1/internal/projects/:projectId/gateway-vk-rotate-complete` updates `projects.metadata._gateway.virtualKeyId` / `virtualKeyName` to the new VK (the bearer itself stays out of Postgres, same rule as today).
   4. `WaitForGracePeriodActivity` — Temporal sleep (e.g. 30 min) so in-flight agent runs holding the old bearer can complete.
   5. `DeleteRetiredVirtualKeyActivity` — Bifrost `DELETE /api/governance/virtual-keys/{oldVkId}`.

3. **Propagation to agent pods** (Secret Store CSI driver):
   - Agent pods will mount the project VK as a CSI-projected file backed by the Key Vault entry. The **Secrets Store CSI driver** (with the `secrets-store-csi-driver-provider-{azure,aws,gcp}` provider) periodically syncs the mounted file when the backing Key Vault version changes — no pod restart, no Helm redeploy.
   - **agent-service registers a callback / reload hook** with the secrets-store sync mechanism so it re-reads the mounted token on rotation. Two viable implementations, decided when we cut the PR:
     - **Filesystem watcher** (`fsnotify` / `inotify`) on the projected secret file path — fires when the CSI driver atomically swaps the symlink to the new version. Simplest, no provider-specific API.
     - **CSI driver's native rotation-reconciler hook** (the driver exposes a `--enable-secret-rotation` mode plus a per-secret "synced" event); agent-service subscribes and invalidates its in-memory `llmproxy_gateway_api_key_for_model` cache for that project.
   - Either way, the contract for callers stays the same: `llmproxy_gateway_api_key_for_model(model_info)` returns the current token. The current-revision behavior (no caching beyond `ModelResolver` TTL) is a stop-gap; once rotation lands, the token will be cached in-process for performance and explicitly invalidated by the callback.

4. **Consumer impact**: zero for the user. The grace-period step plus the CSI-driven hot reload means in-flight chat completions finish on the old VK; new ones (after the symlink swap + callback) pick up the new VK. config-service's `GET /models/:id` continues to inline the current bearer at request time, so any caller that doesn't have the CSI mount still gets the right value.

5. **Failure handling**: every Temporal activity is idempotent — `CreateReplacementVirtualKeyActivity` checks for an in-flight rotation generation before creating a duplicate VK; `DeleteRetiredVirtualKeyActivity` is 404-tolerant; if a rotation aborts mid-flight, the next scheduled run re-converges.

`ensureProjectGateway`'s existing self-heal ("cached VK id no longer exists in Bifrost" → re-create) covers the worst case where state diverged across Bifrost / Key Vault / `projects.metadata._gateway`. The rotation workflow leans on the same primitive instead of building a parallel reconciler.

#### Lifecycle: deletion

**Symmetric with create.** Project team creation lives in `ProjectInitWorkflow` Step 0 (`SetupProjectLLMGatewayActivity` → config-service `POST /api/v1/internal/projects/:id/gateway-setup` → `ensureProjectGateway`). Project team deletion now lives in **`ProjectDeleteWorkflow` Step 0** (`TeardownProjectLLMGatewayActivity` → config-service `POST /api/v1/internal/projects/:id/gateway-teardown` → `teardownProjectGateway`) — same activity name suffix, same internal-route shape, same idempotency contract. There is no longer a synchronous Bifrost-teardown call in the DELETE route handler.

| Workflow step | What it cleans | Where the activity runs |
|---|---|---|
| **0** `TeardownProjectLLMGatewayActivity` *(new)* | Per-project Bifrost models (routing rules + VK `provider_configs` entries) → MCP servers (Bifrost MCP client + VK `mcp_configs` entries) → VK → team → VK K8s Secret | Calls back into config-service `POST /api/v1/internal/projects/:id/gateway-teardown` which runs `teardownProjectGateway` in-process |
| **1-5** Iceberg cleanup *(existing)* | Warehouse lookup → list namespaces → list+delete tables → delete namespaces → unregister warehouse | Lakekeeper |
| **6** `DeleteProjectCredentialSecretsActivity` *(existing)* | Per-credential K8s Secrets for the project | K8s API |
| **7** `DeleteBucketActivity` *(existing)* | S3 bucket | config-service → s3gateway |

**Race protection for the row deletion.** The DELETE route handler still drops the `projects` Postgres row synchronously (so the UI list updates immediately after the 204) — but BEFORE doing so it reads `projects.metadata._gateway` and forwards the cached `{teamId, virtualKeyId, teamName, virtualKeyName}` as `ProjectGatewayMeta` in the workflow input. Step 0 uses those preloaded ids rather than re-reading the (possibly-gone) row, so the Bifrost VK / team get dropped from `config_store` regardless of whether the workflow runs before, during, or after the row delete. The VK bearer **token** deliberately stays out of the workflow input — it lives only in the K8s Secret, and the gateway-teardown endpoint doesn't need it to drop the VK.

**Why Step 0 (vs the existing tail position).** Same reasoning as the create-side `SetupProjectLLMGatewayActivity`: Bifrost teardown is fast (~hundreds of ms) compared with the multi-minute Iceberg / S3 work, so failing fast saves retry budget. Failures at Step 0 are **logged + continue** (not fatal) — the user has explicitly asked for the project to go away, so a transient Bifrost outage shouldn't keep the project alive forever. Residual VK / team leaks in `config_store` are detected by `ensureProjectGateway`'s self-heal sweep on any project re-creation with the same id.

`teardownProjectGateway` is the in-process worker used by both call paths. Five steps, each fault-isolated (per-item failures log and continue):

1. **Per project model** → `gateway.deleteModel(...)` removes the routing rule (`as-model-{modelId}`), the VK `provider_configs` entry, and the entry in the shared `as-cred-{credentialId}` provider key's `models[]`. The provider key itself is **preserved** because the same credential may be in use by another project.
2. **Per project MCP server** → `gateway.removeMCPServer(...)` drops the Bifrost MCP client (`{projectId}_{name}`) and the VK `mcp_configs` entry.
3. `DELETE /api/governance/virtual-keys/{virtualKeyId}` — drops the project VK from Bifrost's `config_store`. 404-tolerant.
4. `DELETE /api/governance/teams/{teamId}` — drops the per-project governance team. 404-tolerant.
5. `K8sSecretService.deleteSecret(as-proj-{projectId}-vk)` — drops the K8s Secret holding the bearer. 404-tolerant.

Returned `ProjectGatewayTeardownResult` carries counts so the internal `gateway-teardown` route handler can log a single summary line per delete (`models=1/1 (0 failed), mcp_servers=1/1 (0 failed), vk=true team=true secret=true`), and the same result struct is returned as the activity response so it shows up in Temporal's workflow history.

##### Forward-looking: once we migrate from K8s Secret to managed Key Vault

The same `TeardownProjectLLMGatewayActivity` flow will continue to own the bearer-side cleanup, but **Step 5 changes** once item (1) in the top-level [Out of scope](#out-of-scope-deferred-follow-ups) table lands:

- **Today**: `K8sSecretService.deleteSecret(as-proj-{projectId}-vk)` deletes the K8s `Opaque` Secret.
- **After Key Vault migration**: an additional sub-step deletes the **Key Vault entry** (`SecretClient.deleteSecret("as-proj-{projectId}-vk")` against Azure Key Vault / AWS Secrets Manager / GCP Secret Manager). The cloud KMS audit log captures the delete with the workflow's identity, mirroring the create / rotate audit trail.
- **Pod-side propagation**: the **Secret Store CSI driver** (with `--enable-secret-rotation` enabled — the same configuration that picks up rotations) reconciles the deleted Key Vault entry by **unprojecting the mounted file from any consumer pod** that had the project's VK volume mounted (today: only agent-service pods that ran a workflow for this project). Same mechanism as the rotation path — just the value going from "new revision" to "absent" rather than "new revision". No pod restart, no Helm redeploy.
- **agent-service callback**: the same reload hook described in **Lifecycle: rotation** fires on the unmount event and invalidates the in-process `llmproxy_gateway_api_key_for_model` cache entry for the deleted project, so any leftover in-flight request fails fast with `MissingProjectVirtualKeyError` instead of using a stale token.
- Whether the K8s Secret delete is also kept (as a transitional belt-and-suspenders during the migration window) or replaced outright is decided when the Key Vault migration PR is cut. `readProjectVirtualKeyToken` is the single read-side swap point; the corresponding single write-side swap point (a `deleteProjectVirtualKeyTokenSecret` equivalent for the Key Vault) is the seam this section will edit.

#### Unique naming conventions

Bifrost has flat global namespaces for teams / VKs / MCP clients / routing rules. AgentStudio prefixes all of them to prevent cross-project collisions and to make ownership obvious in the Bifrost UI.

| What | Convention | Why |
|------|-----------|-----|
| Team | `as-proj-{projectId}` | 1 team per project |
| Virtual key | `as-proj-{projectId}-vk` | 1 VK per project, bound to the team |
| Provider key | `as-cred-{credentialId}` | One provider key per AgentStudio credential, shared across the projects that use that credential. Falls back to `as-{modelId}` for legacy one-key-per-model paths. |
| Routing rule | `as-model-{modelId}` | One rule per registered model, matched by CEL `request.model == "<gatewayBindingName>"` |
| Model id at Bifrost (`gatewayBindingName`) | `{projectId}__{credShort}__{providerModelId}` | Disambiguates two credentials in the same project registering the same upstream model. This is what the routing-rule CEL matches, and what the VK's `allowed_models` lists. |
| Gateway-ready model id (`gatewayModelId`) | `{bifrostProvider}/{gatewayBindingName}` | Provider prefix Bifrost requires on the wire; baked at registration time so playground / agent-service don't recompute. |
| MCP client name (`llmproxyGatewayServerName`) | `{projectId}_{userServerName}` | Bifrost MCP-client namespace is global; the project prefix prevents collisions. |
| K8s Secret (VK token) | `as-proj-{projectId}-vk`, key `virtual_key_token` | Mirrors the VK name for operator correlation |

#### How models / MCPs are assigned to the project VK

- **Model** (at `POST /api/v1/projects/:projectId/models`):
  1. `appendProviderKey` writes / updates the shared `as-cred-{credentialId}` provider key in Bifrost.
  2. `assignModelToProjectVirtualKey` appends `{provider, allowed_models: [bindingName], key_ids: [providerKeyId]}` to the VK's `provider_configs`. **Required** — Bifrost denies the call after authenticating the VK unless the model is listed there. This is the sole source of model→provider→key dispatch info on the Bifrost side; routing rules are not used (see note above).

- **MCP server** (at `POST /api/v1/projects/:projectId/mcp-servers`):
  1. `BifrostGatewayClient.addMCPServer` registers the MCP client at `POST /api/mcp/client` with `name = {projectId}_{userName}`, `allow_on_all_virtual_keys: false`, and the `extra_headers` allowlist for downstream header pass-through.
  2. `appendMcpClientToProjectVirtualKey` appends `{mcp_client_name, tools_to_execute}` to the VK's `mcp_configs`. Bifrost evaluates this list per-request to decide which MCP servers a VK can reach.

Routing scope: rules are `scope: team, scope_id: teamId`, so a request bearing project A's VK can never route to a model registered against project B's team, even if the routing CELs happened to overlap.

#### End-to-end sequence (textual)

```
Project create
   POST /api/v1/projects ───► ProjectInitWorkflow Step 0
                                  └─► SetupProjectLLMGatewayActivity (Go)
                                       └─► POST /api/v1/internal/projects/:id/gateway-setup (config-service)
                                            └─► ensureProjectGateway(projectId)
                                                ├─ POST /api/governance/teams         (Bifrost)
                                                ├─ POST /api/governance/virtual-keys  (Bifrost)
                                                ├─ K8sSecretService.createSecret      (K8s)
                                                └─ projects.metadata._gateway upsert  (config-service Postgres)

Model register
   POST /projects/:id/models ───► BifrostGatewayClient.addModel
                                       ├─ ensureProjectGateway (idempotent self-heal)
                                       ├─ appendProviderKey         (PUT /api/providers/{provider})
                                       └─ assignModelToProjectVirtualKey
                                              (PUT /api/governance/virtual-keys/{vk}, merge provider_configs)
                                       Note: no Bifrost routing rule is created; callers send the
                                       provider-prefixed gatewayModelId (e.g. azure/<binding>) and
                                       Bifrost dispatches from the VK's provider_configs.

MCP register
   POST /projects/:id/mcp-servers ─► BifrostGatewayClient.addMCPServer
                                       ├─ POST /api/mcp/client
                                       └─ appendMcpClientToProjectVirtualKey
                                              (PUT /api/governance/virtual-keys/{vk}, merge mcp_configs)

Agent run
   user prompt ─► agent-service
                    ├─ GET /models/:id           ─► gatewayApiKey = VK bearer (from K8s Secret)
                    ├─ AgentFactory builds Agno LiteLLM model
                    │       api_key  = llmproxy_gateway_api_key_for_model(model_info)
                    │       api_base = {bifrost}/litellm/v1
                    └─ Bifrost authenticates VK → matches team-scoped routing rule
                                                → uses as-cred-{credentialId}
                                                → calls upstream provider with user's API key

Project delete  (Bifrost teardown is Step 0 of ProjectDeleteWorkflow,
                  symmetric with Step 0 of ProjectInitWorkflow on the create side)
   DELETE /api/v1/projects/:id
       ├─ read project.metadata._gateway   (captured BEFORE row delete so
       │                                    workflow Step 0 has the VK/team
       │                                    ids even after the row is gone)
       ├─ ProjectDeleteService.deleteProject(projectId, homeDir, gatewayMeta)
       │     └─► ProjectDeleteWorkflow (Temporal, 8 steps)
       │           ├─ Step 0: TeardownProjectLLMGatewayActivity
       │           │     └─► POST /api/v1/internal/projects/:id/gateway-teardown
       │           │           └─► teardownProjectGateway(projectId, gateway, preloaded)
       │           │                 ├─ for each Model:   gateway.deleteModel(...)        (rule + VK entry + provider-key models[])
       │           │                 ├─ for each MCPServer: gateway.removeMCPServer(...)  (MCP client + VK mcp_configs entry)
       │           │                 ├─ DELETE /api/governance/virtual-keys/{vkId}        (Bifrost)
       │           │                 ├─ DELETE /api/governance/teams/{teamId}             (Bifrost)
       │           │                 └─ K8sSecretService.deleteSecret(as-proj-{id}-vk)    (K8s)
       │           ├─ Step 1: LookupWarehouseActivity         (Iceberg REST)
       │           ├─ Step 2: ListNamespaces / Tables         (Iceberg REST)
       │           ├─ Step 3: DeleteTablesActivity            (Iceberg REST)
       │           ├─ Step 4: DeleteNamespacesActivity        (Iceberg REST)
       │           ├─ Step 5: UnregisterWarehouseActivity     (Iceberg REST)
       │           ├─ Step 6: DeleteCredentialSecretsActivity (K8s)
       │           └─ Step 7: DeleteBucketActivity            (S3)
       ├─ removeForProject (reference edges)         (config-service Postgres)
       ├─ FacetService.deleteForProject              (config-service Postgres)
       └─ projectRepo.delete(projectId)              (config-service Postgres)
       => 204 No Content
```

#### Out of scope / follow-ups

> Consolidated in the top-level [Scope → Out of scope](#out-of-scope-deferred-follow-ups) table. The items most relevant to this section are (1) K8s Secret → Key Vault migration, (2) VK rotation, (3) VK expiry, (4) playground / summarizer migration to per-project VK, and (5) cascade cleanup of `models` / `mcp_servers` DB rows on project delete.

Admin proxy routes (optional UI / ops):

- `GET /api/v1/gateway/models` — flattened models from Bifrost provider keys (`?provider=azure`, `?include=routingRules`)
- `GET /api/v1/gateway/providers` — raw Bifrost provider/key payload
- `POST /api/v1/gateway/providers/:provider/keys`
- `DELETE /api/v1/gateway/providers/:provider/keys/:keyId`
- `GET|POST|PUT|DELETE /api/v1/governance/virtual-keys`, `model-configs`, etc.

Project-scoped models (config-service DB):

- `GET /api/v1/projects/:projectId/models` — registered models
- `POST /api/v1/projects/:projectId/models/list-available` — discover models from a provider using credentials

Playground / agent inference use Bifrost's OpenAI-compatible endpoint `POST /litellm/v1/chat/completions` with `model: <uuid>` when routing rules exist. (Bifrost names this path `/litellm/v1` because it is its LiteLLM-API-compatible shim — it is a Bifrost-native endpoint, not a LiteLLM dependency.)

### Provider name mapping

| AgentStudio `provider` | Bifrost provider |
|------------------------|------------------|
| `openai` | `openai` |
| `openai_compatible` | `openai` |
| `aws_bedrock` | `bedrock` |
| `azure` | `azure` |
| `google` | `gemini` |
| `local` | `ollama` (default) or `vllm` via env |

## Environment variables

| Variable | Description |
|----------|-------------|
| `LLM_GATEWAY_URL` | Bifrost base URL (no path suffix), e.g. `http://bifrost-proxy:8080` |
| `LLM_GATEWAY_API_KEY` | Bifrost auth token |

Agno's `agno.models.litellm.LiteLLM` class uses the upstream **litellm** Python package as a transport layer; requests go to `{LLM_GATEWAY_URL}/litellm/v1`, which is Bifrost's OpenAI-compatible shim endpoint (not a separate LiteLLM proxy).

### Helm install (values / --set)

```bash
make helm-services-upgrade-aks \
  --set bifrost.enabled=true \
  --set global.llmGateway.bifrost.url=http://bifrost-proxy:8080
```

When using an **external** Bifrost URL, set `bifrost.enabled=false` and pass `LLM_GATEWAY_URL` / `LLM_GATEWAY_API_KEY` via Helm env overrides. Use `values-external-bifrost.yaml` as a base overlay.

### Phase 1: Test against Azure Bifrost (before in-cluster pod)

Use the Azure gateway for all AgentStudio changes first; defer `bifrost.enabled=true` until this checklist passes.

**1. Smoke-test Azure Bifrost**

```bash
export BIFROST_URL=http://agent-studio-bifrost-dev.eastus2.cloudapp.azure.com
curl -sS "${BIFROST_URL}/health"
curl -sS "${BIFROST_URL}/api/governance/teams" | head -c 500
```

If governance returns 401, set `LLM_GATEWAY_API_KEY` to the key your Azure deployment expects (master / admin token).

**2. Local config-service → Azure (fastest UI path)**

```bash
./scripts/local-dev-bifrost.sh deps
./scripts/local-dev-bifrost.sh build-config
export BIFROST_URL=http://agent-studio-bifrost-dev.eastus2.cloudapp.azure.com
export BIFROST_API_KEY=   # if required
BIFROST_URL="${BIFROST_URL}" BIFROST_API_KEY="${BIFROST_API_KEY}" ./scripts/local-dev-bifrost.sh config-env
# paste exports, then:
./scripts/local-dev-bifrost.sh run-config
```

In another terminal, point the GUI at local config-service:

```bash
./scripts/local-dev-bifrost.sh deps
VITE_API_BASE_URL=http://localhost:3002/api/v1 \
  VITE_KEYCLOAK_ISSUER=https://auth.agentstudio.local:8443/realms/nemo \
  npm run dev --prefix src/nemo/gui
```

**3. What to verify in the UI**

| Action | Expected on Azure Bifrost |
|--------|-------------------------|
| Create project | Team `as-proj-{projectId}` + VK `as-proj-{projectId}-vk` in governance |
| Register model | Provider key `as-cred-{credentialId}`, team-scoped routing rule |
| Add remote MCP | MCP client `{projectId}_{name}`, entry on project VK `mcp_configs` |
| Model playground infer | `POST .../litellm/v1/chat/completions` with model UUID (Bifrost OpenAI-compatible endpoint) |
| Delete model / MCP | Routing rule / client removed; VK `mcp_configs` updated |

Check Azure Bifrost UI or API: `GET ${BIFROST_URL}/api/governance/teams`, routing-rules, `GET ${BIFROST_URL}/api/mcp/clients`.

**4. In-cluster apps on Azure (optional)**

Rebuild config-service image, then:

```bash
make helm-services-upgrade-aks \
  HELM_EXTRA_ARGS="--set global.llmGateway.bifrost.url=${BIFROST_URL} --set global.llmGateway.bifrost.apiKey=${BIFROST_API_KEY}"
```

Or patch running config-service:

```bash
kubectl set env deployment/config-service -n agentstudio \
  LLM_GATEWAY_URL="${BIFROST_URL}" \
  LLM_GATEWAY_API_KEY="${BIFROST_API_KEY}"
```

**5. After Azure tests pass**

We can add a proper in-cluster Bifrost chart (`config.json`, `config_store`, governance) so minikube does not depend on Azure.

### Local development (minikube deps + Azure Bifrost)

Use `scripts/local-dev-bifrost.sh` when you want to run the **GUI** or **config-service** on your machine while Postgres, Keycloak, and the API gateway stay in minikube.

| Mode | Command | What runs locally |
|------|---------|-------------------|
| Cluster UI only | Open `http://127.0.0.1:8080` | Nothing (fastest Bifrost UI test) |
| Local GUI | `./scripts/local-dev-bifrost.sh deps` then `run-gui` | Vite on `:3000` → gateway `:8080` |
| Local config-service | `deps` → `build-config` → `run-config` | Node on `:3002`, Bifrost env, DB via `:5432` |

**Local GUI login (same user as minikube):**

1. `./scripts/local-dev-bifrost.sh deps` (port-forward gateway `:8080` and `:8443`).
2. `/etc/hosts`: `127.0.0.1 auth.agentstudio.local agentstudio.local`
3. Open **https://auth.agentstudio.local:8443** once and accept the TLS cert (mkcert / cluster cert).
4. `./scripts/local-dev-bifrost.sh run-gui` (sets `VITE_KEYCLOAK_ISSUER` + `VITE_CONFIG_SERVICE_BASE_PATH=/config`).
5. Open **http://localhost:3000** → **Sign In** → Keycloak login with your **nemo realm** username/password (the user you already created in minikube).

Do **not** use Keycloak **master** admin (`admin` / `AgentstudioAdmin123!`) unless that account also exists in the **nemo** realm. Those credentials on the `/setup` page are only for the Keycloak Admin Console.

If redirect fails, add `http://localhost:3000/*` to client `agentstudio-gui` (usually already set by `keycloak-setup` job).

**Local config-service + GUI:** point Vite at local config (no gateway):

```bash
VITE_API_BASE_URL=http://localhost:3002/api/v1 VITE_KEYCLOAK_ISSUER=https://auth.agentstudio.local:8443/realms/nemo npm run dev
```

Requires `./scripts/local-dev-bifrost.sh deps` and `run-config` in another terminal.

## UI model screen (GUI) with Bifrost

The GUI does **not** call Bifrost directly. All flows go through config-service:

| UI screen / action | API | Bifrost involved? |
|--------------------|-----|-------------------|
| Project Models table | `GET /api/v1/projects/{projectId}/models` | No (Postgres only) |
| Register wizard — credentials | `credentialApi.*` | No |
| Register wizard — pick models | `POST .../models/list-available` | No (provider APIs) |
| Register wizard — credentials (step 1) | `credentialApi.create` + `validate` | No (stored in config DB; used for `list-available`) |
| Register wizard — model list (step 2) | `POST .../models/list-available` | No (calls Azure/provider API with credential) |
| Register wizard — submit (step 3) | `POST .../models` per selected model | Yes (`addModel` → Bifrost key `as-cred-{credentialId}` + routing rule per model UUID) |
| Delete model | `DELETE .../models/{id}` | Yes (remove routing rule + provider key) |
| Model Playground | `POST .../models/{id}/infer` | Yes (Bifrost `/litellm/v1/chat/completions` compat endpoint) |
| MCP server create/update/delete | `mcpServerRoutes`, `platformMcpRoutes`, `MCPRuntimeManager` | Yes (`/api/mcp/client*`) |
| MCP test / list tools / call tool | `POST/GET .../mcp-servers/{id}/*` | Yes (`/api/mcp/clients`, `/v1/mcp/tool/execute`) |
| Agent MCP tools | agent-service `mcp_pool` | Yes (aggregated `{gateway}/mcp`) |

**Deploy requirement:** config-service pods need `LLM_GATEWAY_URL` (and `LLM_GATEWAY_API_KEY` when required) before the UI can register/delete models or MCP servers.

**Legacy models** registered before Bifrost may lack routing rules. Playground tries model UUID first, then falls back to `{provider}/{providerModelId}` when Bifrost returns `provider is required`.

**New registrations** need the target provider (e.g. `azure`) configured on the Bifrost gateway.
