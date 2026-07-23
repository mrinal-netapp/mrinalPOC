# MAF → Config Service Migration: Analysis Report

**Scope.** Move MAF from filesystem-based agent configuration (`AGENT_TEAMS_DIR` / `AGENT_CONFIG_PATH`) to runtime fetches from the central config-service, using `agent-service` as the reference for *approach only* (lazy fetch, TTL cache, service-account auth). All existing MAF functionality must be preserved.

**Reference repos.**
- MAF: `src/nemo/agent-service-maf/src/agent_service_maf/`
- Reference (Agno): `AgentStudio/src/nemo/agent-service/src/`

---

## 1. Current MAF Configuration Pipeline

MAF runs an eager, 4-tier merge at process startup. There is no remote source.

**Discovery.** `core/team_loader.py::discover_team_config_paths()` reads `AGENT_TEAMS_DIR` (preferred, multi-team) or `AGENT_CONFIG_PATH` (single-file back-compat) and returns a list of `Path` objects on disk.

**Bundle build.** `core/team_loader.py::build_team_bundle(path)` runs once per file at startup:

1. `_read_team_id(path)` pre-parses the JSON to extract `_team_id`, `_team_name`, `_description`, `project_id` so even unhealthy bundles surface in `GET /agent-teams`.
2. `ConfigLoader(json_config_path=path).resolve()` → returns a frozen `AgentConfig` (`config/validators.py:1264`).
3. Constructs per-team runtime: `LLMGateway`, `MCPManager`, optional `GuardrailPipeline`, `SessionManager`, `TaskManager`.
4. Returns a `TeamBundle` (or an unhealthy bundle with `startup_error`).

**Registry.** `core/team_bundle.py::TeamRegistry` holds every bundle, indexed by `(project_id, team_id)`. The FastAPI lifespan (`interface_layer/api.py:127-292`) loads all teams, connects MCP servers (unless `mcp.lazy_connect=true`), starts task managers, then yields.

**Per-request merge.** `interface_layer/routes.py:705` calls `bundle.config_loader.resolve(request_overrides=...)` for every invoke. This re-merges defaults → env → JSON (cached) → request overrides through `ConfigLoader.resolve`, which is the single chokepoint for locked-field enforcement, secret-in-JSON detection, and Pydantic validation.

**Schema.** `AgentConfig` is the root model with sections: `agent`, `interface`, `gateway`, `guardrails`, `mcp`, `memory`, `tasks`, `logging`, `semantic_kernel` (`SKAgentDefinition`, `OrchestrationConfig`, `HandoffDefinition`, …). The JSON config files in `configs/team/*.json` are richly structured — far more than the flat agent dict in agent-service.

---

## 2. agent-service Reference Approach (Approach to Borrow)

The lessons to lift — and *only* these — are:

**`config.py::Settings`.** A single `Settings` object with `CONFIG_SERVICE_URL`, `CONFIG_CACHE_TTL`, `CONFIG_CACHE_MAX_SIZE`, Keycloak credentials. Read once from env at import.

**`service_auth.py::ServiceAccountClient`.** Keycloak client-credentials flow. Single `asyncio.Lock`-guarded token cache with 60 s safety window before expiry. `auth_headers()` returns `{"Authorization": "Bearer ..."}`.

**`config_cache.py::AgentConfigCache`.** Per-process `cachetools.TTLCache` keyed by `f"{project_id}:{agent_id}"` (and a parallel `_team_cache` keyed `f"{project_id}:{team_id}"`). On miss, calls `GET /api/v1/projects/{project_id}/agents/{agent_id}` (or `/agent-teams/{team_id}`), stores the JSON dict, returns it. Exposes `invalidate()` for explicit eviction and `status_snapshot()` for the periodic status reporter. Hit/miss counters and per-key access counts.

