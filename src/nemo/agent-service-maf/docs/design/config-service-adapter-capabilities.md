# MAF config-service adapter — capability matrix

Snapshot of which knobs flow from the AgentStudio config service into MAF
through `src/agent_service_maf/config/remote_adapter.py`, and what we've
verified end-to-end against the `maf-fixtures` project (`projs19sngp2`,
`http://host.docker.internal:18081`).

**Last refreshed:** 2026-05-30 against
`maf-fixtures` (15 teams / 19 agents / 1 MCP server / 1 KB).
Includes the MCP-server-id resolution and KB → `kb_retrieve` binding
synthesis (commit-pending).

**Test coverage:** `tests/unit/test_config_service_migration.py`
(currently 54 tests, all passing) — plus the broader unit + integration
sweep at 2100+ tests after this round's changes. Run with
`.venv/bin/python -m pytest tests/unit/test_config_service_migration.py
-v` from `src/nemo/agent-service-maf/`. Filter by capability with
`-k mcp` / `-k kb` / `-k orchestration` / `-k termination` / `-k handoff`
/ `-k memory`.

**Legend**

- ✅ Wired & exercised end-to-end via config-service
- 🟡 Wired but not exercised (or partial)
- ❌ Not wired in the adapter — known gap
- ⚪ Out of scope for the adapter (MAF-runtime / route-layer concern only)

---

## 1. Orchestration patterns

`orchestrationPolicy` is **passthrough** — string is wrapped as
`{type: <name>}`, dict is shallow-copied. MAF's Pydantic
`OrchestrationConfig` validator is the source of truth.

| MAF type     | Adapter passthrough | Verified via config-service | Notes |
|--------------|---------------------|-----------------------------|-------|
| `single`     | ✅ | ✅ `solo_assistant` + 6 memory variants | Default for solo teams |
| `sequential` | ✅ | ✅ `sequential_research_pipeline` | Last agent = responding agent |
| `concurrent` | ✅ | ✅ `concurrent_text_analysis` | Aggregator concatenates outputs |
| `group_chat` | ✅ | ✅ `group_chat_feature_design` | LLM-selection drives turn order |
| `handoff`    | ✅ + **all-pairs synth** when blob omits `handoffs[]` | ✅ `handoff_customer_support` | `TODO(config-service)` — replace synth once schema exposes edges |
| `magentic`   | ✅ + manager-block extraction | ✅ `magentic_research_team` (manager_model + max_rounds=8 wired) | First-invoke chain is slow (multi-LLM) |
| `triage`     | ✅ | ✅ `triage_router_team` — router picks ONE specialist | Was collapsing to concurrent before the 2026-05-30 patch |
| `graph`      | ✅ + `edges[]` passthrough | ✅ `graph_reflection_loop` (generator ⇄ critic) | `edges` not yet exposed by config-service swagger |

---

## 2. Termination strategies

`terminationStrategy` is lifted from the team-blob top level into
`orchestration.termination_strategy`; aggregator `sub_strategies` are
recursively normalised.

| Strategy | Adapter shape | Config-service equivalent | Verified |
|----------|---------------|---------------------------|----------|
| `default` (MAF default) | ⚪ no-op | n/a — applied when nothing supplied | ✅ implicit on solo / memory teams |
| `keyword` | ✅ `{type, keywords[]}` | `KeywordTermination` | ✅ as leaf inside aggregator on `graph_reflection_loop` |
| `maximum_iterations` | ✅ `{type, maximum_iterations}` | `MaximumIterationsTermination` | ✅ `magentic_research_team` (max_iter=8) + leaf in aggregator |
| `timeout` | ✅ `{type, timeout_seconds}` | `TimeoutTermination` | 🟡 mapped, no fixture exercises it |
| `aggregator` (any/all of N) | ✅ `{type, condition, sub_strategies[]}` recursed | `AggregatorTermination` | ✅ `graph_reflection_loop` + `group_chat_feature_design` (both: keyword OR max_iter) |
| `approval` | 🟡 passthrough `{type:"approval"}` | not in config-service schema | not exercised |
| `kernel_function` | 🟡 passthrough | not in config-service schema | not exercised |

---

## 3. Memory management

Adapter passes the whole `memory` / `memoryConfig` dict through; MAF's
`MemorySection` accepts ~25 fields.

