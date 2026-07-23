# MAF → Config Service Migration: Step-by-Step Plan

Companion to `config-service-migration-analysis.md`. This is the implementation playbook. Every step lists the exact file(s) touched and the contract change. The order is chosen so MAF stays runnable at every commit boundary.

---

## Scope Contract — Builder Free to Change, Execution Unchanged

The migration may change **anything in the builder layer** — how configs are sourced (file vs config-service), when bundles are constructed (eager vs lazy), how an agent or team-of-agents is composed (inlined vs fanned-out from agent records), what the `_resolve_team` policy is for `/agents/{aid}/invoke`, etc. None of this changes what a user *observes* when an agent runs.

What must remain identical is **agent-execution behavior**: the runtime contract between the built `TeamBundle` and everything downstream of it (routes, executor, adapters, gateway calls, MCP dispatch, sessions, tasks, guardrails, streaming, auth, error shape). The cut line is the `TeamBundle` boundary:

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│  FREE TO CHANGE (builder)   │     │  UNCHANGED (execution)      │
│                             │     │                             │
│  source flag → ConfigSource │     │  routes.py request handlers │
│  RemoteConfigCache /        │     │  AgentExecutionContext      │
│   FileConfigLoader          │ ──▶ │  AgentExecutor / adapters   │
│  composition helpers        │     │  Semantic-Kernel adapter    │
│  agent-record + team-blob   │     │  LLMGateway calls           │
│   fan-out / synthetic teams │     │  MCPManager tool dispatch   │
│  build_team_bundle_from_*   │     │  SessionManager / memory    │
│  LazyTeamRegistry           │     │  TaskManager / async invoke │
│  lifespan wiring            │     │  Guardrail pipeline         │
│  _resolve_team routing      │     │  Streaming SSE / WebSocket  │
│                             │     │  Auth, error shape, hooks   │
│  → produces a TeamBundle    │     │                             │
└─────────────────────────────┘     └─────────────────────────────┘
                                       ▲
                                       └─ consumes the TeamBundle exactly
                                          as it does today