**Lazy fetch at request time.** No startup pull. `main.py:1203` (`invoke_agent`) calls `await config_cache.get(project_id, agent_id)` *inside the route handler*. Factories (`AgentFactory`, `TeamFactory`) receive the dict and construct the runtime per invocation. Teams recurse — `TeamFactory.create_from_config` fetches each sub-team or member via the same cache (`team_factory.py:57,64`).

**Sub-resource caches.** `model_resolver.py` adds a separate `model_info_cache` and `model_class_cache` against config-service's `/models` endpoints; `kb_retrieval.py` adds a KB-metadata cache. Each lookup goes through `_auth_headers()` so a single Keycloak token is reused.

What we are explicitly *not* taking: Agno-specific factories, the flat agent-config dict shape, the lack of locked-field / secret-in-file validation, the lack of env-var override merging.

---

## 3. Gap Analysis

| Dimension | MAF today | agent-service reference | Gap to close |
|---|---|---|---|
| **Source of truth** | JSON files in `configs/team/` | config-service REST | New `httpx` client + cache layer |
| **When loaded** | Eager, at process startup | Lazy, per request, TTL-cached | Restructure lifespan + add cache |
| **Schema** | `AgentConfig` (Pydantic, deep, locked fields) | Flat dict, no validation | Build adapter dict→AgentConfig; **keep** validators |
| **Auth** | None (local files) | Keycloak service account | Port `ServiceAccountClient` |
| **MCP servers** | `MCPManager` built once per team, lifespan connects | `MCPConnectionPool` with idle TTL, per-server | Decide: keep MAF's `MCPManager` per-bundle OR add a pool; recommend pool with `mcp.lazy_connect` semantics retained |
| **Gateway** | `LLMGateway(config.gateway)` per team | `LiteLLM` per agent | Keep MAF's `LLMGateway` per-team; resolve gateway settings from a top-level config service endpoint or static env (no per-team gateway in remote schema yet) |
| **Sessions / tasks** | `SessionManager`, `TaskManager` per team | Single redis-backed managers | Make managers process-singletons keyed by `(project_id, team_id)` to preserve isolation but avoid teardown on every request |
| **Per-request overrides** | `ConfigLoader.resolve(overrides)` with locked-field + secret checks | None | Keep `ConfigLoader.resolve` — feed it the remote payload as the JSON tier |
| **Team registry** | `TeamRegistry` populated at startup, drives `GET /agent-teams` | No registry | Either (a) list endpoint on config-service, or (b) lazy-populate registry as teams are first invoked and refresh on TTL |
| **Per-agent overrides** | `_override_applier.apply_per_agent_overrides` post-resolve | n/a | Preserve verbatim |
| **Validation surfacing** | `bundle.startup_error` on `GET /agent-teams` | Errors bubble at first invoke | Need a per-team validation result cached alongside the config dict |
| **Hot reload** | `ConfigLoader.reload_json()` clears the JSON cache | TTL expiry | TTL already covers it; expose `invalidate(project_id, team_id)` |

---

## 4. Functionality That Must Survive

The migration is not a rewrite. The following MAF behaviors are non-negotiable and must continue to work end-to-end after the switchover:

