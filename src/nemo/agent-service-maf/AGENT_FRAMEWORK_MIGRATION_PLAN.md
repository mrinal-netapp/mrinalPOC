# Migration Plan: Semantic Kernel → Microsoft Agent Framework (`agent-service-maf`)

**Status:** ✅ COMPLETE — full cutover done. The Microsoft Agent Framework adapter (`maf`) is now the **default and only LLM-backed framework** (`echo` remains as a dependency-free test adapter). The Semantic Kernel adapter package (`framework/semantic_kernel/`), the `[semantic-kernel]` dependency extra, and all SK-specific tests have been **removed** ("fix forward"). Implemented on `maf`: single-agent invoke/stream, function + MCP tools, **all** multi-agent orchestration topologies (sequential, concurrent, handoff, triage, group_chat, magentic, graph) via AF builders, wall-clock timeout termination, and AF OpenTelemetry instrumentation gated on `semantic_kernel.enable_telemetry`. The framework-agnostic config section key `semantic_kernel` (class `SemanticKernelSection`) is **retained for backward compatibility** with stored team configs and the config-service wire format — it is read by the `maf` adapter and is not tied to Semantic Kernel. This document is kept as a historical record of the migration.
**Scope:** `src/nemo/agent-service-maf` (the SK-based MAF service). No frontend code changes required (see §7).
**Source framework:** `semantic-kernel >= 1.40`
**Target framework:** Microsoft Agent Framework 1.0 GA — Python package `agent-framework`, import root `agent_framework`.

> ### ⚠️ Prerequisite resolved: import-root namespace collision
> Microsoft Agent Framework's Python import root is `agent_framework` — which **collided** with this service's own internal package, also named `agent_framework`. A regular package shadows the upstream namespace package, so the two cannot coexist.
>
> **Resolution (done):** the internal package was renamed `agent_framework` → **`agent_service_maf`** (matching the distribution name `agent-service-maf`). All ~180 modules, imports, the `agent-server` entry point, Hatch `packages`, ruff paths, Dockerfile, Makefile, `project.json`, docs, and the OpenAPI fixture were updated. Verified green: app import OK, 2362 unit + 351 integration tests pass. The bare `agent_framework` import root is now free for the upstream dependency.
>
> Path references below now read `src/agent_service_maf/...`. The **new** AF adapter subpackage is created at `src/agent_service_maf/framework/maf/` (named `maf`, not `agent_framework`, to avoid human confusion with the upstream top-level `agent_framework` package it imports).

> Reference docs (verified current as of 2026):
> - Overview: https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview
> - **SK → AF migration guide (primary source for this plan):** https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-semantic-kernel/
> - Workflows (multi-agent orchestration): https://learn.microsoft.com/en-us/agent-framework/workflows/
> - Magentic orchestration (manager = agent with `instructions`): https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic
> - Typed Options upgrade guide (Python): https://learn.microsoft.com/en-us/agent-framework/support/upgrade/typed-options-guide-python
>
> **How this plan uses the guide:** every code-level mapping below is taken from the official SK → AF migration guide; §7 is the verbatim cheat-sheet and §7a maps each guide section to the exact files it touches. Note the migration guide covers **single-agent** patterns only — multi-agent orchestration mappings come from the Workflows / Magentic docs (see §3, §6 Phase 3).

---

## 1. Executive summary

Microsoft Agent Framework (AF) is GA and is the **official successor to both Semantic Kernel and AutoGen**, built by the same teams. SK is now on a maintenance/predecessor track, so the strategic question is *when*, not *whether*.

The good news for this codebase: **the real SK surface is tiny and well-isolated.** Despite 23 files containing the string `semantic_kernel`, only **3 files actually import the SK library**:

| File | What it uses from SK |
|---|---|
| `framework/semantic_kernel/adapter.py` | `Kernel`, `ChatCompletionAgent`, all orchestration classes (`magentic`, `group_chat`, `handoffs`, `concurrent`, `sequential`), `InProcessRuntime`, `FunctionChoiceBehavior`, `KernelFunctionFromMethod`, content types |
| `framework/semantic_kernel/gateway_chat_completion.py` | subclasses `ChatCompletionClientBase`; `PromptExecutionSettings` |
| `framework/semantic_kernel/event_mapper.py` | content types (`ChatMessageContent`, `FunctionCallContent`, `FunctionResultContent`, `StreamingChatMessageContent`, `AuthorRole`) |