| Knob | Adapter | Config-service field | Verified |
|------|---------|----------------------|----------|
| `enabled` | ✅ | `memoryType: "none"` ⇒ disabled | ✅ `memory_assistant_disabled` — no recall confirmed |
| `buffer_type: sliding_window` | ✅ | `memoryType: "sliding_window"` | ✅ all 6 memory variants load + 3/6 recall (multi-worker flake) |
| `buffer_type: summary` | ✅ | `memoryType` enum lacks it — must come via `memoryConfig` | ✅ on-disk `summary_buffer` works; config-service variant currently uses sliding_window |
| `max_history_length` (windowSize) | ✅ | `memoryConfig.windowSize` (MAF reads via `extra=allow`) | ✅ `windowSize=20` reaches bundle |
| `max_chars_per_session` | ✅ | `memoryConfig.maxCharsPerSession` (absent in fixtures) | 🟡 |
| `max_tokens_per_session` | ✅ | `memoryConfig.maxTokensPerSession` | 🟡 |
| `storage_backend: memory\|redis` | ✅ | `memoryConfig.storageBackend` (not in fixtures) | 🟡 defaults to `memory` today |
| `redis_url / sentinel / password` | ✅ passthrough | not in config-service | ❌ |
| `ttl_seconds`, `summary_*`, `compression_level` | ✅ passthrough | not in fixtures | ❌ |

> Multi-worker uvicorn + per-process in-memory session store make
> multi-turn recall flaky (3/6 in the sweep). Not an adapter issue —
> pin `--workers 1` or wire Redis to make it deterministic.

---

## 4. Tools

| Mechanism | Adapter | Config-service today | Verified |
|-----------|---------|----------------------|----------|
| Per-agent **MCP server IDs** (`mcpServerIds`) | ✅ resolved through `get_mcp_server` into inline `mcp_servers[]` configs; agent `mcp_servers` rewritten from id → server name | yes, on agent record | ✅ `personal_assistant_full` bundle now shows `mcp_servers: [{name:"weather", transport:"streamable-http", url:"http://host.docker.internal:4001/mcp", timeout_seconds:600}]` and `agents[].mcp_servers = ["weather"]` |
| **MCP traffic via Bifrost** (no direct upstream) | ✅ URL field on MCP record inlined verbatim — never rewritten | by convention, the `url` on every record is a Bifrost endpoint | ✅ verified — `weather` resolves to `http://host.docker.internal:4001/mcp` |
| Per-agent **`tools[]` allow-list** (MCP tool names) | ✅ | yes | 🟡 wired; fixture leaves it empty |
| **`allowedTools` / `disallowedTools` on MCP record** | ✅ mapped to `allowed_tools` / `disallowed_tools` in the inline config | yes | 🟡 wired; live `weather` record has both null |
| **MCP-record headers** (`staticHeaders` + `extraHeaders`) | ✅ merged into a single `headers` dict on the inline config | yes | 🟡 wired; live `weather` record has both null |
| **MCP-record timeout** (`timeout` ms) | ✅ converted to `timeout_seconds` (÷1000) | yes | ✅ 600000 ms → 600 s on `weather` |
| **stdio transport** (`command` / `args` / `env`) | ✅ passed through for stdio servers | yes | 🟡 unit-tested via `test_mcp_server_record_to_inline_config_stdio`; no live stdio fixture |
| Top-level **`mcp` settings** (timeouts, lazy_connect…) | ✅ | not in current swagger | 🟡 falls back to MAF defaults |
| Top-level **`mcp_servers[]`** inline definitions | ✅ merged with resolver output by name (de-duped) | n/a (config-service uses IDs) | ⚪ file-based teams only |
| Unresolved MCP-server id (404 or fetch error) | ✅ dropped from agent's `mcp_servers` with a composition warning so MAF never tries to use an unknown server name | n/a | ✅ `test_mcp_server_id_unresolved_drops_from_agent` |
| **Function bindings** (`tool_bindings[]` — e.g. `kb_retrieve`) | ✅ adapter now propagates top-level `tool_bindings` through `team_blob_to_maf_payload`, synthesises `kb_retrieve` bindings from `knowledgeBaseIds` (see §5), and appends binding names to agents' `tool_bindings` list | not in current swagger as a writeable field; synthesised by the adapter | ✅ via the KB-binding tests in §5 |
| Tool-call timeout / retries / concurrency caps | ✅ via top-level `mcp` block | not in fixtures | 🟡 |

---

## 5. Knowledge bases