1. **3-tier merge** of defaults → env (`AGENT_*` with `__` nesting) → remote config → request overrides, evaluated in that exact precedence by `ConfigLoader.resolve`.
2. **Locked-field enforcement** (`agent.framework`, `interface.host`, `interface.port`, `project_id`) — request overrides rejected via `ConfigurationError`.
3. **Secret-in-config rejection** (`_check_secrets_in_json`) — any field ending `_key`, `_secret`, `_token` with a non-empty value in the remote payload must raise. Secrets stay in env.
4. **Pydantic schema validation** producing a frozen `AgentConfig` with every section: `agent`, `interface` (incl. `auth`, `streaming`), `gateway`, `guardrails` (rules + `tool_guardrails`), `mcp`, `memory`, `tasks`, `logging`, `semantic_kernel` (agents, orchestration, handoffs, selection/termination strategies, graph edges).
5. **`TeamBundle` shape** — every route handler reads `bundle.config`, `bundle.config_loader`, `bundle.gateway`, `bundle.mcp_manager`, `bundle.guardrails`, `bundle.session_manager`, `bundle.task_manager`. The bundle contract cannot change without a sweep through `routes.py`.
6. **Per-request overrides at `routes.py:705` and `:1422`** — `bundle.config_loader.resolve(request_overrides=...)` must still work. The loader cannot be eagerly resolved away; per-request invocation re-runs the merge with the latest cached remote payload.
7. **Per-agent overrides** via `_override_applier.apply_per_agent_overrides` for the `semantic_kernel.agents` list (it is not deep-mergeable).
8. **Unhealthy-team surfacing** in `GET /api/v1/projects/{project_id}/agent-teams` with `startup_error` populated. Includes the soft-fail `_validate_agent_output_schemas` path.
9. **`scoped_session_id`** — 5-segment `scope:project:anchor:user:session` key shape; required by the SessionManager Redis store.
10. **MCP lifecycle** — `mcp.lazy_connect=true` defers connect to first tool use; otherwise lifespan-time `connect_all()`. Shutdown must still tear down each `MCPManager`.
11. **TaskManager lifecycle** — `start()` at lifespan, `close()` at shutdown, per-bundle store with `effective_running_ttl = max(running_ttl_seconds, agent.timeout_seconds + 60)`.
12. **SessionManager / SummaryBuffer** — including the gateway-backed `summarize_fn` bounded by `summarizer_timeout_seconds`.
13. **Cross-project duplicate `team_id`** isolation via `TeamRegistry._by_project`; flat `teams[team_id]` is first-write-wins.
14. **`AGENT_DEFAULT_TEAM` env override** of `team_registry.default_team_id` and per-project default.
15. **Back-compat `app.state.{config,config_loader,gateway,mcp_manager,guardrails,session_manager}` shims** pointing at the default bundle.
16. **Logging contract** — every config load/cache event must continue to emit a structlog record with `team_id`, `project_id`, `path`/`url`, `error_type` on failure.
17. **All 31 team config fixtures in `configs/team/`** — these are also test fixtures referenced by `tests/`. We need a translation path or a fallback (see §6).

---

## 4a. Scope Boundary — Builder Free, Execution Unchanged

The migration may change anything in the **builder layer** — config source (file vs config-service), when bundles materialize (eager vs lazy), how an agent or team-of-agents is composed (inlined vs fanned out from agent records), the rules `_resolve_team` uses to map a URL to a bundle. The agent/team building module is the migration's actual scope and is expected to be rewritten.

What must remain identical is **agent-execution behavior**: everything that runs once a `TeamBundle` is in the executor's hands. The plan's "Execution-Behavior Invariants" table (24 items) is the authoritative no-touch list and covers `AgentExecutionContext` construction, the executor + adapters, `LLMGateway` calls, `MCPManager` tool dispatch, `SessionManager` / memory, `TaskManager` / async-invoke, guardrail pipeline, SSE / WebSocket protocols, auth middleware, error formatter, and lifecycle hooks. This analysis intentionally avoids prescribing any change downstream of `bundle.config`, `bundle.gateway`, `bundle.mcp_manager`, `bundle.guardrails`, `bundle.session_manager`, `bundle.task_manager`.

---

## 5. Recommended Architecture

The right shape mirrors agent-service's caching pattern but feeds it into MAF's `ConfigLoader` instead of bypassing it.