```

### Execution-Behavior Invariants

These are the user-observable contracts that must hold after the migration. The *builder* (how the bundle gets constructed and from where) is free to change as needed; what runs once the bundle is built must produce the same outputs, latencies, error shapes, and side effects as today.

| # | Invariant | Where it lives | Why this migration preserves it |
|---|---|---|---|
| 1 | **`AgentExecutionContext` shape** — `config`, `gateway`, `mcp_registry`, `guardrails`, `session_manager`, `request_metadata`, `session_id`, `correlation_id`, `identity` | `core/context.py:44` | Constructed at `routes.py:735-745` from `bundle.*` fields. We keep the `TeamBundle` dataclass shape; the constructor call is byte-identical. |
| 2 | **`AgentConfig` Pydantic model and frozen invariant** | `config/validators.py:1264` | Untouched. Composition produces a MAF-shaped dict; `ConfigLoader.resolve` still validates it through `AgentConfig`. |
| 3 | **3-tier merge precedence** defaults → env → JSON/remote → request overrides | `config/config_loader.py:198-266` | Only the *source* of the JSON tier changes (file → cached remote dict). Merge order, locked-field check, secret check, Pydantic validation are the same code path. |
| 4 | **Per-request override application** at `routes.py:705 / 1422` | `bundle.config_loader.resolve(request_overrides=…)` | Same call site, same loader instance, same merge. |
| 5 | **`apply_per_agent_overrides`** for `semantic_kernel.agents[]` | `config/_override_applier.py` | Called immediately after `resolve()` exactly as today. |
| 6 | **Locked fields** — `agent.framework`, `interface.host`, `interface.port`, `project_id` | `config/config_loader.py:_check_locked_fields` | Same enforcement; the cached remote payload goes through the same loader. |
| 7 | **Secret-in-config rejection** for any field ending `_key` / `_secret` / `_token` | `config/config_loader.py:_check_secrets_in_json` | Runs against the remote dict via the new `json_config_data` kwarg (Step 2.1) — same regex, same exception. |
| 8 | **Adapter contract** — `SemanticKernelAdapter.stream(request, context)` | `framework/semantic_kernel/adapter.py:400` | Not touched. |
| 9 | **`AgentExecutor.stream/execute`** | `framework/executor.py:45,207` | Not touched. |
| 10 | **`LLMGateway` request/response contract**, retries, model routing | `gateway/llm_gateway.py`, `gateway/http_llm_client.py` | One gateway per bundle as today. Migration produces the same `bundle.gateway` instance via the same `LLMGateway(config.gateway)` call. |
| 11 | **`MCPManager` tool dispatch + `mcp.lazy_connect` semantics** | `mcp/mcp_manager.py`, `interface_layer/api.py:206-244` | One manager per bundle. Lifespan still calls `connect_all()` (or defers via `lazy_connect`) for any bundle materialized through `LazyTeamRegistry._post_build_lifecycle`. |
| 12 | **`SessionManager` Redis-backed store**, summary buffer, `summarize_fn` ceiling | `core/session.py`, `core/team_loader.py:354-510` (`_build_session_manager`, `_build_summarize_fn`) | Same builder function called by `_build_bundle_common`. |
| 13 | **`scoped_session_id`** — 5-segment `scope:project:anchor:user:session` shape | `core/team_bundle.py:84-165` | Method untouched. Synthetic single-agent bundles use `scope="agent"` so the anchor is `agent_id` (not the synthetic `_agent_{aid}_` team_id) — session keys are bit-identical to today. |
| 14 | **`TaskManager` lifecycle** — `effective_running_ttl = max(running_ttl, agent.timeout + 60)`, `start()` / `close()` at lifespan boundaries | `core/team_loader.py:513-556`, `interface_layer/api.py:246-260` | Same `_build_task_manager` called from `_build_bundle_common`. Lifespan iterates `team_registry.all_bundles()` for start/stop — `LazyTeamRegistry` delegates to `_inner.all_bundles()` so only materialized bundles are touched. |
| 15 | **Guardrail pipeline** — input / output / tool checks, `fail_open`, `tool_guardrails` | `guardrails/registry.py`, `core/team_loader.py:306-310` | Same `GuardrailRegistry.build_pipeline(config.guardrails)` call. |
| 16 | **Output-schema soft validation** — `_validate_agent_output_schemas` populates `bundle.startup_error` | `core/team_loader.py:161-215` | Same call from `_build_bundle_common`. Runs for both team and synthetic-single-agent bundles. |
| 17 | **Streaming (SSE)** delimiter format, event types | `interface_layer/routes.py:819-892`, `framework/executor.py:207` | Not touched. |
| 18 | **WebSocket** wire protocol | `interface_layer/protocols/` | Not touched. |
| 19 | **Auth middleware** — `AgentAuthMiddleware`, identity binding | `interface_layer/auth.py` | Not touched. |
| 20 | **Lifecycle hooks** — `FrameworkRegistry.run_startup_hooks` / `run_shutdown_hooks` | `framework/registry.py`, `interface_layer/api.py:282` | Still invoked in the lifespan. |
| 21 | **Error response shape** — `SafeErrorFormatter`, `AgentFrameworkError` mapping | `interface_layer/error_formatter.py` | Not touched. |
| 22 | **Shutdown teardown order** — task → session → MCP → gateway | `interface_layer/api.py:298-340` | Unchanged. Uses `team_registry.all_bundles()` (lazy registry exposes the same via `_inner`). |
| 23 | **`AGENT_DEFAULT_TEAM` env override** | `interface_layer/api.py:190-203` | Preserved — still sets `team_registry.default_team_id` and per-project default after bundles are populated (or materialized on first warm-up). |
| 24 | **`app.state.{config, config_loader, gateway, mcp_manager, guardrails, session_manager}` back-compat shims** | `interface_layer/api.py:266-279` | Preserved — populated from the first materialized bundle (or `None` until one exists, same as today when no teams load). |

### Agent-vs-Team Building Policy (builder concern, not execution)

`POST /projects/{pid}/agents/{aid}/invoke` (no `team_id`) is served by fetching the standalone agent record from config-service and wrapping it in a synthetic single-agent bundle (`team_id = _agent_{aid}_`, `orchestration.type = "single"`). This matches the agent-service shape — agent records are first-class config-service entities and the natural source of truth for an agent-only invoke.

Why this is allowed: choosing *which* config payload to build into a `TeamBundle` is a **builder concern**, not an execution one. Once the bundle exists, the executor, adapters, gateway, MCP dispatch, sessions, tasks, guardrails, streaming, and error shape are bit-identical regardless of whether the bundle came from a team blob or a synthetic single-agent wrap (every item in the invariants table holds either way).

`POST /projects/{pid}/agent-teams/{tid}/invoke` continues to fetch the team blob, fan out to fetch each member agent, splice them into `semantic_kernel.agents[]`, and build the bundle exactly as before — just composed from agent records instead of read from a single inlined file.

`POST /projects/{pid}/agent-teams/{tid}/agents/{aid}/invoke` (team-scoped agent) continues to resolve the team bundle and pick the named agent from inside its `semantic_kernel.agents[]`. The agent's runtime behavior is identical whether it's invoked solo or via a team route — same model, same instructions, same MCP servers, same output schema — because the agent record is the single source of truth.

### What "Builder Only" Buys Us

- **Zero test changes for execution paths.** All existing executor / adapter / gateway / MCP / session / task / guardrail / streaming tests pass unmodified — they exercise an already-built `TeamBundle`.
- **The audit surface is small.** Only `config/`, `core/team_loader.py`, `core/team_bundle.py` (no shape change), `interface_layer/api.py` lifespan, and the `_resolve_team` helper in `interface_layer/routes.py`. Everything else is untouched.

---

## Phase 0 — Prerequisites

- Confirm config-service exposes both endpoints — same shape as agent-service consumes today:
  - `GET /api/v1/projects/{pid}/agents/{aid}` — standalone **agent record** (model, instructions, MCP refs, output_schema, temperature, etc.).
  - `GET /api/v1/projects/{pid}/agent-teams/{tid}` — **team record** containing a `members[]` list of agent IDs (plus orchestration, manager, memory).
- Confirm Keycloak realm + client credentials for MAF (mirror `KEYCLOAK_*` env names from agent-service).
- Confirm `cachetools` is acceptable as a new dependency (already used by agent-service).

**Two granularities supported.** MAF exposes both agent-level and team-level invocation today:

- `POST /projects/{pid}/agents/{aid}/invoke` — direct agent invoke. Backed by a config-service **agent record**.
- `POST /projects/{pid}/agent-teams/{tid}/invoke` — team invoke. Backed by a config-service **team record** that references agent IDs; the loader fans out and fetches each member agent independently.
- `POST /projects/{pid}/agent-teams/{tid}/agents/{aid}/invoke` — team-scoped agent invoke. Resolves the team, then picks the named agent.

The migration must preserve all three. Internally, MAF still wraps an agent into a `TeamBundle` (synthetic single-agent team) so the rest of the runtime — `LLMGateway`, `MCPManager`, `SessionManager`, `TaskManager`, guardrails — keeps its current contract unchanged. The two-cache layout below is what makes that possible.

**Files added later in the plan:**
```
src/agent_service_maf/config/
    settings.py               # new — env-backed Settings object
    service_auth.py           # new — Keycloak client-credentials
    remote_loader.py          # new — HTTP + TTL cache (CONFIG_SOURCE=remote)
    file_loader.py            # new — lazy file source (CONFIG_SOURCE=file)
    remote_adapter.py         # new — only if config-service stays flat