| Mechanism | Adapter | Config-service today | Verified |
|-----------|---------|----------------------|----------|
| Agent `knowledgeBaseIds[]` | ✅ resolved through `get_knowledge_base`; each id → synthesised `kb_retrieve` `FunctionBinding`; binding name appended to agent's `tool_bindings` | yes (live: `personal_assistant.knowledgeBaseIds=["kbvaydoa2b"]`) | ✅ `personal_assistant_full` bundle now shows `tool_bindings: [{name:"maf-fixture-rfc-kb", function_ref:"kb_retrieve", params:{kbId:"kbvaydoa2b", projectId, topK:5, similarityThreshold:0.5}}]` and `agents[].tool_bindings = ["maf-fixture-rfc-kb"]` |
| KB record fetch (`GET /knowledgebases/{id}`) | ✅ via `RemoteConfigCache.get_knowledge_base` with same TTL/LKG semantics as agents/MCP | endpoint works (confirmed against `maf-fixture-rfc-kb`) | ✅ resolver counter verifies one fetch per unique id |
| `kb_retrieve` runtime function | ⚪ untouched — `@register_function("kb_retrieve")` in `tools/functions/kb_retrieve.py` still owns HTTP, parsing, citations | n/a | ✅ adapter only emits the `function_ref` pointer; `kb_retrieve.py` has not been modified by the migration work |
| Unresolved KB id (404 / fetch error) | ✅ dropped — no phantom binding name leaks into the agent | n/a | ✅ `test_kb_id_unresolved_not_added_to_agent` |
| Same KB referenced by N agents | ✅ resolver hit once, single dedup'd binding, all agents reference it by name | n/a | ✅ `test_kb_dedup_across_agents` |
| KB names with spaces / special chars | ✅ slugified to fit `FunctionBinding.name`'s `[a-zA-Z0-9_-]{1,64}` regex | yes (no enforcement on KB names in config-service) | ✅ `test_kb_record_to_function_binding_slugifies_unsafe_names` |
| Team `sharedKnowledgeBaseIds[]` | ❌ not yet read by the adapter | yes | ❌ — team-level shared KBs don't flow yet; only per-agent ids |
| Per-agent KB-call params override (`topK`, `similarityThreshold`, custom headers) | 🟡 defaults injected (`topK=5`, `similarityThreshold=0.5`); not surfaced from config-service KB record because the record doesn't carry them today | n/a | 🟡 — `default_top_k` / `default_similarity_threshold` are kwargs on `knowledge_base_record_to_function_binding` so a future override path can wire through |

---

## 6. Other agent-level knobs