```
┌─────────────────────────────────────────────────────────────────┐
│  FastAPI lifespan (startup)                                     │
│    - ServiceAccountClient (Keycloak)                            │
│    - RemoteTeamConfigCache (TTL)                                │
│    - TeamRegistry — populated LAZILY on first invocation        │
│    - LLMGateway, MCPPool — process singletons                   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  Route handler (invoke / stream / submit)                       │
│    1. registry.get_or_load(project_id, team_id)                 │
│         └─► cache.get(pid, tid)                                 │
│              └─► fetch from config-service (miss)               │
│                  → translate remote dict → MAF JSON shape       │
│                  → ConfigLoader.resolve()  ← keeps locked-      │
│                                              field + secret +   │
│                                              env merging        │
│                  → build_team_bundle_from_resolved(...)         │
│    2. bundle.config_loader.resolve(request_overrides=...)       │
│    3. AgentExecutor.run(...)                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Why this shape.**

- The cache returns the *raw remote payload* (a JSON-like dict), not a built `TeamBundle`. The bundle is rebuilt only when the cached payload churns — TTL expiry, explicit invalidate, or a config-service push.
- `ConfigLoader` is unchanged; we just feed it a `dict` instead of a file path (one-line constructor change: accept `json_config_data: dict | None` alongside `json_config_path`).
- All MAF semantics — locked fields, secrets, env merge, per-request overrides — keep flowing through the same code path. No new validation surface.
- The `TeamBundle` keeps `gateway`, `mcp_manager`, `session_manager`, `task_manager` as today. Their lifecycle is the only piece that needs care: see §6.

---

## 6. Risks and Open Questions

**R1 — Schema mismatch.** The remote config-service today returns a flat agent dict (see `agent_factory.py` consumers: `modelId`, `modelAlias`, `temperature`, `maxTokens`, `mcpServerIds`, `knowledgeBaseIds`, `outcomeSchema`, …). MAF's JSON is the full nested `AgentConfig`. A translation layer is required. Either: (a) config-service grows a MAF-shaped endpoint, or (b) MAF owns a `RemoteToAgentConfigAdapter` that maps flat fields → nested sections. (b) is faster and decoupled.

**R2 — Long-lived resources on TTL bumps.** MCP connections, Redis pools, Kernel instances are expensive to rebuild. Strategy: scope these to the *team* (not per-request), key them by `(project_id, team_id, config_fingerprint)` where `config_fingerprint = sha256(canonical_remote_dict)`. Only rebuild when the fingerprint changes; the TTL refetch is cheap when the payload is unchanged.

**R3 — `GET /agent-teams` listing.** Today it iterates `TeamRegistry`. After migration there is no eager registry. Needs either a config-service `GET /api/v1/projects/{pid}/agent-teams` listing endpoint (preferred) or a "warm-on-demand" fallback where the registry surfaces only teams that have been invoked since startup.

**R4 — Cold start latency.** First invocation per team pays Keycloak + config-service + (optional) MCP connect. `mcp.lazy_connect=true` already covers MCP; add a `warm_teams` env list for known-hot teams to preload at lifespan.

**R5 — Network-partition fallback.** Config-service down should not break in-flight requests. Recommend: serve last-known-good from cache past TTL with a stale-while-error mode, and refuse new teams cold (503). Document this explicitly.

**R6 — Test fixtures.** `tests/` and Bruno suites rely on `configs/team/*.json`. The cleanest path is a `fake_config_service` test fixture that serves those JSON files over HTTP, so MAF code is exercised on the remote path while fixtures stay unchanged.

**R7 — Hot reload signal.** Today operators restart to reload. With a TTL we get reload-by-expiry; add `POST /admin/config/invalidate` (auth-gated) for forced invalidation, mirroring `AgentConfigCache.invalidate`.

---

## 7. Summary

The migration is mechanically straightforward because MAF's `ConfigLoader` already abstracts the JSON tier — swapping the *source* of that tier from disk to an HTTP cache is a localized change. The hard parts are not the loader: they are the **runtime resource lifecycle** (MCP, sessions, tasks) and the **schema translation** between the agent-service flat shape and MAF's nested `AgentConfig`. Both are addressable without touching `routes.py`, `executor.py`, or `validators.py`. See the companion `config-service-migration-plan.md` for the step-by-step plan.