src/agent_service_maf/core/
    team_registry_lazy.py     # new — lazy TeamRegistry layer
```

**Files modified:**
```
src/agent_service_maf/config/config_loader.py    # accept dict payload tier
src/agent_service_maf/config/__init__.py         # export RemoteConfigCache
src/agent_service_maf/core/team_loader.py        # add build_team_bundle_from_dict
src/agent_service_maf/interface_layer/api.py     # lifespan rewrite
src/agent_service_maf/interface_layer/routes.py  # _resolve_team → lazy
pyproject.toml                                  # add cachetools
.env.example                                    # document new env keys
```

---

## Phase 1 — Settings & Auth (no behavior change)

### Step 1.1 — Add config-service env keys to `Settings`

Add to MAF's existing config module (or create `config/settings.py` if absent — MAF reads env directly today, so a thin wrapper similar to `agent-service/src/config.py` is appropriate):

```python
# src/agent_service_maf/config/settings.py  (new)
import os
from typing import Literal

ConfigSource = Literal["remote", "file"]

class Settings:
    # --- feature flag: which source of truth is active ---
    # "remote" = config-service over HTTP (production default once rolled out)
    # "file"   = local configs/team/*.json (legacy + testing escape hatch)
    CONFIG_SOURCE: ConfigSource = os.getenv("CONFIG_SOURCE", "remote").lower()  # type: ignore[assignment]

    # --- remote source ---
    CONFIG_SERVICE_URL: str = os.getenv("CONFIG_SERVICE_URL", "")
    CONFIG_CACHE_TTL: int = int(os.getenv("CONFIG_CACHE_TTL", "60"))
    CONFIG_CACHE_MAX_SIZE: int = int(os.getenv("CONFIG_CACHE_MAX_SIZE", "1000"))
    CONFIG_HTTP_TIMEOUT: float = float(os.getenv("CONFIG_HTTP_TIMEOUT", "10"))
    KEYCLOAK_INTERNAL_ISSUER: str = os.getenv("KEYCLOAK_INTERNAL_ISSUER", "")
    KEYCLOAK_CLIENT_ID: str = os.getenv("KEYCLOAK_CLIENT_ID", "")
    KEYCLOAK_CLIENT_SECRET: str = os.getenv("KEYCLOAK_CLIENT_SECRET", "")

    # --- file source (legacy + tests) ---
    # AGENT_TEAMS_DIR / AGENT_CONFIG_PATH are read by team_loader as today.

    # Optional comma-separated list of "project_id/team_id" pairs to pre-warm
    # at startup. Useful when MCP must be connected before the first request.
    # When empty (default), no teams are pre-loaded — pure lazy.
    AGENT_WARM_TEAMS: str = os.getenv("AGENT_WARM_TEAMS", "")

    # Derived
    @property
    def remote_enabled(self) -> bool:
        return self.CONFIG_SOURCE == "remote" and bool(self.CONFIG_SERVICE_URL)