| Field | Adapter | Verified |
|-------|---------|----------|
| `model` / `modelId` / `model_id` | ✅ | ✅ — fixtures have `modelId=null`, so falls back to `AGENT_AGENT__MODEL` env (`azure/gpt-4.1-mini`) |
| `temperature` | ✅ | ✅ |
| `max_tokens` / `maxTokens` | ✅ | ✅ |
| `output_schema` / `outcomeSchema` | ✅ adapter reads it; used as the **fallback** source for `output_schema` when the new preferred shape is absent (swagger documents `outcomeSchema` as `"Deprecated — prefer structuredOutput.json_schema"`) | ✅ — confirmed on the 3 `concurrent_text_analysis` agents |
| `structuredOutput.json_schema` | ✅ adapter reads it as the **preferred** source for `output_schema`; wins over `outcomeSchema` when both are present; an explicit `structuredOutput.enabled: false` falls back to `outcomeSchema` | ✅ — live verified against `sentiment_analyzer`: raw record carries both, bundle's `output_schema` now sourced from `structuredOutput.json_schema` (4 unit tests cover all branches) |
| `response_format` (`"json_object"`) | ⚪ N/A — **no source field on the agent record today**. Config-service agent records do **not** carry a `responseFormat` field (verified against live record + swagger). Only `outputResponse: AgentOutputResponse {example_response}` exists, which is a prompt-scaffolding example, not an LLM output-format hint. If MAF's `response_format` knob is wanted, config-service would have to grow a new field first. | ⚪ no-op until source field exists |
| `function_choice_behavior` / `functionChoiceBehavior` | ✅ | ✅ — `auto` reaches the bundle |
| `top_p` / `presence_penalty` / `frequency_penalty` | ❌ MAF accepts, adapter drops | ❌ |
| `prompt_template` | ❌ same | ❌ |
| `skip_post_tool_synthesis` | ✅ adapter always stamps `False` when the record omits the field (config-service doesn't model it yet); accepts `skipPostToolSynthesis` / `skip_post_tool_synthesis` aliases so a future config-service field flows through automatically | not in config-service today | ✅ unit-tested both branches (`test_agent_record_skip_post_tool_synthesis_defaults_false` + `_picks_up_either_alias`) |
| `instructions` / `systemPrompt` / `system_prompt` | ✅ | ✅ |
| `member.role` override (per-team agent role) | ✅ via `member_overrides` | 🟡 wired (e.g. `handoff_customer_support` members carry `role: router/specialist`), but only `role`/`description`/`instructions` are honored; not exercised semantically |

---

## 7. Per-request overrides (`InvokeRequest.configOverrides`)

The override mechanism is **at the route layer**
(`interface_layer/models.py:ConfigOverrides`), independent of the
adapter.

| Override | Allowed | Locked / dropped | Verified |
|----------|---------|------------------|----------|
| `model` (top-level) | ✅ | — | ⚪ not exercised via config-service teams |
| `temperature` (0.0–2.0) | ✅ Pydantic-range validated | — | ⚪ |
| `maxTokens` (1–200,000) | ✅ Pydantic-range validated | — | ⚪ |
| `agentOverrides.<name>.{model,temperature,maxTokens}` | ✅ team invokes only | ignored on single-agent invokes | ⚪ |
| `agent.framework` | ❌ blocked | locked field | ⚪ |
| `interface.host` / `interface.port` | ⚪ removed entirely | **removed from `InterfaceSection` as of 2026-05-30** — the service bind is driven by uvicorn's CLI flags (`--host` / `--port`), not the config layer. Legacy payloads that still carry them land in `__pydantic_extra__` (the section has `extra="allow"`) and are silently ignored. The MCP-server SSE launcher (`protocols/mcp_server.py`) now hardcodes `0.0.0.0`. | ⚪ |
| `project_id` | ❌ blocked | locked | ⚪ |
| Unknown keys | dropped silently + DEBUG `config_override_ignored` log | — | ⚪ |

---

## 8. Cross-cutting team-level blocks

| Block | Adapter | Verified |
|-------|---------|----------|
| `gateway` (url, api_key, default_model, timeouts, retries) | ✅ passthrough | ✅ env-default used since config-service doesn't carry it on team |
| `guardrails` (enabled, fail_open, default_*_guardrails, tool_guardrails) | ✅ passthrough | 🟡 bundle has guardrails enabled with defaults; not actively probed |
| `mcp` (top-level MCP settings) | ✅ passthrough | 🟡 |
| `mcp_servers` (top-level array) | ✅ passthrough | 🟡 not used by config-service teams (they use IDs) |
| `tasks` (async-invoke config) | ✅ passthrough | 🟡 fixture doesn't set it; async not exercised against config-service |
| `logging` | ✅ passthrough | ⚪ |
| `_schema_version` | ✅ passthrough when present | ⚪ |

---

## 9. Open gaps (rough impact order)

1. **Team `sharedKnowledgeBaseIds[]`** ❌ — top-level KB references on the team blob aren't read. Adapter currently only fans out from each agent's `knowledgeBaseIds`. If a team-shared KB ever lands in fixtures, fold it into every agent's binding list (or treat it as a team-wide binding).
2. **`top_p` / `presence_penalty` / `frequency_penalty` / `prompt_template`** ❌ — MAF supports, adapter drops. (`skip_post_tool_synthesis` closed 2026-05-30 — see Recently closed.)
3. **`memoryType: "conversation"`** 🟡 — config-service enum allows it; MAF doesn't have a matching `buffer_type`. Either map or document the gap.
4. **Handoff edges**: still synthesised. The TODO marker is `TODO(config-service)` in `remote_adapter.py:team_blob_to_maf_payload`.
5. **MCP `authType` beyond `"none"`** 🟡 — adapter inlines `headers` from `staticHeaders`/`extraHeaders` but doesn't yet implement the OAuth / credential-store paths (`authorizationUrl`, `tokenUrl`, `credentialId`, `runtimeCredentialId`). Fixture has `authType: "none"`, so untested today.
6. **Per-KB `topK` / `similarityThreshold` overrides from config-service** 🟡 — the KB record currently has no field for these; adapter injects MAF defaults (5, 0.5). If config-service grows a `retrieval` block on the KB record, plumb it through `default_top_k` / `default_similarity_threshold`.
7. **No config-service source for MAF's `response_format` knob** ⚪ — agent records don't carry a `responseFormat` field (verified against swagger + live record). The MAF runtime knob is wired and reaches Bifrost; it just has nothing to read from on the config-service side. If you want to drive `response_format` from config-service, the agent schema needs a new field.

### Recently closed

- ~~**`interface.host` / `interface.port` removed entirely**~~ ✅ closed 2026-05-30: deleted the two fields from `InterfaceSection`, trimmed every docstring/comment that referenced them, removed from `AgentConfig.locked_fields` default, deleted the now-irrelevant port-bounds validation tests, swapped the multi-section override tests onto `request_timeout_seconds`, hardcoded the SSE-launcher bind to `0.0.0.0`, removed `AGENT_INTERFACE__HOST` / `AGENT_INTERFACE__PORT` from `.env.example` / `docker-compose.yml` / `agent_config.reference.yaml` / `README-DEVELOPMENT.md` / e2e conftest, updated Bruno test docs, regenerated the OpenAPI fixture. Rationale: the service bind is driven by uvicorn's `--host` / `--port` CLI flags — keeping the fields on the config model was vestigial. **2091 unit + integration tests pass**; `extra="allow"` on `InterfaceSection` absorbs legacy payloads that still set the fields so nothing breaks at parse time.
- ~~**`structuredOutput.json_schema` as the preferred `output_schema` source**~~ ✅ closed 2026-05-30: adapter now reads `structuredOutput.json_schema` (the new shape) and falls back to `outcomeSchema` (deprecated). New shape wins when both are present; `structuredOutput.enabled: false` triggers fallback to `outcomeSchema`. 5 tests cover all branches (`test_agent_record_output_schema_*`). **Correction to earlier doc claim:** `responseFormat` is **not** a config-service field — see open gap #7 instead.
- ~~**`skip_post_tool_synthesis` passthrough**~~ ✅ closed 2026-05-30: adapter stamps the MAF default (`False`) when the agent record omits the field, and accepts `skipPostToolSynthesis` / `skip_post_tool_synthesis` aliases so a future config-service field flows through automatically. 2 tests in `TestRemoteAdapter`.
- ~~**KB → function-binding synthesis**~~ ✅ closed 2026-05-30: agent `knowledgeBaseIds` is now resolved via `RemoteConfigCache.get_knowledge_base`; each id → `kb_retrieve` `FunctionBinding` injected on the team's `tool_bindings[]`, binding name appended to the agent's `tool_bindings`. The runtime function `kb_retrieve` was NOT modified — the adapter only emits a descriptor that points at the existing registered function via `function_ref="kb_retrieve"`. Also folded into the same patch: `team_blob_to_maf_payload` now propagates a top-level `tool_bindings` list into the MAF payload (was being silently dropped). 6 tests cover the path.
- ~~**MCP-server ID resolution**~~ ✅ closed 2026-05-30: adapter now fetches each referenced MCP record via `RemoteConfigCache.get_mcp_server` and inlines `{name, transport, url, …}` into the team payload, with agent.mcp_servers rewritten from id → name. Bifrost URL on the record is inlined verbatim (MCP traffic must route through Bifrost). 7 tests in `tests/unit/test_config_service_migration.py::Test{LazyTeamRegistry,RemoteAdapter}` cover the path.

---

## 10. Fixtures in `maf-fixtures` (`projs19sngp2`)

| Team | id | Orchestration | Notes |
|------|----|---------------|-------|
| `solo_assistant` | `agr-g4pl83o6` | single | Baseline single-agent surface |
| `sequential_research_pipeline` | `agr-lp9k937j` | sequential | researcher → analyst → writer |
| `concurrent_text_analysis` | `agr-oj2bcrjt` | concurrent | sentiment + entity + topic in parallel |
| `group_chat_feature_design` | `agr-b47h8b7v` | group_chat | pm + engineer + designer |
| `handoff_customer_support` | `agr-jx0qqrv7` | handoff | triage → billing / technical |
| `magentic_research_team` | `agr-51xmup3m` | magentic | autonomous manager + researcher/analyst/writer |
| `graph_reflection_loop` | `agr-aokws36p` | graph | generator ⇄ critic |
| `triage_router_team` | `agr-o2vl3gad` | triage | router → researcher / analyst / writer |
| `memory_assistant_baseline` | `agr-y5bblrz2` | single | windowSize=20 |
| `memory_assistant_message_limit` | `agr-5arv2d7e` | single | tight message limit |
| `memory_assistant_char_limit` | `agr-37ms6whf` | single | tight char limit |
| `memory_assistant_token_budget` | `agr-16u3fto3` | single | tight token budget |
| `memory_assistant_summary` | `agr-wf70mv9d` | single | summary buffer |
| `memory_assistant_disabled` | `agr-vrrmw4ot` | single | memory off |
| `personal_assistant_full` | `agr-hlso58da` | single | MCP `weather` + KB `maf-fixture-rfc-kb` (KB binding not yet wired through adapter — see §5) |

19 agents are seeded (every role from `assistant` through `personal_assistant`); only `echo_agent` is intentionally absent (framework choice, not a model record).