Everything else (`config/*`, `core/*`, `interface_layer/*`, `framework/registry.py`, `framework/response_builder.py`, and the other `framework/semantic_kernel/*` helpers) references `semantic_kernel` only as a **config-section name / framework-identifier string** or in docstrings — **not** as a library dependency. Those do not need a framework port; at most they get a new framework id added.

Combined with the existing **adapter seam** (`framework/base_agent.py:BaseAgent`, `framework/registry.py:FrameworkRegistry`, and a working `echo_adapter.py` proving pluggability), the recommended approach is:

> **Build a parallel `framework/agent_framework/` adapter that implements `BaseAgent`, register it under a new framework id, migrate incrementally, and keep the public wire contract (`InvokeResponse` / `Citations` / SSE event vocabulary) byte-stable so the UI and config schema are untouched.**

---

## 2. Current architecture (what we actually have)

```
interface_layer/   ← FastAPI routes, SSE, wire models (InvokeResponse, Citations)  [framework-agnostic]
core/              ← BaseAgent contract, team_loader, team_bundle, interfaces      [framework-agnostic]
config/            ← pydantic config (SemanticKernelSection, OrchestrationConfig)   [section NAMED semantic_kernel]
framework/
  base_agent.py        ← BaseAgent ABC                      ← THE SEAM
  registry.py          ← FrameworkRegistry (id → adapter)   ← THE SEAM
  response_builder.py  ← builds InvokeResponse/Citations    [framework-agnostic]
  echo_adapter.py      ← proof the seam works (no SK)
  semantic_kernel/     ← the ONLY real SK coupling
     adapter.py             ← SemanticKernelAdapter(BaseAgent)   [SK import]
     gateway_chat_completion.py ← Bifrost client as SK ChatCompletionClientBase [SK import]
     event_mapper.py        ← SK content types → wire events     [SK import]
     agent_builder.py       ← builds BuiltAgent (no direct SK import)
     orchestration_factory.py ← OrchestrationConfig → OrchestrationSpec (no direct SK import)
     function_kernel_plugin.py / mcp_kernel_plugin.py ← tool/plugin wrapping
     termination.py / manager.py
```

The seam means a new framework lives side-by-side: `framework/agent_framework/` registered as e.g. `"agent_framework"` (or reuse `"semantic_kernel"` once parity is proven). `config.agent.framework` already selects the adapter by id.

---

## 3. Target architecture

```
framework/
  base_agent.py        ← unchanged
  registry.py          ← register new id
  agent_framework/     ← NEW adapter (mirrors semantic_kernel/ structure)
     adapter.py             ← AgentFrameworkAdapter(BaseAgent)
     gateway_chat_client.py ← Bifrost client implementing AF ChatClient protocol
     event_mapper.py        ← AF AgentResponse/AgentResponseUpdate → wire events
     agent_builder.py        ← builds AF Agent objects from config
     orchestration_builder.py ← OrchestrationConfig → AF Workflow / Magentic
     tools.py                ← config tools/MCP → AF tools
  semantic_kernel/     ← kept until parity proven, then deleted
```

The `core`, `config`, `interface_layer`, and `response_builder` layers are **reused unchanged** (modulo a new framework-id constant). The wire contract is the migration's invariant.

---

## 3a. Orchestration type coverage — all 8 types handled

Your current `OrchestrationConfig.type` supports: `single, sequential, concurrent, handoff, group_chat, magentic, triage, graph`. **Every one maps to a native Agent Framework construct** (verified against the AF Workflows/Orchestration docs). AF Python orchestration builders live in `agent_framework.orchestrations`; the graph case uses AF core `WorkflowBuilder` + executors.