settings = Settings()
```

**Feature-flag behavior.**

| `CONFIG_SOURCE` | Behavior |
|---|---|
| `remote` (default) | agent-service-style: empty registry at startup; fetch from config-service + build on first request; TTL refresh. |
| `file` | Same lazy semantics, but the source is `configs/team/*.json` on disk. Testing escape hatch — switch a single env back to local files without code changes if config-service is unhealthy or a test suite needs reproducible fixtures. |

Lazy loading is always on. The only knob beyond the source flag is `AGENT_WARM_TEAMS` for opt-in pre-warming of known-hot teams. Document all keys in `.env.example`.

### Step 1.2 — Port `ServiceAccountClient`

Copy `agent-service/src/service_auth.py` into `agent_service_maf/config/service_auth.py`. Rename logger, replace `logging` with `structlog.get_logger(__name__)` to match MAF conventions. No logic changes.

**Contract.** `ServiceAccountClient(issuer, client_id, client_secret).auth_headers() -> dict[str, str]` — async, lock-guarded, 60 s safety window.

---

## Phase 2 — Remote Loader & Cache

### Step 2.1 — Generalize `ConfigLoader` to accept a dict payload

`config/config_loader.py` currently reads a file. Add a second path that accepts the already-fetched dict:

```python
class ConfigLoader:
    def __init__(
        self,
        json_config_path: str | Path | None = None,
        env_prefix: str = "AGENT_",
        *,
        json_config_data: dict[str, Any] | None = None,   # new
    ) -> None:
        ...
        self._json_data_override = json_config_data

    def _load_from_json(self) -> dict[str, Any]:
        if self._json_data_override is not None:
            # Already in memory — run the same secret check, return.
            _check_secrets_in_json(self._json_data_override)
            return self._json_data_override
        # ... existing file-path logic unchanged
```

This is the only change to `ConfigLoader`. Locked-field enforcement, env merging, Pydantic validation are untouched. **All MAF tests for `ConfigLoader` keep passing.**

### Step 2.2 — Build `RemoteConfigCache` (two granularities)

Mirror the agent-service split: an agent cache keyed by `(project_id, agent_id)` plus a team cache keyed by `(project_id, team_id)`. Both share auth, HTTP client, and metrics.

```python
# src/agent_service_maf/config/remote_loader.py  (new)
import httpx
import structlog
from cachetools import TTLCache
from agent_service_maf.config.service_auth import ServiceAccountClient
from agent_service_maf.config.settings import settings

logger = structlog.get_logger(__name__)


class RemoteConfigCache:
    """TTL-cached fetcher for MAF agent + team configs from config-service.

    Returns raw dict payloads — NOT TeamBundles, NOT AgentConfigs. Callers
    still run the *composed* result through ConfigLoader.resolve() to get
    the locked-field / secret / env-merge / Pydantic-validation semantics.
    """

    def __init__(self, *, auth: ServiceAccountClient, ttl: int, max_size: int) -> None:
        # Two parallel caches, same TTL — matches agent-service's pattern of
        # an agent cache and a team cache living side by side
        # (agent-service config_cache.py:24,34).
        self._agent_cache: TTLCache = TTLCache(maxsize=max_size, ttl=ttl)
        self._team_cache: TTLCache = TTLCache(maxsize=max_size, ttl=ttl)
        self._listing_cache: TTLCache = TTLCache(maxsize=max_size, ttl=ttl)
        self._auth = auth
        self._url = settings.CONFIG_SERVICE_URL.rstrip("/")
        self._timeout = settings.CONFIG_HTTP_TIMEOUT
        self._hits = 0
        self._misses = 0

    # --- agents -----------------------------------------------------------

    async def get_agent(self, project_id: str, agent_id: str) -> dict:
        """Fetch a standalone agent record. Used directly by
        /projects/{pid}/agents/{aid}/invoke and recursively by get_team
        to resolve member agents.
        """
        key = f"agent:{project_id}:{agent_id}"
        if key in self._agent_cache:
            self._hits += 1
            return self._agent_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agents/{agent_id}"
        payload = await self._fetch_json(url)
        self._agent_cache[key] = payload
        return payload

    async def list_agents(self, project_id: str) -> list[dict]:
        cache_key = f"agents:{project_id}"
        if cache_key in self._listing_cache:
            return self._listing_cache[cache_key]
        url = f"{self._url}/api/v1/projects/{project_id}/agents"
        data = await self._fetch_json(url)
        self._listing_cache[cache_key] = data
        return data

    # --- teams ------------------------------------------------------------

    async def get_team(self, project_id: str, team_id: str) -> dict:
        """Fetch a team record. The returned dict's members[] holds agent
        IDs only — composition is done in build_team_bundle_from_team_blob
        (Step 3.1) which fans out to get_agent for each member.
        """
        key = f"team:{project_id}:{team_id}"
        if key in self._team_cache:
            self._hits += 1
            return self._team_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agent-teams/{team_id}"
        payload = await self._fetch_json(url)
        self._team_cache[key] = payload
        return payload

    async def list_teams(self, project_id: str) -> list[dict]:
        cache_key = f"teams:{project_id}"
        if cache_key in self._listing_cache:
            return self._listing_cache[cache_key]
        url = f"{self._url}/api/v1/projects/{project_id}/agent-teams"
        data = await self._fetch_json(url)
        self._listing_cache[cache_key] = data
        return data

    # --- shared -----------------------------------------------------------

    async def _fetch_json(self, url: str) -> dict | list:
        headers = await self._auth.auth_headers()
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()

    def invalidate_agent(self, project_id: str, agent_id: str | None = None) -> None:
        if agent_id:
            self._agent_cache.pop(f"agent:{project_id}:{agent_id}", None)
        else:
            for k in [k for k in self._agent_cache if k.startswith(f"agent:{project_id}:")]:
                self._agent_cache.pop(k, None)
            self._listing_cache.pop(f"agents:{project_id}", None)
        # Team blobs reference agents; invalidate them too so the next team
        # load re-composes with fresh agent data.
        self.invalidate_team(project_id)

    def invalidate_team(self, project_id: str, team_id: str | None = None) -> None:
        if team_id:
            self._team_cache.pop(f"team:{project_id}:{team_id}", None)
        else:
            for k in [k for k in self._team_cache if k.startswith(f"team:{project_id}:")]:
                self._team_cache.pop(k, None)
            self._listing_cache.pop(f"teams:{project_id}", None)

    def status_snapshot(self) -> dict:
        total = self._hits + self._misses
        return {
            "agents": len(self._agent_cache),
            "teams": len(self._team_cache),
            "max": self._agent_cache.maxsize,
            "ttl": self._agent_cache.ttl,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate_pct": round((self._hits / total * 100) if total else 0.0, 1),
        }
```

Pattern matches `agent-service/src/config_cache.py` exactly: agent cache `get()` + team cache `get_team()` (lines 36, 79), with team invalidation triggered by agent invalidation since teams embed their member references.

### Step 2.3 — Optional adapter (only if config-service stays flat-shaped)

If config-service returns the agent-service flat dict shape, add `config/remote_adapter.py` with a single function:

```python
def adapt_remote_to_maf_config(remote: dict) -> dict:
    """Map flat config-service payload → MAF nested JSON shape.

    Output passes through ConfigLoader → AgentConfig validation unchanged.
    """
    # Map modelId/modelAlias/temperature/maxTokens → agent.* and gateway.default_model
    # Map mcpServerIds + _resolvedMCPServers → mcp.servers / semantic_kernel.agents[*].mcp_servers
    # Map outcomeSchema → semantic_kernel.agents[*].output_schema
    # Map manager{} + members[] → semantic_kernel.agents + orchestration
    # Map memoryConfig → memory section
    # Map guardrails → guardrails section
    # Preserve project_id at the top level
    ...
```

This is the single most labor-intensive piece if it's needed. **Recommend lobbying for a MAF-shaped endpoint on config-service** to skip it entirely.

---

## Phase 3 — TeamBundle Construction & Lazy Registry

The lazy registry is **source-agnostic** — it works for both `remote` and `file` modes. The only difference is what the `loader_fn` callback returns.

### Step 3.1 — Composition: agent records + team record → MAF config dict

`team_loader.py` gains two new entry points that share the post-load work (gateway, MCP, guardrails, sessions, tasks) with today's `build_team_bundle`:

```python
async def build_team_bundle_from_team_blob(
    *,
    team_id: str,
    project_id: str,
    name: str,
    description: str,
    team_payload: dict,                      # config-service team record
    agent_resolver: AgentResolver,           # async (pid, aid) -> dict
    source_ref: str,
) -> TeamBundle:
    """Compose a MAF team config from a config-service team record by
    fanning out to fetch each member agent independently.

    Mirrors agent-service/src/team_factory.py:51-66 — iterate members[],
    pull each agent's full config, splice into the resulting MAF JSON.
    """
    member_refs = team_payload.get("members", [])
    agent_dicts: list[dict] = []
    for member in member_refs:
        if member.get("memberType", "agent") != "agent":
            # Sub-team support is out of scope for MAF MVP; surface as
            # bundle.startup_error if encountered.
            continue
        aid = member.get("memberId") or member.get("agentId")
        if not aid:
            continue
        agent_record = await agent_resolver(project_id, aid)
        agent_dicts.append(_agent_record_to_sk_agent(agent_record, member))

    # Splice the resolved agent list into the MAF-shaped payload that
    # ConfigLoader expects. semantic_kernel.agents[] is the inlined form
    # MAF validators require; we build it from the agent records here.
    maf_payload = _team_blob_to_maf_payload(team_payload, agent_dicts)
    return await _build_bundle_common(
        team_id=team_id, project_id=project_id, name=name,
        description=description, payload=maf_payload, source_ref=source_ref,
    )


async def build_team_bundle_from_agent(
    *,
    project_id: str,
    agent_id: str,
    agent_payload: dict,                     # config-service agent record
    source_ref: str,
) -> TeamBundle:
    """Wrap a standalone agent in a synthetic single-agent TeamBundle so
    the runtime (gateway, MCP, sessions, tasks, guardrails) keeps its
    current TeamBundle-centric contract.

    Used by /projects/{pid}/agents/{aid}/invoke when no team is named.
    The synthetic team uses orchestration.type='single' and team_id =
    f'_agent_{agent_id}_' for registry indexing.
    """
    sk_agent = _agent_record_to_sk_agent(agent_payload, member_overrides=None)
    maf_payload = _synthetic_single_agent_team(
        project_id=project_id, agent_id=agent_id,
        agent_dict=sk_agent, source=agent_payload,
    )
    return await _build_bundle_common(
        team_id=f"_agent_{agent_id}_",
        project_id=project_id,
        name=agent_payload.get("name", agent_id),
        description=agent_payload.get("description", ""),
        payload=maf_payload,
        source_ref=source_ref,
    )


async def _build_bundle_common(
    *, team_id, project_id, name, description, payload, source_ref,
) -> TeamBundle:
    """Shared tail: ConfigLoader → AgentConfig → gateway / MCP /
    guardrails / session / task construction. Identical to today's
    build_team_bundle from the ConfigLoader call onward (team_loader.py:262
    through 351).
    """
    try:
        loader = ConfigLoader(json_config_data=payload)   # ← uses Step 2.1
        config = loader.resolve()
    except Exception as exc:
        return _unhealthy_bundle(
            team_id, project_id, name, description, source_ref,
            f"{type(exc).__name__}: {exc}",
        )
    # ... rest is identical to today's build_team_bundle from line 297 onward:
    #     LLMGateway, MCPManager, guardrails, SessionManager, TaskManager,
    #     _validate_agent_output_schemas, return TeamBundle(...)
```

**Two small helper functions own the schema translation:**

```python
def _agent_record_to_sk_agent(
    agent_record: dict, member_overrides: dict | None,
) -> dict:
    """Map a config-service agent record → MAF semantic_kernel.agents[] entry.

    Pulls instructions, model, temperature, max_tokens, mcp_servers,
    output_schema, function_choice_behavior. Applies any per-member
    overrides (role, description) the team blob supplies.
    """
    ...

def _team_blob_to_maf_payload(
    team_blob: dict, agent_dicts: list[dict],
) -> dict:
    """Compose the full MAF JSON: top-level project_id, agent, gateway,
    guardrails, mcp, memory, tasks, logging, semantic_kernel.agents[],
    orchestration. Manager/orchestration/memory map directly from the
    team blob fields (manager.modelId, orchestrationPolicy, memoryConfig).
    """
    ...

def _synthetic_single_agent_team(
    *, project_id: str, agent_id: str, agent_dict: dict, source: dict,
) -> dict:
    """Wrap one agent in a single-agent team payload. orchestration.type
    is 'single', no manager, gateway/memory inherited from the agent
    record or from defaults.
    """
    ...
```

These helpers are the *only* schema-translation surface in the migration — the rest of MAF stays MAF-shaped. Existing `build_team_bundle(path)` is refactored to read JSON from disk into a MAF-shaped dict (today's behavior — file already has inlined agents) and call `_build_bundle_common` directly, no composition needed. The file path stays simple.

### Step 3.2 — Lazy `TeamRegistry` (supports both granularities)

`LazyTeamRegistry` builds bundles on first access from either a team-id or an agent-id. The source provides four callbacks — `get_team`, `get_agent`, `list_teams`, `list_agents` — so remote and file modes plug in interchangeably.

```python
class ConfigSource(Protocol):
    async def get_team(self, project_id: str, team_id: str) -> dict | None: ...
    async def get_agent(self, project_id: str, agent_id: str) -> dict | None: ...
    async def list_teams(self, project_id: str) -> list[dict]: ...
    async def list_agents(self, project_id: str) -> list[dict]: ...


class LazyTeamRegistry:
    """Builds TeamBundles on first access from a config source.

    Two entry points mirror MAF's two invocation granularities:
      - get_or_load_team(pid, tid)  — fans out to fetch member agents
      - get_or_load_agent(pid, aid) — wraps in a synthetic single-agent team
    """

    def __init__(self, *, source: ConfigSource) -> None:
        self._inner = TeamRegistry()
        self._source = source
        self._locks: dict[str, asyncio.Lock] = {}

    async def get_or_load_team(
        self, project_id: str, team_id: str,
    ) -> TeamBundle | None:
        existing = self._inner.get_in_project(project_id, team_id)
        if existing and existing.healthy:
            return existing
        key = f"team:{project_id}:{team_id}"
        async with self._locks.setdefault(key, asyncio.Lock()):
            existing = self._inner.get_in_project(project_id, team_id)
            if existing and existing.healthy:
                return existing
            team_payload = await self._safe_fetch(
                self._source.get_team, project_id, team_id,
            )
            if team_payload is None:
                return None
            bundle = await build_team_bundle_from_team_blob(
                team_id=team_id,
                project_id=project_id,
                name=team_payload.get("name", team_id),
                description=team_payload.get("description", ""),
                team_payload=team_payload,
                agent_resolver=self._source.get_agent,
                source_ref=f"{settings.CONFIG_SOURCE}:team/{project_id}/{team_id}",
            )
            await self._post_build_lifecycle(bundle)
            self._inner.add(bundle)
            return bundle

    async def get_or_load_agent(
        self, project_id: str, agent_id: str,
    ) -> TeamBundle | None:
        """Resolve a standalone agent invocation. Materializes a synthetic
        single-agent TeamBundle indexed under team_id=f'_agent_{aid}_' so
        all downstream code (routes, session manager, MCP) is unchanged.
        """
        synthetic_team_id = f"_agent_{agent_id}_"
        existing = self._inner.get_in_project(project_id, synthetic_team_id)
        if existing and existing.healthy:
            return existing
        key = f"agent:{project_id}:{agent_id}"
        async with self._locks.setdefault(key, asyncio.Lock()):
            existing = self._inner.get_in_project(project_id, synthetic_team_id)
            if existing and existing.healthy:
                return existing
            agent_payload = await self._safe_fetch(
                self._source.get_agent, project_id, agent_id,
            )
            if agent_payload is None:
                return None
            bundle = await build_team_bundle_from_agent(
                project_id=project_id,
                agent_id=agent_id,
                agent_payload=agent_payload,
                source_ref=f"{settings.CONFIG_SOURCE}:agent/{project_id}/{agent_id}",
            )
            await self._post_build_lifecycle(bundle)
            self._inner.add(bundle)
            return bundle

    async def list_teams_for_project(self, project_id: str) -> list[TeamBundle]:
        summaries = await self._source.list_teams(project_id)
        return [b for s in summaries
                if (b := await self.get_or_load_team(project_id, s["id"]))]

    async def list_agents_for_project(self, project_id: str) -> list[TeamBundle]:
        summaries = await self._source.list_agents(project_id)
        return [b for s in summaries
                if (b := await self.get_or_load_agent(project_id, s["id"]))]

    async def _safe_fetch(self, fn, project_id, entity_id):
        try:
            return await fn(project_id, entity_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            raise

    def evict_team(self, project_id: str, team_id: str | None = None) -> None: ...
    def evict_agent(self, project_id: str, agent_id: str | None = None) -> None: ...
```

### Step 3.3 — File-source loader (testing escape hatch)

`FileConfigLoader` implements the same four-method `ConfigSource` protocol so it's a drop-in for `RemoteConfigCache`. It scans two directories — `configs/team/` for team blobs and `configs/agents/` for agent records (mirroring config-service's two endpoints):

```python
# src/agent_service_maf/config/file_loader.py  (new)
class FileConfigLoader:
    """Lazy file-backed ConfigSource.

    Honors AGENT_TEAMS_DIR (and a new AGENT_AGENTS_DIR) so the 31 team
    fixtures + per-agent fixtures continue to work without modification.
    Today's team JSON has agents inlined under semantic_kernel.agents[];
    in file mode we keep that shape — the FileConfigLoader returns the
    team payload as-is and a parallel agents dir is only needed for
    standalone /agents/{aid}/invoke testing.
    """

    def __init__(self) -> None:
        self._teams_by_key: dict[tuple[str, str], Path] = {}
        self._agents_by_key: dict[tuple[str, str], Path] = {}
        self._team_summaries: dict[str, list[dict]] = {}
        self._agent_summaries: dict[str, list[dict]] = {}
        self._scan()

    def _scan(self) -> None:
        for path in discover_team_config_paths():           # AGENT_TEAMS_DIR
            tid, name, desc, pid = _read_team_id(path)
            self._teams_by_key[(pid, tid)] = path
            self._team_summaries.setdefault(pid, []).append(
                {"id": tid, "name": name, "description": desc}
            )
        for path in discover_agent_config_paths():          # AGENT_AGENTS_DIR (new)
            aid, name, desc, pid = _read_agent_header(path)
            self._agents_by_key[(pid, aid)] = path
            self._agent_summaries.setdefault(pid, []).append(
                {"id": aid, "name": name, "description": desc}
            )

    async def get_team(self, project_id, team_id):
        p = self._teams_by_key.get((project_id, team_id))
        return json.loads(p.read_text(encoding="utf-8")) if p else None

    async def get_agent(self, project_id, agent_id):
        p = self._agents_by_key.get((project_id, agent_id))
        return json.loads(p.read_text(encoding="utf-8")) if p else None

    async def list_teams(self, project_id):
        return list(self._team_summaries.get(project_id, []))

    async def list_agents(self, project_id):
        return list(self._agent_summaries.get(project_id, []))
```

**Back-compat for today's team JSONs.** Existing `configs/team/*.json` files have agents inlined under `semantic_kernel.agents[]`. `build_team_bundle_from_team_blob` detects whether `members[]` (composition required) or `semantic_kernel.agents[]` (inlined, today's MAF shape) is present and routes accordingly — so the 31 existing fixtures keep working byte-for-byte in file mode.

Lifespan wiring stays one line:

```python
source: ConfigSource = RemoteConfigCache(...) if settings.remote_enabled else FileConfigLoader()
registry = LazyTeamRegistry(source=source)
```

Existing `TeamRegistry` methods (`get`, `default`, `all_bundles`, `set_project_default`) remain available via `self._inner` for back-compat with shutdown code and `app.state` shims.

---

## Phase 4 — Lifespan Rewrite

Edit `interface_layer/api.py::lifespan` to branch only on the source flag — registry is always lazy:

```python
# AFTER
if settings.remote_enabled:
    service_auth = ServiceAccountClient(
        issuer=settings.KEYCLOAK_INTERNAL_ISSUER,
        client_id=settings.KEYCLOAK_CLIENT_ID,
        client_secret=settings.KEYCLOAK_CLIENT_SECRET,
    )
    loader = RemoteConfigCache(
        auth=service_auth,
        ttl=settings.CONFIG_CACHE_TTL,
        max_size=settings.CONFIG_CACHE_MAX_SIZE,
    )
    app.state.service_auth = service_auth
else:
    loader = FileConfigLoader()

app.state.config_loader_source = loader  # remote or file

# Always lazy. Empty registry at startup; first request triggers fetch+build.
team_registry = LazyTeamRegistry(
    loader_fn=loader.get_team,
    lister_fn=loader.list_teams,
)

# Optional warm-up for known-hot teams (MCP connected at startup).
warm = [s.strip() for s in settings.AGENT_WARM_TEAMS.split(",") if s.strip()]
for entry in warm:
    pid, _, tid = entry.partition("/")
    if pid and tid:
        await team_registry.get_or_load(pid, tid)

app.state.teams = team_registry
```

**Test mode example.** A pytest fixture sets:
```bash
CONFIG_SOURCE=file
AGENT_TEAMS_DIR=configs/team
```
The lifespan uses `FileConfigLoader`; teams materialize on first invocation from the JSON fixtures. No network calls, fully reproducible. Existing test assertions that expect "all teams visible on `GET /agent-teams` before first invoke" should call `list_for_project` (which is what the route already does — it iterates the loader's `list_teams` and materializes each).

**Shutdown path is unchanged** — it iterates `team_registry.all_bundles()` and calls `task_manager.close()`, `session_manager.stop()`, `mcp_manager.disconnect_all()`, `gateway.close()`. For the lazy registry, delegate to `self._inner.all_bundles()` so only bundles that were actually materialized get torn down.

---

## Phase 5 — Route Wiring

`interface_layer/routes.py:_resolve_team` becomes async-aware **and** branches on whether the request names a team, a standalone agent, or only a project (project-default team):

```python
async def _resolve_team(
    request, project_id, team_id, *, agent_id: str | None = None, scope: str = "team",
) -> TeamBundle:
    teams = request.app.state.teams
    if not isinstance(teams, LazyTeamRegistry):
        # File+eager legacy path (only used if someone re-enables it).
        return _resolve_team_eager(teams, project_id, team_id)

    if team_id:
        # Explicit team route — fetch the team blob, fan out to agent records.
        # Agent-id (if present) is resolved from bundle.config.semantic_kernel.agents[]
        # downstream by the executor — same as today.
        bundle = await teams.get_or_load_team(project_id, team_id)
    elif scope == "agent" and agent_id:
        # /projects/{pid}/agents/{aid}/invoke without a team — fetch the
        # standalone agent record from config-service and wrap in a synthetic
        # single-agent team. This is a *builder* choice; execution behavior
        # (gateway, MCP, sessions, tasks, guardrails) is identical to a
        # one-agent team loaded from a JSON file today.
        bundle = await teams.get_or_load_agent(project_id, agent_id)
    else:
        # /projects/{pid}/agents/invoke — project default team.
        default_tid = _project_default(teams, project_id)
        bundle = await teams.get_or_load_team(project_id, default_tid) if default_tid else None

    if bundle is None:
        raise HTTPException(404, "agent or team not found")
    if not bundle.healthy:
        raise HTTPException(503, bundle.startup_error)
    return bundle
```

Each existing `_resolve_team(...)` call site adds `scope` + `agent_id` from the route signature it already accepts. The 5-tuple is already plumbed through `_invoke_impl` and `_stream_impl` (`routes.py:920, 1084, 1192, 1214`), so this is purely a wiring change.

The per-request override path at line 705 / 1422 is **unchanged**:

```python
base_config = bundle.config_loader.resolve(request_overrides=request_overrides_dict or None)
```

This still runs the locked-field check, the secret check on the cached payload, the env merge, and the Pydantic validation — regardless of whether the bundle came from a team blob or a synthetic single-agent wrap.

---

## Phase 6 — Listings & Admin

### Step 6.1 — `GET /api/v1/projects/{pid}/agent-teams`

Today this iterates `TeamRegistry.teams_for_project(pid)`. For the lazy mode, call `LazyTeamRegistry.list_teams_for_project(pid)` which fetches the config-service team listing and materializes each entry. Continue to call `bundle.to_public_dict()` for the response shape (no API change).

### Step 6.2 — `GET /api/v1/projects/{pid}/agents` (new, optional)

If MAF needs to expose a project-wide agent listing (matching agent-service's surface), add a route backed by `LazyTeamRegistry.list_agents_for_project(pid)`. Each entry is the synthetic single-agent bundle's `to_public_dict()`.

### Step 6.3 — Invalidation endpoint

Add `POST /api/v1/admin/config/invalidate` (auth-gated, internal use). Mirrors agent-service's two-cache invalidation:

```python
@router.post("/admin/config/invalidate")
async def invalidate_config(
    project_id: str,
    team_id: str | None = None,
    agent_id: str | None = None,
    request: Request,
):
    source = request.app.state.config_loader_source
    teams = request.app.state.teams
    if agent_id:
        source.invalidate_agent(project_id, agent_id)
        if isinstance(teams, LazyTeamRegistry):
            teams.evict_agent(project_id, agent_id)
    if team_id:
        source.invalidate_team(project_id, team_id)
        if isinstance(teams, LazyTeamRegistry):
            teams.evict_team(project_id, team_id)
    return {"invalidated": {"project_id": project_id, "team_id": team_id, "agent_id": agent_id}}
```

Invalidating an agent also invalidates every team that may reference it — `RemoteConfigCache.invalidate_agent` already cascades to the team cache (see Step 2.2), so a stale agent record never lingers inside a previously-composed team bundle.

---

## Phase 7 — Testing

1. **`ConfigLoader` dict path** — feed a dict via `json_config_data=` and confirm: env merge still applies; secrets in dict are rejected; locked fields in `request_overrides` are rejected. Reuse fixtures from `configs/team/`.
2. **`RemoteConfigCache` agent + team caches** — `httpx.MockTransport` assertions for both `get_agent` and `get_team`: TTL semantics, 404 propagation, hit/miss counters, single-flight via `LazyTeamRegistry` lock, agent invalidation cascading to team cache.
3. **Composition** — `build_team_bundle_from_team_blob` with a synthetic team blob whose `members[]` references three agents; assert exactly three `get_agent` calls (with TTL coalescing across teams that share members), and the resulting `bundle.config.semantic_kernel.agents` has all three entries.
4. **Synthetic single-agent bundle** — `build_team_bundle_from_agent`; assert `bundle.config.semantic_kernel.orchestration.type == "single"` and route handlers can invoke it as if it were a one-agent team.
5. **Integration** — fake config-service fixture serving fixtures from `configs/team/` and `configs/agents/` over HTTP. Run the full route-level test matrix: agent invoke, team invoke, team-scoped agent invoke.
6. **Failure modes** — config-service 503, Keycloak token expiry mid-request, malformed agent record, member agent 404 (must surface as `bundle.startup_error`, not crash the request).
7. **Source flag toggle** — `CONFIG_SOURCE=file` exercises `FileConfigLoader`; `CONFIG_SOURCE=remote` exercises `RemoteConfigCache`; both produce identical `TeamBundle` shapes for both granularities (regression gate).

---

## Phase 8 — Rollout

1. **Deploy with `CONFIG_SOURCE=file`.** Lazy loading against the local JSON fixtures. Validates the lazy code path against known-good data, no network dependency.
2. **Flip to `CONFIG_SOURCE=remote`** in a canary env with `AGENT_WARM_TEAMS=` listing canary teams. Compare `/agent-teams` and a known invoke against the file baseline.
3. Watch `RemoteConfigCache.status_snapshot()` hit rate, cold-start latency, auth-token refresh counters. Target: >95% hit rate at steady state.
4. Roll to all envs. **Keep `CONFIG_SOURCE=file` as a permanently supported test/debug mode** — do not remove the file path or its loader. The `configs/team/*.json` fixtures stay in the repo for tests and CI; they only need to leave the container image once we're confident no production env relies on them.

---

## What Is Explicitly Not Changing

See the **Execution-Behavior Invariants** table at the top of this document for the authoritative list (24 items). Summary:

- `ConfigLoader.resolve` precedence and validation behavior.
- `AgentConfig` and every section model in `validators.py`.
- `TeamBundle` dataclass shape and `scoped_session_id` semantics.
- `AgentExecutionContext` construction at `routes.py:735-745`.
- `AgentExecutor`, `SemanticKernelAdapter`, and every other adapter — zero changes.
- `LLMGateway`, `MCPManager`, `SessionManager`, `TaskManager`, `GuardrailPipeline` — same constructors, same lifecycle.
- Per-request override application at `routes.py:705 / 1422`.
- `_override_applier.apply_per_agent_overrides`.
- `AGENT_*` env-var convention.
- `AGENT_DEFAULT_TEAM` override.
- `app.state.{config, config_loader, gateway, mcp_manager, guardrails, session_manager}` back-compat shims.
- SSE streaming format, WebSocket wire protocol, auth middleware, error formatting, lifecycle hooks.

---

## File-Touch Summary

| File | Action | Risk |
|---|---|---|
| `config/settings.py` | **new** | Low |
| `config/service_auth.py` | **new** (port from agent-service) | Low |
| `config/remote_loader.py` | **new** | Low |
| `config/file_loader.py` | **new** (lazy file source for tests) | Low |
| `config/remote_adapter.py` | **new** (conditional on §R1) | Med |
| `config/config_loader.py` | Add `json_config_data` kwarg | Low — covered by existing tests |
| `config/__init__.py` | Export new symbols | Trivial |
| `core/team_loader.py` | Add `build_team_bundle_from_team_blob` + `build_team_bundle_from_agent` + composition helpers | Med — schema-translation surface |
| `core/team_registry_lazy.py` | **new** | Med |
| `interface_layer/api.py` | Lifespan branches on `CONFIG_SOURCE` | Med |
| `interface_layer/routes.py` | `_resolve_team` becomes async | Low — mechanical |
| `pyproject.toml` | Add `cachetools` | Trivial |
| `.env.example` | Document new keys | Trivial |
| `tests/` | Add HTTP-backed fixtures | Med |

**Estimated effort.** 7–10 engineering days. The agent+team composition layer (Step 3.1 helpers + tests) is the largest single piece — roughly 2–3 days. The remote-adapter (`remote_adapter.py`) becomes unnecessary if config-service exposes the agent record in MAF-compatible field shapes (model id, instructions, temperature, max_tokens, mcp refs, output_schema) — confirm at Phase 0.