| `type` (SK today) | AF target (Python) | Native? | Mapping notes |
|---|---|---|---|
| `single` | `Agent(...).run(...)` (no orchestration) | ✅ native | Just the single agent path; baseline of Phase 1. |
| `sequential` | `SequentialBuilder(participants=[...]).build()` | ✅ native | Pipeline; each agent sees prior output. `chain_only_agent_responses=True` to pass only responses. Terminal output = last agent's `AgentResponse`. |
| `concurrent` | `ConcurrentBuilder(participants=[...]).build()` | ✅ native | Parallel fan-out; default aggregator returns one message per agent. `.with_aggregator(fn)` for synthesis (covers SK's aggregation/voting). |
| `magentic` | `MagenticBuilder(participants=[...], manager_agent=Agent(instructions=...), max_round_count=, max_stall_count=, max_reset_count=).build()` | ✅ native | **Manager is an `Agent` with its own `instructions`** — closes the SK manager-instruction gap. Optional `enable_plan_review` for HITL. |
| `handoff` | `HandoffBuilder(participants=[...]).with_start_agent(a).add_handoff(a,[b,c]).build()` | ✅ native | Mesh topology, control transfers via handoff tool calls. **Interactive by default** — use `.with_autonomous_mode()` to match the current non-interactive invoke. |
| `triage` | `HandoffBuilder(...).with_start_agent(triage_agent)` (+ `with_autonomous_mode()`) | ✅ native | AF's own Handoff example *is* a triage/router. Replaces your **custom** SK triage with a supported pattern — net simplification. |
| `group_chat` | `GroupChatBuilder(participants=[...], manager=...).build()` | ✅ native | Manager-coordinated turn-taking; carry over `selection_strategy`/`termination_strategy` (incl. `function_prompt`). Magentic shares this architecture "with a more powerful planning manager." |
| `graph` | AF core `WorkflowBuilder` + `Executor`/`@handler`/edges | ✅ native (core) | AF Workflows are graph-based by design (typed edges, `ctx.send_message`, checkpointing). Re-express your **custom** `graph` directly on these primitives — likely a better fit than SK. |

Key runtime notes that affect parity:
- **Non-interactive invoke:** `handoff`/`triage` must enable **autonomous mode** (`.with_autonomous_mode()`, optionally with `turn_limits=`) so they don't pause for `request_info` user input the way the UI's single-shot invoke expects.
- **Per-step trace → Citations:** sequential/concurrent/magentic/handoff all surface per-participant updates (`AgentResponseUpdate`) and support `intermediate_output_from=[...]`. The `event_mapper` taps these to populate `Citations.agentTrace[].toolExecutions[]` (so the UI's Execution/Tracing tabs keep working).
- **Terminal output:** each builder yields a terminal `AgentResponse`; map that to `InvokeResponse.output` exactly as today.

> Source pages: [Sequential](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/sequential), [Concurrent](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/concurrent), [Handoff](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff), [Magentic](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic), [Group Chat](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat).

---

## 4. Full impact map

Legend — Effort: ⬤ high · ◐ medium · ○ low. Risk: 🔴 high · 🟠 medium · 🟢 low.

| Area | File(s) | Impact | Effort | Risk | Notes |
|---|---|---|---|---|---|
| **Gateway chat client** | `gateway_chat_completion.py` → new `gateway_chat_client.py` | Rewrite. Stop subclassing SK `ChatCompletionClientBase`; implement AF's `ChatClient`/`BaseChatClient` (IChatClient-style) protocol around Bifrost. Re-do timing + **token-usage accumulation** (incl. the streaming-usage gap) and tool-call delta parsing in AF's content shapes. | ⬤ | 🔴 | **Biggest single item.** Verify AF's exact custom-`ChatClient` interface + streaming update shape (`AgentResponseUpdate`). |
| **Adapter core** | `adapter.py` → new `agent_framework/adapter.py` | Rewrite. `Kernel`+`ChatCompletionAgent` → `Agent(client=...)` / `client.as_agent(...)`. `invoke`/`invoke_stream` → `run(...)` / `run(..., stream=True)` returning `AgentResponse`/`AgentResponseUpdate`. Threads via `agent.get_new_thread()`. | ⬤ | 🟠 | Single agent path is straightforward per the guide. |
| **Orchestration** | `orchestration_factory.py`, `manager.py`, `termination.py`, magentic/group_chat/handoff/concurrent/sequential branches in `adapter.py` | Re-express SK orchestration classes as AF **graph-based Workflows** + AF Magentic. Custom `triage`/`graph` types (already hand-rolled) re-implemented on AF primitives. | ⬤ | 🔴 | **Highest-uncertainty item.** The SK→AF guide covers single-agent only; multi-agent mapping must come from the Workflows docs. Validate each of the 8 types: `single, sequential, concurrent, handoff, group_chat, magentic, triage, graph`. |
| **Manager config (the original ask)** | `config/validators.py:OrchestrationConfig`, orchestration builder | AF Magentic manager exposes native **`instructions`** → add `manager_instructions` (and optional role) to `OrchestrationConfig` and pass through. Closes the gap that doesn't exist in SK's `StandardMagenticManager`. | ○ | 🟢 | Net feature gain; do during orchestration port. |
| **Tools / functions** | `function_kernel_plugin.py` → `tools.py` | SK `KernelFunction`/plugin wrapping → AF plain-function tools or `@tool` decorator (no Kernel, no plugin). | ◐ | 🟢 | Optional bridge: SK `KernelFunction.as_agent_framework_tool()` (needs `semantic-kernel>=1.38`) for incremental cutover. |
| **MCP tools** | `mcp_kernel_plugin.py`, `interface_layer/protocols/mcp_server.py` | SK MCP plugin → AF MCP client / hosted-MCP tools. | ◐ | 🟠 | AF has first-class MCP support; confirm pool/headers parity with current `mcp_pool` behavior. |
| **Content/event mapping** | `event_mapper.py` | Map AF `AgentResponse`/`AgentResponseUpdate` (and tool-call/result content) → existing SSE events + `Citations.agentTrace[].toolExecutions[]`. | ◐ | 🟠 | Must preserve the exact envelope the UI reads (`metadata.invokeResponse.citations`). |
| **Agent builder** | `agent_builder.py` | Build AF `Agent` objects (client + instructions + tools) instead of SK `ChatCompletionAgent`/`BuiltAgent`. | ◐ | 🟢 | Per-agent `instructions`, temperature, etc. map directly. |
| **Config schema** | `config/validators.py` (`SemanticKernelSection`, `OrchestrationConfig`), `defaults.py`, `remote_adapter.py`, `file_loader.py`, `_override_applier.py` | Mostly **reused**. The `semantic_kernel.*` config section name and `framework: "semantic_kernel"` id are NetApp conventions, not SK imports. Decide: keep the section name for back-compat, or add `agent_framework` alias. | ○ | 🟢 | Avoid renaming the wire/config keys to keep config-service + stored team blobs compatible. |
| **Framework registry / id** | `framework/registry.py`, `core/interfaces.py`, `core/exceptions.py` | Add `"agent_framework"` framework id; register new adapter. | ○ | 🟢 | Pure additive. |
| **Response builder** | `framework/response_builder.py` | Reused; only the `framework` label string changes. | ○ | 🟢 | Framework-agnostic by design. |
| **Routes / SSE / API** | `interface_layer/routes.py`, `interface_layer/models.py` | Reused. `orchestration_type` is read from config, not SK. | ○ | 🟢 | Keep SSE event vocabulary identical. |
| **Wire contract** | `core/interfaces.py` (`InvokeResponse`, `Citations`, `AgentTraceStep`, `ToolExecution`) | **Invariant — do not change.** | ○ | 🟢 | This is what guarantees zero UI impact. |
| **Tests** | `tests/unit/*`, `tests/integration/*`, `tests/e2e/test_sk_parity_scenario.py` | New adapter needs its own unit tests; reuse `test_sk_parity_scenario.py` as the **parity oracle** by running it against both adapters. | ◐ | 🟠 | Parity contract is the safety net for cutover. |
| **Dependencies / packaging** | `pyproject.toml` | Add `agent-framework` (+ provider sub-packages as needed); keep `semantic-kernel` until cutover (optionally as the `.as_agent_framework_tool()` bridge). | ○ | 🟢 | Two frameworks can coexist during migration. |
| **Deploy / Helm** | `deployments/helm/.../agent-service-maf/*` | Image rebuild; env/config for AF providers (e.g., gateway endpoint). No topology change. | ○ | 🟢 | Validate container build picks up new deps. |
| **Observability** | tracing wiring, Phoenix/OTLP | AF has **first-class OpenTelemetry**. Opportunity to emit real spans → could retire the UI-side `agentTrace` tracing fallback. | ◐ | 🟢 | Net improvement; optional in first cut. |
| **Frontend (`agent-studio-ui`)** | — | **No changes** provided the wire contract is preserved. The Run Details (Execution/Tracing/Configuration) work depends on response shape, not the backend framework. | ○ | 🟢 | Treat as a hard constraint, not a hope. |

---

## 4a. Complete file change list

Paths relative to `src/nemo/agent-service-maf/`. Status legend — **NEW** (create) · **REPLACE** (port, then delete original) · **MODIFY-additive** (small/low-risk) · **VALIDATE** (reused, behavior must stay identical) · **DELETE** (at Phase 4 cutover) · **FROZEN** (must not change).

### New files — AF adapter package (`src/agent_service_maf/framework/agent_framework/`)

| Status | File | Replaces / purpose |
|---|---|---|
| NEW | `agent_framework/__init__.py` | Package + adapter registration |
| NEW | `agent_framework/adapter.py` | `AgentFrameworkAdapter(BaseAgent)` ← replaces SK `adapter.py` |
| NEW | `agent_framework/gateway_chat_client.py` | Bifrost client on AF `ChatClient` protocol (timing + streaming token-usage) ← replaces `gateway_chat_completion.py` |
| NEW | `agent_framework/event_mapper.py` | AF `AgentResponse`/`AgentResponseUpdate` → SSE + `Citations` ← replaces SK `event_mapper.py` |
| NEW | `agent_framework/agent_builder.py` | Build AF `Agent` objects from config ← replaces SK `agent_builder.py` |
| NEW | `agent_framework/orchestration_builder.py` | `OrchestrationConfig` → AF Workflows/Magentic ← replaces `orchestration_factory.py` + `manager.py` + `termination.py` |
| NEW | `agent_framework/tools.py` | Config tools + MCP → AF tools ← replaces `function_kernel_plugin.py` + `mcp_kernel_plugin.py` |

### Files to modify — additive / low-risk

| Status | File | Change |
|---|---|---|
| MODIFY-additive | `src/agent_service_maf/framework/registry.py` | Register the new framework id |
| MODIFY-additive | `src/agent_service_maf/core/interfaces.py` | Add `"agent_framework"` to framework-id enum/docs |
| MODIFY-additive | `src/agent_service_maf/core/exceptions.py` | Add new id to "available frameworks" message |
| MODIFY-additive | `src/agent_service_maf/config/validators.py` | Add `manager_instructions` (+ optional role) to `OrchestrationConfig`; allow new framework id on agent config |
| MODIFY-additive | `src/agent_service_maf/framework/response_builder.py` | `framework` label string only |
| MODIFY-additive | `pyproject.toml` | Add `agent-framework` dep (keep `semantic-kernel` until cutover) |
| MODIFY-additive | `deployments/helm/nemo/charts/agent-service-maf/**` | Image rebuild + AF provider env/config |
| MODIFY-additive | `deployments/helm/services/charts/agent-service-maf/**` | Same |

### Files to validate — reused, behavior/contract must stay identical

| Status | File | Note |
|---|---|---|
| VALIDATE | `src/agent_service_maf/interface_layer/routes.py` | Reads `orchestration.type` from config; no logic change expected |
| VALIDATE | `src/agent_service_maf/interface_layer/models.py` | Wire models stay frozen |
| VALIDATE | `src/agent_service_maf/interface_layer/protocols/mcp_server.py` | Add `invoke_agent_framework` alongside `invoke_semantic_kernel` |
| VALIDATE | `src/agent_service_maf/config/remote_adapter.py` | Keep `semantic_kernel` config-section name for back-compat |
| VALIDATE | `src/agent_service_maf/config/file_loader.py` | Same |
| VALIDATE | `src/agent_service_maf/config/defaults.py` | Same |
| VALIDATE | `src/agent_service_maf/config/_override_applier.py` | Manager override slots map to new orchestration fields |
| VALIDATE | `src/agent_service_maf/core/team_loader.py` | Verify new framework id flows through |
| VALIDATE | `src/agent_service_maf/core/team_bundle.py` | Reads config section; verify metadata |

### Tests

| Status | File | Note |
|---|---|---|
| VALIDATE | `tests/e2e/test_sk_parity_scenario.py` | Reuse unchanged as the parity oracle (run vs. both adapters) |
| NEW | `tests/unit/test_agent_framework_*` | Unit tests mirroring the SK adapter tests |
| NEW | `tests/integration/test_agent_framework_*` | Integration coverage for orchestration types |

### Delete at cutover (Phase 4)

| Status | File |
|---|---|
| DELETE | `src/agent_service_maf/framework/semantic_kernel/adapter.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/gateway_chat_completion.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/event_mapper.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/agent_builder.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/orchestration_factory.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/function_kernel_plugin.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/mcp_kernel_plugin.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/termination.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/manager.py` |
| DELETE | `src/agent_service_maf/framework/semantic_kernel/__init__.py` |
| MODIFY | `pyproject.toml` — drop `semantic-kernel` (unless kept only for the `.as_agent_framework_tool()` bridge) |

### Frozen — must NOT change

| Status | File |
|---|---|
| FROZEN | `src/agent_service_maf/core/interfaces.py` wire types: `InvokeResponse`, `Citations`, `AgentTraceStep`, `ToolExecution` |
| FROZEN | Public REST/SSE surface and event vocabulary in `interface_layer/` |
| FROZEN | All of `src/nemo/agent-studio-ui` (frontend) |
| FROZEN | Other services: `agent-service` (Agno), `config-service`, Bifrost gateway |

**Net touch:** 3 real SK files → ~7 new adapter files; ~8 additive edits; ~9 validate-only; 10 deletions at cutover. Concentrated almost entirely under `framework/`.

---

## 5. Migration strategy (principles)

1. **Parallel adapter, not in-place rewrite.** Implement `framework/agent_framework/` beside `semantic_kernel/`. Select via existing `framework` id. Lets you ship incrementally and roll back per-request.
2. **Wire contract is frozen.** `InvokeResponse`/`Citations`/SSE events do not change. This is the contract that keeps the UI and config-service stable.
3. **Parity-test driven.** Run `test_sk_parity_scenario.py` against both adapters; differences are the work list.
4. **Follow the official guide's mappings verbatim.** Don't invent APIs — every agent-creation, invocation, tools, options, and thread change comes from the SK → AF migration guide (§7 / §7a). This avoids drift and keeps us on supported patterns.
5. **Use the guide's compatibility bridge to de-risk and stage the move.** The guide provides `KernelFunction.as_agent_framework_tool()` and VectorStore `create_search_function(...).as_agent_framework_tool()` (both need `semantic-kernel >= 1.38`). This lets existing SK tools/retrieval run *inside* AF agents before they're rewritten — enabling a gradual, function-by-function cutover rather than big-bang.
6. **Adopt the guide's packaging model.** Start with the `agent-framework` meta package; once the needed providers are known, pin only the sub-packages used (e.g. `agent-framework-core` + the gateway/Foundry provider) per the guide's "Package and import updates" section.
7. **Move to typed options.** Replace SK `PromptExecutionSettings`/`KernelArguments` with AF's TypedDict options (`default_options=` at agent creation, per-call `options=`), keeping `instructions` and `tools` as direct kwargs — per the guide's Options section and the Typed Options Upgrade Guide.
8. **Sequence by risk:** prove the gateway client + single-agent path first (highest risk, unblocks everything), then orchestration types one at a time (single → sequential → concurrent → handoff → group_chat → magentic → triage → graph).

---

## 6. Phased plan

### Phase 0 — Spike & de-risk (1–2 wk)
- Install per the guide's packaging model: `pip install agent-framework` (meta) for the spike; note the sub-packages (`agent-framework-core` + provider) to pin later.
- Per guide §"Custom model client": stand up a custom AF `ChatClient` wrapping the Bifrost gateway; learn the `run` / `run(stream=True)` update shape (`AgentResponseUpdate`) and how usage is surfaced.
- **Exit:** a custom AF `ChatClient` wrapping Bifrost returns text + usage for one model, streaming and non-streaming. This proves the single hardest piece.

### Phase 1 — Adapter skeleton + single agent (2–3 wk)
- Create `framework/agent_framework/{adapter,gateway_chat_client,event_mapper,agent_builder,tools}.py`.
- Implement `AgentFrameworkAdapter(BaseAgent)` for `orchestration.type == "single"` using the guide's mappings:
  - **Agent creation** (guide §3): `Agent(client=gateway_chat_client, instructions=..., tools=...)`.
  - **Invocation** (guide §6/§7): `await agent.run(input, thread)` → `AgentResponse` (`.text`, `.messages`); streaming via `agent.run(input, thread, stream=True)` → `AgentResponseUpdate`, assembled with `AgentResponse.from_agent_response_updates(...)`.
  - **Threads** (guide §4): replace SK `ChatHistoryAgentThread` with `agent.get_new_thread()`; reconcile with `session_ttl_seconds` (note AF has no thread-deletion API and distinguishes in-memory vs service threads).
  - **Options** (guide §8): pass `default_options=`/`options=` TypedDicts instead of `PromptExecutionSettings`; keep `instructions`/`tools` as direct kwargs.
- Port token-usage + timing (carry over the streaming-usage fix) into the new client.
- Map AF responses → existing `InvokeResponse`/`Citations`/SSE in `event_mapper.py` (contract frozen).
- Register under a new framework id; gate behind config so SK stays default.
- **Exit:** single-agent invoke + stream pass `test_sk_parity_scenario.py` equivalents; SSE envelope byte-compatible with UI.

### Phase 2 — Tools & MCP (1–2 wk)
- **Stage with the guide's bridge first:** wrap existing SK tools via `KernelFunction.as_agent_framework_tool()` and KB retrieval via VectorStore `create_search_function(...).as_agent_framework_tool()` (needs `semantic-kernel >= 1.38`) so AF agents work end-to-end before any rewrite.
- Then rewrite to native AF tools (guide §5): plain functions / `@tool`, passed via `tools=` (no Kernel, no plugin).
- Port MCP integration to AF MCP client; confirm `mcp_pool` header/auth parity.
- **Exit:** tool-calling + KB-retrieval tools produce identical `toolExecutions` citations.

### Phase 3 — Orchestration on Workflows (3–5 wk, highest uncertainty)
- *(The SK → AF migration guide does not cover multi-agent orchestration — use the Workflows / Magentic docs; see the per-type table in §3a.)*
- Implement `orchestration_builder.py` covering **all 8 types** from §3a, in risk order:
  `single` (Agent) → `sequential` (`SequentialBuilder`) → `concurrent` (`ConcurrentBuilder`) → `handoff` (`HandoffBuilder`) → `triage` (`HandoffBuilder` + `with_start_agent`) → `group_chat` (`GroupChatBuilder`) → `magentic` (`MagenticBuilder`) → `graph` (core `WorkflowBuilder`).
- **Autonomous mode for handoff/triage:** call `.with_autonomous_mode()` so single-shot invokes don't stall on `request_info`; preserve current behavior.
- **Manager instructions are native (confirmed):** build the manager as `Agent(name=..., description=..., instructions=config.manager_instructions, client=...)` and pass to `MagenticBuilder(manager_agent=...)` / group-chat. Add `manager_instructions` to `OrchestrationConfig` — replaces SK's prompt-template workaround and delivers the original feature ask.
- Map per-participant updates + `intermediate_output_from` into `Citations.agentTrace`/SSE so Execution/Tracing tabs stay populated.
- **Exit:** all 8 orchestration types pass `test_sk_parity_scenario.py`-style parity; manager instructions configurable; handoff/triage run non-interactively.

### Phase 4 — Observability, cleanup, cutover (1–2 wk)
- Wire AF OpenTelemetry spans; optionally retire UI `agentTrace` tracing fallback once real spans flow.
- Flip default framework id to AF; soak; then delete `framework/semantic_kernel/` and drop the `semantic-kernel` dependency (unless kept only for the tool bridge).
- **Exit:** SK removed (or reduced to bridge), full e2e green, image rebuilt & deployed.

---

## 7. SK → AF API cheat-sheet (Python, from the official guide)

| Guide § | Concern | Semantic Kernel | Agent Framework |
|---|---|---|---|
| 1 | Package / import | `pip install semantic-kernel`; `from semantic_kernel import Kernel` | `pip install agent-framework` (meta) → later pin `agent-framework-core` + provider sub-pkg; `from agent_framework import Agent, Message` |
| 2 | Agent type | `ChatCompletionAgent`, `AzureAIAgent`, `OpenAIAssistantAgent` | one `Agent` (base `BaseAgent`, interface `SupportsAgentRun`); also `CopilotStudioAgent`, `A2AAgent` |
| 3 | Agent creation | `ChatCompletionAgent(service=..., instructions=...)` (needs `Kernel`) | `Agent(client=ChatClient(...), instructions=...)` or `client.as_agent(instructions=...)` |
| 4 | Thread/session | `ChatHistoryAgentThread()` (caller builds); `thread.delete_async()` | `agent.get_new_thread()`; in-memory vs service threads; **no thread-deletion API** |
| 5 | Tools | `@kernel_function` + plugin + `Kernel` | plain function or `@tool`; pass via `tools=` |
| 5 (compat) | Reuse SK tools / retrieval | `KernelFunction`, VectorStore `create_search_function` | `.as_agent_framework_tool()` bridge (SK ≥1.38) — lets SK tools/retrieval run in AF agents during migration |
| 6 | Non-streaming | `async for r in agent.invoke(...)` / `get_response` | `resp = await agent.run(input, thread)` → `resp.text`, `resp.messages` |
| 7 | Streaming | `async for u in agent.invoke_stream(...)` | `async for u in agent.run(input, thread, stream=True)` → `AgentResponseUpdate`; assemble via `AgentResponse.from_agent_response_updates(...)` / `from_agent_response_generator(...)` |
| 8 | Options | `OpenAIPromptExecutionSettings(...)` + `KernelArguments` | TypedDict `default_options={...}` (creation) / `options={...}` (per-call); `instructions`/`tools` stay direct kwargs |
| — | Custom model client | subclass `ChatCompletionClientBase` | implement AF `ChatClient` (IChatClient-style) |
| Workflows | Multi-agent manager | `StandardMagenticManager(service, settings)` — no instructions | `MagenticBuilder(manager_agent=Agent(instructions=...))` — manager is an agent with its own `instructions` |

---

## 7a. Official guide → our files (traceability)

Each section of the SK → AF migration guide, mapped to the exact files it drives here:

| Guide section | Our file(s) | What we do |
|---|---|---|
| 1 Package & imports | `pyproject.toml` | Add `agent-framework`; later pin sub-packages. |
| 2 Agent type consolidation | `framework/agent_framework/agent_builder.py` | Build one AF `Agent` type instead of SK agent classes. |
| 3 Agent creation | `agent_builder.py`, `adapter.py` | `Agent(client=..., instructions=...)`. |
| 4 Thread/session | `adapter.py` (+ `config/validators.py` `session_ttl_seconds`) | `agent.get_new_thread()`; reconcile TTL with AF thread model. |
| 5 Tool registration (+ compat bridge) | `agent_framework/tools.py` (replaces `function_kernel_plugin.py`, `mcp_kernel_plugin.py`) | Native `@tool`/functions; stage via `.as_agent_framework_tool()`. |
| 6 Non-streaming invoke | `adapter.py`, `event_mapper.py` | `agent.run(...)` → map `AgentResponse` to `InvokeResponse`. |
| 7 Streaming invoke | `adapter.py`, `event_mapper.py` | `run(stream=True)` → map `AgentResponseUpdate` to SSE; assemble final with `from_agent_response_updates`. |
| 8 Options | `agent_builder.py`, `gateway_chat_client.py` | TypedDict options replace `PromptExecutionSettings`. |
| (guide gap) Custom client | `gateway_chat_client.py` | Implement AF `ChatClient` for Bifrost (replaces `gateway_chat_completion.py`). |
| (Workflows docs) Orchestration | `agent_framework/orchestration_builder.py`, `config/validators.py` | Map SK orchestration → AF Workflows/Magentic; add `manager_instructions`. |

---

## 8. Risks & mitigations

- **Gateway client protocol mismatch (🔴):** AF's custom-ChatClient contract differs from SK's. *Mitigation:* Phase 0 spike before committing; this gates everything.
- **Orchestration → Workflow semantics drift (🔴):** AF Workflows are graph-based, not 1:1 with SK orchestration classes; `triage`/`graph` are custom. *Mitigation:* port one type at a time, parity-test each; budget the most time here.
- **Streaming token usage (🟠):** the gap discussed previously must be re-solved on AF's client. *Mitigation:* fold into Phase 0/1; verify AF surfaces per-chunk/terminal usage.
- **Citations/SSE envelope drift (🟠):** any field/casing change breaks the UI silently. *Mitigation:* snapshot-test the SSE `completed` payload against the current shape; keep `event_mapper` output identical.
- **Config/stored-blob compatibility (🟢→🟠):** renaming the `semantic_kernel` config section would break config-service/stored teams. *Mitigation:* keep the section name (or alias); only add a framework id.
- **Two-framework bloat during transition (🟢):** larger image while both installed. *Mitigation:* time-box the dual-install window; remove SK in Phase 4.

---

## 9. What is explicitly NOT impacted

- `agent-studio-ui` (frontend) — no changes if the wire contract holds.
- The public REST/SSE API surface and `InvokeResponse`/`Citations` schema.
- config-service contracts and stored team/agent blobs (keep names).
- Other NEMO services (`agent-service` Agno, config-service, gateway/Bifrost itself).

---

## 10. Open questions to confirm before Phase 1

1. AF custom `ChatClient` interface details + how it exposes streaming updates (`AgentResponseUpdate`) and **token usage** (drives `gateway_chat_client.py`). *(Guide confirms the `ChatClient` approach; exact usage surfacing is the Phase 0 spike question.)*
2. ~~Whether AF covers our orchestration types / supports a manager instruction~~ — **Resolved (see §3a):** all 8 types map to native AF builders; the Magentic/group-chat manager is an `Agent` with its own `instructions`. Remaining detail-level confirmations: exact `GroupChatBuilder` constructor params (manager + selection/termination), and the precise per-member role mapping for coordinator/planner/reviewer/router.
3. AF MCP client parity with current `mcp_pool` (auth headers, pooling, timeouts).
4. Whether to keep `semantic-kernel` installed solely for the guide's `.as_agent_framework_tool()` bridge, or cut fully at Phase 4.
5. Final provider package set (`agent-framework` meta vs. specific sub-packages per guide §1) for the Bifrost/Azure setup.
6. Reconciling AF's thread model (no deletion API; in-memory vs service threads) with the current `session_ttl_seconds` behavior (guide §4).
