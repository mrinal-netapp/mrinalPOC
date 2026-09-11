# Microsoft Agent Framework (MAF) in AgentStudio — Capabilities & Integration Guide

> Source of truth: `NetApp-Nemo/AgentStudio` @ `main` (commit `b01a2a9ad`).
> Scope: what MAF is, what it gives us, and exactly how `agent-service-maf` drives it.
> Companion doc: `agent-service-maf-architecture.md` covers the *service* (layers, endpoints, deployment). This doc covers the *framework* and the seam between the two.

---

## 1. What MAF is, and why it is here

**Microsoft Agent Framework** (import root `agent_framework`) is Microsoft's successor to Semantic Kernel and AutoGen. It provides three things AgentStudio needs:

1. An **agent runtime** — an `Agent` that owns instructions, a chat client, tools, and the tool-calling loop.
2. A **chat-client abstraction** — a layered `BaseChatClient` you can implement against any LLM backend.
3. A **workflow/orchestration engine** — first-class builders for multi-agent topologies, plus a generic graph builder.

AgentStudio uses all three, but with one hard constraint: **every LLM call must go through the in-house Bifrost gateway** (for virtual keys, per-project spend attribution, governance, and MCP multiplexing). MAF's pluggable chat client is what makes that possible — AgentStudio ships `BifrostChatClient`, and from MAF's point of view it is just another provider.

### Where MAF sits

```
┌────────────────────────────────────────────────────────────────────────┐
│  interface_layer/       REST · SSE · WebSocket · A2A · chat protocols  │
├────────────────────────────────────────────────────────────────────────┤
│  framework/executor.py  AgentExecutor — guardrails in / guardrails out │
├────────────────────────────────────────────────────────────────────────┤
│  framework/registry.py  FrameworkRegistry  →  "maf" | "echo"           │
├────────────────────────────────────────────────────────────────────────┤
│  framework/maf/                                                        │
│    adapter.py             AgentFrameworkAdapter  (BaseAgent impl)      │
│    agent_builder.py       config  → BuiltMafAgent                      │
│    orchestration_builder  config  → agent_framework.Workflow           │
│    tools.py               config  → agent_framework.FunctionTool[]     │
│    gateway_chat_client.py BifrostChatClient (BaseChatClient impl)      │
│    event_mapper.py        MAF events → AgentStudio wire contract       │
│    participants.py        TeamParticipant protocol (local + A2A)       │
│    observability.py       enable_instrumentation() toggle              │
├────────────────────────────────────────────────────────────────────────┤
│  ══════════════ MICROSOFT AGENT FRAMEWORK (upstream) ═════════════════ │
│    agent_framework            Agent · Message · tool · WorkflowBuilder │
│    agent_framework.orchestrations  Sequential/Concurrent/Handoff/      │
│                                    GroupChat/Magentic builders         │
│    agent_framework.a2a        A2AAgent                                 │
│    agent_framework.observability  enable_instrumentation               │
├────────────────────────────────────────────────────────────────────────┤
│  gateway/llm_gateway.py  →  Bifrost  →  Azure OpenAI / Anthropic / …   │
└────────────────────────────────────────────────────────────────────────┘
```

### Version pins

`src/nemo/agent-service-maf/pyproject.toml`, optional-dependency group `agent-framework`:

| Package | Pin | Provides |
|---|---|---|
| `agent-framework-core` | `>=1.13.0` | `Agent`, `Message`, `tool`, `WorkflowBuilder`, `BaseChatClient` and the layer mixins |
| `agent-framework-orchestrations` | `>=1.0.0` | `SequentialBuilder`, `ConcurrentBuilder`, `HandoffBuilder`, `GroupChatBuilder`, `MagenticBuilder`, `StandardMagenticManager` |
| `agent-framework-a2a` | `>=1.0.0b260730` | `A2AAgent` |
| `a2a-sdk` | `>=1.1.0,<2` | Agent Card resolution + transport |
| `protobuf` | `>=6.33.5,<7` | a2a gRPC transport |

There is **no monolithic `agent-framework` meta-package pin** — the sub-packages are versioned separately, which matters because `orchestrations` moves faster than `core`.

> **Drift to be aware of:** `uv.lock` still pins `agent-framework-core` at **1.9.0** while `pyproject.toml` floors it at `>=1.13.0`. Container builds run `pip install ".[agent-framework,...]"` and resolve fresh, so the lock is not what production gets. Several workarounds in the code are written against 1.9 behaviour (see §12).

---

## 2. The pluggable-framework seam

MAF is not hard-wired. It is registered behind an abstraction, which is what let the service migrate off Semantic Kernel/Agno without touching the interface layer.

```
                      FrameworkRegistry
                            │
        @FrameworkRegistry.register("maf")     @FrameworkRegistry.register("echo")
                            │                              │
                  AgentFrameworkAdapter                EchoAgent
                            │                              │
                            └──────────► BaseAgent ◄───────┘
                                            │
                                  abstract surface:
                                    invoke(request, ctx)  -> AgentResponse
                                    stream(request, ctx)  -> AsyncIterator[AgentEvent]
                                    get_capabilities()    -> AgentCapabilities
                                  concrete:
                                    initialize(ctx) / shutdown()
```

`agent.framework` in config selects the adapter. Today only two are registered — `maf` (production) and `echo` (dependency-free test double). The old `semantic_kernel` and `agno` adapters are gone from this service; `semantic-kernel` is not even a dependency any more.

**The config section is still called `semantic_kernel`.** That is pure back-compat with stored team configs and the config-service wire format — the schema itself is framework-agnostic and is read by the MAF adapter.

---

## 3. `BifrostChatClient` — the load-bearing integration point

Everything MAF does with an LLM goes through one class. Getting its layer stack right is what unlocks tool calling, telemetry, and middleware.

```python
class BifrostChatClient(
    ChatMiddlewareLayer,      # per-call middleware hooks
    FunctionInvocationLayer,  # ← the automatic tool-calling loop
    ChatTelemetryLayer,       # gen_ai.* OTel spans
    BaseChatClient,           # the actual provider contract
):
    OTEL_PROVIDER_NAME = "bifrost"
```

The MRO mirrors what MAF's own built-in providers use. **`FunctionInvocationLayer` is not optional**: without it MAF logs "does not support function invoking" and tools are silently never executed. With it, the loop is automatic:

```
   agent.run(messages, tools=[...])
            │
            ▼
   ┌──────────────────────────────────────────────────┐
   │ FunctionInvocationLayer                          │
   │                                                  │
   │  ┌─► call model ──► response has function_call?  │
   │  │                        │            │         │
   │  │                       yes           no ──► return text
   │  │                        ▼                      │
   │  │   invoke matching FunctionTool                │
   │  │   append function_result to messages          │
   │  └────────────────────────┘                      │
   └──────────────────────────────────────────────────┘
```

### What the client implements

| Member | Role |
|---|---|
| `_inner_get_response(..., stream: bool, ...)` | The single `BaseChatClient` hook. `stream=False` → one completion; `stream=True` → an async update stream. There is no separate `_inner_get_streaming_response`. |
| `get_response()` | **Overridden** purely to work around an AF 1.9 bug that mis-categorises `FunctionMiddleware` (e.g. `_AutoHandoffMiddleware`) and drops it at the chat layer. The override re-routes it. |
| `as_agent(...)` | Inherited from `BaseChatClient`. This is how a chat client becomes an `Agent` — used by both `MafAgentBuilder.build_agent` and `BuiltMafAgent.make_runner`. |
| `service_url()` | Feeds AF telemetry. |

### `ChatOptions` → Bifrost request

| MAF option | Becomes |
|---|---|
| `instructions` | Prepended `{"role": "system", ...}` message |
| `model` | `model` (falls back to the client's resolved default) |
| `temperature`, `max_tokens` | Same, with client-level fallback |
| `tools` | `FunctionTool.to_json_schema_spec()` → OpenAI tool definitions |
| `tool_choice` | Passed through when tools are present |
| `response_format` | Pydantic class → JSON-schema envelope, or dict passthrough |

Message conversion handles the three content kinds: text, `function_call` → `tool_calls`, and `function_result` → `role: "tool"` messages.

> A defensive detail worth knowing: `temperature` and `max_tokens` are held **on the client** as well as in `default_options`, because AF was observed not forwarding an agent's `default_options` into the per-call `options` mapping — which silently dropped the token cap and left responses uncapped.

### Usage, cost, and timing capture

Two mechanisms, because single-agent and streaming-orchestration need different ones:

```
   per-client instance counters              ContextVar buffer
   ───────────────────────────               ─────────────────
   _accumulate_usage()                       usage_capture_scope()
   _llm_duration_ms                                 │
   _llm_call_count                          _record_usage_to_context()
        │                                           │
   get_accumulated_usage()                   sum_token_usage(buf)
        │                                           │
   single-agent + non-streaming              streaming orchestration
   orchestration (_read_total_usage          (AF records streamed usage
   sums every participant + manager)          ONLY into the ContextVar)
```

Each `reset_usage()` also mints a fresh **`transaction_id` UUID**, and the first call emits a one-shot `spend_attribution` record binding `correlation_id → transaction_id → agent_id → project_id`. That is the join key that lets Bifrost's cost data be attributed back to a specific agent run.

---

## 4. From config to a running agent

```
 semantic_kernel.agents[]  (SKAgentDefinition)
            │
            ▼
   MafAgentBuilder.build_agent()
            │
            ├─ _validate_agent_name()        ^[a-zA-Z0-9_-]{1,64}$
            ├─ MafModelResolver              agent override → global default
            │     model · temperature · max_tokens
            ├─ output_schema validated by build_outcome_model()
            │     invalid schema → warn + drop (never crash the run)
            ├─ BifrostChatClient(gateway, agent_id, model, temp, max_tokens)
            └─ client.as_agent(name, instructions, description, default_options)
                        │
                        ▼
                 BuiltMafAgent
                   .runner   → agent_framework.Agent
                   .client   → BifrostChatClient  (usage/timing)
                   .agent_def→ source config (so tools can be rebuilt)
                   .make_runner(tools=…, require_handoff_persistence=…)
```

`make_runner()` is important: orchestration rebuilds a **fresh runner per invocation** with that invocation's tools bound, while sharing the same `BifrostChatClient` so usage keeps accumulating on one set of counters.

Note what the builder deliberately does *not* do: **tools are not built here.** They are constructed per invocation by the adapter so each request gets a clean `tool_history` for citations.

Also note what MAF handles natively: **the system prompt is not prepended to the message list.** AF agents carry their instructions and inject them via `ChatOptions`, so `_build_history_messages` only replays session history — prepending a system message would duplicate it.

---

## 5. Capability matrix — what you can actually do

| Capability | Supported | Where |
|---|---|---|
| Single agent, sync invoke | yes | `adapter._invoke_single` |
| Single agent, token streaming | yes | `adapter._stream_single` |
| Multi-agent: sequential | yes | `SequentialBuilder` |
| Multi-agent: concurrent | yes | `ConcurrentBuilder` |
| Multi-agent: handoff | yes | `HandoffBuilder` (autonomous mode) |
| Multi-agent: triage / routing | yes | `SequentialBuilder` + `as_tool` router |
| Multi-agent: group chat | yes | `GroupChatBuilder` |
| Multi-agent: magentic (Magentic-One) | yes | `MagenticBuilder` + `StandardMagenticManager` |
| Multi-agent: arbitrary graph | partial | `WorkflowBuilder` — edges yes, **conditions no** |
| Python function tools | yes | `tools._make_function_tool` |
| MCP tools (stdio / SSE / streamable-HTTP) | yes | `tools._make_mcp_tool` |
| Per-server tool whitelisting | yes | `allowed_tools_by_server` |
| Guardrails on tool calls | yes | `check_tool` as MAF auth hook |
| Structured output (JSON Schema) | yes | `output_schema` → `response_format` |
| Conversation memory | yes | in-memory or Redis session store |
| External agents (A2A) | yes | `A2AParticipant` wrapping `agent_framework.a2a.A2AAgent` |
| Per-agent lifecycle events while streaming | yes | `AGENT_STARTED` / `AGENT_COMPLETED` |
| Wall-clock budget (hard + graceful) | yes | `_resolve_orchestration_timeout` |
| OTel / OpenInference tracing | yes | `enable_af_observability` |
| Human-in-the-loop pause (`request_info`) | **no** | handoff runs autonomous-mode only |
| Agent instance pooling | **no** | adapter built and torn down per request |

---

## 6. Orchestration topologies

`SUPPORTED_ORCHESTRATION_TYPES` = `{sequential, concurrent, handoff, triage, group_chat, magentic, graph}`. **`single` is not in that set** — it bypasses the workflow engine entirely and calls `agent.runner.run()` directly.

Workflows are built **per invocation**. That is cheap (it only wires pre-built agents) and guarantees nothing request-scoped leaks between calls.

Two universal safety rails:

- **Single-member fallback.** Any multi-agent type with exactly one participant degrades to `sequential`. This mirrors the tolerance the legacy Agno/SK adapters had.
- **Round ceiling.** `_bounded_rounds()` = `min(max_rounds, termination_strategy.maximum_iterations, 50)`. The hard ceiling `_MAX_ROUNDS_CEILING = 50` means a misconfigured or looping LLM cannot run unboundedly.

### 6.1 `single`

```
   user input ──► [ agent ] ──► output
                     │
                  tools (function + MCP)
```

The only path that streams real tokens live. Everything else replays a terminal answer.

### 6.2 `sequential`

```
   input ──► [ agent A ] ──► [ agent B ] ──► [ agent C ] ──► output
              (each sees the running conversation; last one answers)
```

`SequentialBuilder(participants=participants).build()`. Order is the definition order in `semantic_kernel.agents[]`.

> `orchestration.agent_order` exists in the schema but is **not consumed** by this builder. Reordering the `agents[]` array is the only way to change order today.

### 6.3 `concurrent`

```
                ┌──► [ agent A ] ──┐
   input ───────┼──► [ agent B ] ──┼──► default aggregator ──► output
                └──► [ agent C ] ──┘
```

`ConcurrentBuilder(participants=participants).build()`. No extra knobs.

### 6.4 `handoff`

Agents delegate to one another through LLM-driven handoff tool calls along configured edges.

```
   config.handoffs[] = [{source, target, description}, …]

              ┌───────────────┐   handoff("billing")
   input ───► │  triage       │ ─────────────────────┐
              └───────────────┘                      ▼
                    ▲                        ┌───────────────┐
                    │  handoff("triage")     │   billing     │
                    └────────────────────────└───────────────┘
                                                     │
   turn_limits = {each agent: _bounded_rounds(config)}
   empty handoffs[]  →  fully connected graph (every agent ↔ every agent)
   start agent       →  selection_strategy.initial_agent, else agents[0]
```

Built with `HandoffBuilder(...).with_start_agent(...)` + `add_handoff(...)` per edge + `with_autonomous_mode(turn_limits=…)`.

**Autonomous mode only.** MAF's `HandoffBuilder` can also pause for a human via `request_info`; AgentStudio does not use that, because the REST/SSE surface is non-interactive and a pause would simply stall the request.

Handoff is also the only topology whose participants get `require_per_service_call_history_persistence=True` — `HandoffBuilder` requires it.

### 6.5 `triage`

This is the topology that deviates most from stock MAF, and the reasoning matters.

```
   ┌─────────────────────────────────────────────────────────────┐
   │  router (synthesized manager agent)                         │
   │    tools = [ specialist_A.as_tool(), specialist_B.as_tool(), │
   │              specialist_C.as_tool() ]                        │
   └─────────────────────────────────────────────────────────────┘
            │  LLM picks exactly one tool
            ▼
     ┌──────────────┐
     │ specialist B │   runs as a TOOL CALL, not a workflow executor
     └──────────────┘
            │
            ▼  answer returned to router, router relays it
          output

   builder: SequentialBuilder(participants=[router]).build()
```

**Why not `HandoffBuilder`?** The module docstring still claims triage uses it — that is stale. It was abandoned because `HandoffBuilder` creates a conversational multi-hop loop: it fans an `AgentExecutorRequest` out to every specialist, inserts `request_info` pauses, and stalls in a non-interactive REST/SSE context. Triage needs exactly one hop — route once, answer once — and `Agent.as_tool()` expresses that directly.

The consequence is that specialists never emit `executor_invoked` / `executor_completed` events. Their lifecycle has to be **re-sourced from the router's `FunctionCall` / `FunctionResult` content** (`_delegation_call` / `_delegation_result` / `extract_tool_delegation_steps`), which is why triage has extra event-mapping machinery.

Per-specialist tool descriptions come from each agent's `description` field, so **writing good agent descriptions is what makes triage route correctly.**

### 6.6 `group_chat`

```
   selection_strategy.type
      │
      ├── "sequential" | "round_robin"  ──► deterministic round-robin selector
      │        (initial_agent sets the start offset)
      │
      └── "auto" | "kernel_function"    ──► LLM orchestrator agent
               (manager_* knobs; selection_strategy.function_prompt
                becomes the manager's instructions)

   GroupChatBuilder(participants=eligible, …, output_from="all")
      .with_max_rounds(_bounded_rounds(config))
      .with_termination_condition(keyword_termination)   ← if keywords set

   selection_strategy.candidate_agents  →  restricts the eligible subset
```

An adapter-side subtlety: the group-chat manager is **excluded** from `participant_names`. Its terminal "max rounds reached" notice is not a user-facing answer, so leaving it in would make the trace attribute the final response to the orchestrator instead of the last real speaker.

### 6.7 `magentic`

Magentic-One: a planner-manager decomposes the task and coordinates participants autonomously.

```
   ┌──────────────────────────────────────────────┐
   │  StandardMagenticManager                     │
   │    - builds a task ledger                    │
   │    - create_progress_ledger() each round     │
   │    - picks next_speaker                      │
   │    - decides is_request_satisfied            │
   └──────────────────────────────────────────────┘
          │            │            │
     [ agent A ]  [ agent B ]  [ agent C ]

   MagenticBuilder(participants=…, manager=manager).build()
   max_round_count = _bounded_rounds(config)
```

**Keyword termination needed a subclass.** `MagenticBuilder` has no `with_termination_condition` hook (group chat does), so `_keyword_terminating_magentic_manager()` subclasses `StandardMagenticManager` and short-circuits `create_progress_ledger`: when a stop keyword appears in the latest message it forges a ledger with `is_request_satisfied=True`, which makes the orchestrator produce the final answer and stop.

**Magentic gets a single task message.** No session replay — upstream raises *"Magentic only support a single task message to start the workflow."* The turn is still persisted to the session afterwards; only the replay *into the planner* is unsupported. Consequently `context_used` is `None` for magentic runs.

### 6.8 `graph`

```
   config.edges[] = [{source, target, condition}, …]

   WorkflowBuilder(start_executor=<initial_agent>, output_from="all")
        .add_edge(source_runner, target_runner)   ← per edge, deduped
        …
   empty edges[]  →  builder.add_chain(participants)   (sequential chain)
```

Uses core `WorkflowBuilder`, not the orchestrations sub-package.

> **`GraphEdge.condition` is parsed but never wired.** The validator accepts it and example configs use it (`graph_flow.json` has a `REVISION_NEEDED → writer` revision loop), but `_build_graph` only passes `source` and `target` to `add_edge`. Conditional routing does not work today — the edge fires unconditionally.

### Topology quick reference

| Type | MAF class | Primary config |
|---|---|---|
| `single` | *(none — direct `Agent.run`)* | — |
| `sequential` | `SequentialBuilder` | participant order |
| `concurrent` | `ConcurrentBuilder` | — |
| `handoff` | `HandoffBuilder` | `handoffs[]`, `selection_strategy.initial_agent`, `max_rounds` |
| `triage` | `SequentialBuilder` + `as_tool` | `manager_*`, agent `description`s |
| `group_chat` | `GroupChatBuilder` | `selection_strategy.*`, `max_rounds`, `termination_strategy.keywords` |
| `magentic` | `MagenticBuilder` + `StandardMagenticManager` | `manager_*`, `max_rounds`, keywords |
| `graph` | `WorkflowBuilder` | `edges[]`, `selection_strategy.initial_agent` |

---

## 7. Timeouts and termination

Termination is split across two layers, which is easy to trip over.

**In the orchestration builder** — only keyword and round-count termination:

```
_bounded_rounds()  = min(max_rounds, maximum_iterations, 50)
keywords           → group_chat: with_termination_condition()
                   → magentic:   _KeywordTerminatingMagenticManager
```

**In the adapter** — the wall-clock budget:

```
termination_strategy.type == "timeout"  AND  timeout_seconds set
   → GRACEFUL cap: on expiry, return the last collected participant output
     with terminated_by="timeout" (streams the workflow so partial progress
     is observable)

any other type WITH timeout_seconds
   → HARD cap: raises AgentInvocationError on expiry

no timeout_seconds
   → HARD cap derived from max_rounds × 30s, else 300s default
```

The derived default exists so an always-on budget bounds every orchestration, matching the legacy SK behaviour. `_ORCHESTRATION_TIMEOUT_DEFAULT = 300.0`, `_SECONDS_PER_ROUND_HEURISTIC = 30.0`.

> Termination types `aggregator`, `kernel_function`, and `approval` are accepted by the schema but **degrade silently to the round cap** — they are not implemented in the MAF builder.

---

## 8. Tools

### The two kinds

```
   agent_def.tool_bindings[]  ──► FunctionBinding ──► _make_function_tool()
                                       │                      │
                                  function_ref           agent_framework.tool(
                                  (Python callable)        _exec, name, description,
                                                           schema derived from signature)

   agent_def.mcp_servers[]    ──► MCP registry schemas ──► _make_mcp_tool()
   agent_def.tools[]                                            │
                                                          agent_framework.tool(
                                                            _exec, name, description,
                                                            schema = MCP input_schema)
```

Both end up as `agent_framework.FunctionTool` objects passed to `runner.run(messages, tools=…)`.

### Build order and scoping

```
1. MCP servers  (all tools from each linked server)
2. Named MCP tools from agent_def.tools[]
3. Function bindings
   → de-duplicated by tool name; first wins
```

Scoping is enforced at **three** points, deliberately:

```
   ┌─ build time ─────────────────────────────────────────────┐
   │  allowed_servers = set(agent_def.mcp_servers)            │
   │  a tools[] entry naming a tool on an unlinked server is   │
   │  DROPPED and logged — never satisfied from another        │
   │  agent's server in the shared team registry               │
   │                                                           │
   │  per_server_whitelist = allowed_tools_by_server           │
   │  non-empty → only those tools exposed                     │
   │  empty/absent → all of that server's tools                │
   └───────────────────────────────────────────────────────────┘
   ┌─ call time (defense in depth) ───────────────────────────┐
   │  _exec re-checks server_name ∈ allowed_servers            │
   └───────────────────────────────────────────────────────────┘
   ┌─ gateway ────────────────────────────────────────────────┐
   │  x-bf-mcp-include-tools header bounds what the LLM sees   │
   └───────────────────────────────────────────────────────────┘
```

That third layer deserves its own explanation.

### The `x-bf-mcp-include-tools` header

The project virtual key in Bifrost carries **every** MCP client registered for the project (config-service has to map each tool onto the VK for it to be reachable at all). If the request carried no scope header, Bifrost would expand that full VK scope into this agent's completion — exposing project MCP tools to an agent that was never configured with any.

So `_bifrost_mcp_scope()` binds a per-request header for the duration of every `runner.run(...)`:

```
   value = comma-separated  "<projectId>_<serverName>-<toolName>"
                            "<projectId>_<serverName>-*"    (no whitelist)

   project_id missing        → header NOT sent (not applicable)
   no MCP servers linked     → EMPTY STRING = Bifrost "deny all"   ◄── load-bearing
```

Sending an empty string rather than omitting the header is the part that is easy to get wrong. The code gates on `value is not None`, not truthiness, precisely so a tool-less agent stays tool-less.

For orchestration the header is the **union** across all participants. That is a "what the LLM sees" bound, not enforcement — strict per-sub-agent scoping would need a hook inside the MAF runner. Execution-time enforcement remains per-agent via `build_toolset`'s whitelist.

### Guardrails as the MAF auth hook

```
   adapter._build_auth_hook(context)
        │
        └─► async (tool_name, params) -> bool
                 │
                 └─► guardrails.check_tool(...)
                          ToolCallCounter · ToolAuthorizer · ToolParamValidator
                          │
                     GuardrailError → return False
```

Inside `_make_mcp_tool`, the hook runs **before** `mcp_registry.call_tool` — a blocked call never reaches the MCP server. Denial is then **soft-failed** back to the model as `"ERROR: … denied"` rather than aborting the turn. That is an intentional divergence from the SK adapter: the model gets a chance to recover or explain instead of the whole request failing.

### `tool_history` and citations

Each toolset carries a fresh `tool_history` list that fills as a side effect while the agent runs:

| Key | Always | Notes |
|---|---|---|
| `tool_name`, `arguments`, `result`, `duration_ms`, `tool_type` | yes | |
| `error` | on failure | |
| `kb_citations` | function tools | knowledge-base retrieval results |
| `tokens_used` | optional | |

`MafEventMapper.build_tool_executions()` turns that into the wire `toolExecutions[]` (200-char result summaries), which is what the UI renders in the trace panel.

---

## 9. External agents over A2A

Remote agents become first-class MAF participants, indistinguishable from local ones inside orchestration.

```
   config-service a2a_servers record
            │
            ▼
   A2ACardResolver  →  GET /.well-known/agent-card.json
                             (or /.well-known/agent.json, or agentCardPath)
            │
            ▼
   agent_framework.a2a.A2AAgent(agent_card, http_client, timeout,
                                interceptor=_ApiKeyAuthInterceptor?)
            │
            ▼
   A2AParticipant(built)      ← implements TeamParticipant
            │
            └─► appended after local agents in adapter._agents
```

`TeamParticipant` is the protocol both `BuiltMafAgent` and `A2AParticipant` satisfy: `name`, `description`, `agent_def`, `runner`, `client`, `make_runner(...)`.

The tell is `agent_def is None`. That single field drives every difference:

- no local toolset is built (the remote agent brings its own tools)
- it contributes nothing to the `x-bf-mcp-include-tools` union
- it has a `ZeroUsageClient`, so it adds no tokens or cost to the aggregate
- `make_runner()` ignores local tools
- handoff topology is blocked at bundle load when an A2A member is present

Transport is negotiated from the Agent Card by `a2a-sdk` (HTTP or gRPC). API-key auth is applied both to the card fetch and to task calls via a `ClientCallInterceptor`.

---

## 10. Streaming and the event contract

Single-agent and multi-agent stream very differently, and the difference is a product decision, not a limitation.

```
 SINGLE                                MULTI-AGENT
 ──────                                ───────────
 started                               started
 token  "The"                          agent_started   {agentName: "researcher"}
 token  " answer"                      agent_completed {agentName, durationMs}
 token  " is"                          agent_started   {agentName: "writer"}
 …live model tokens…                   agent_completed {agentName, durationMs}
 completed {invokeResponse}            token  "<the single final answer>"
                                       completed {invokeResponse}
```

Per-agent output is **not** streamed in the multi-agent case. If it were, the chat bubble would show a concatenation of every agent's turn instead of the final answer. Progress is conveyed by the lifecycle events; the answer arrives once, at the end.

`EventType`: `started`, `thinking`, `token`, `tool_call`, `tool_result`, `artifact`, `agent_started`, `agent_completed`, `error`, `completed`.

Both paths terminate in a `completed` event whose metadata carries the **same `invokeResponse` payload** the synchronous REST call returns — `agentTrace`, `citations`, `usage`, `performance`. Sync and streaming can never disagree because `_assemble_orchestrated_response` is shared.

### The event-mapping problem

MAF emits different event shapes per topology, and streaming duplicates them. `event_mapper.py` exists entirely to normalise this:

| Topology | What MAF emits |
|---|---|
| sequential / concurrent | `executor_completed` carrying a list of `AgentExecutorResponse` |
| group_chat / handoff / graph | per-turn `output` events + a deduped `executor_completed` |
| triage | nothing per specialist — only `FunctionCall` / `FunctionResult` on the router |

Three de-duplication layers were needed:

- **`_is_stream_update()`** — filters `*Update` types so a streaming agent's every token doesn't fire its own `agent_completed`.
- **`state["closed"]`** — guarantees exactly one `AGENT_COMPLETED` per turn. Gating on *turn state* rather than on output text is what stops the "0 ms started/completed storm" for agents whose text differs between duplicate emissions.
- **`_dedupe_stream_steps()`** — a streamed turn appears as text `output` + an empty usage-only `output` + a terminal `executor_completed` with the same text. The empty row wedged in the middle defeats adjacent-duplicate collapsing, so empties are dropped first.

There is also a **straggler drain**: in triage/handoff the router fans a request out to every specialist, and the ones it did not route to complete with empty data. Without draining them, those agents would spin forever in the UI while the real answer streamed past.

And a **three-tier fallback** for extracting per-agent turns, because `get_final_response()` on handoff/triage returns a result that does not carry them:

```
   1. extract from the final result
   2. fall back to the raw collected event list
   3. fall back to reconstructing text from AgentResponseUpdate deltas
```

---

## 11. Configuration reference

The MAF-relevant slice of `AgentConfig`.

### `semantic_kernel` (the framework-agnostic agent section)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `agents` | `list[SKAgentDefinition]` | one `"default"` agent | The agent definitions |
| `orchestration` | `OrchestrationConfig` | `type: "single"` | Topology |
| `default_function_choice_behavior` | `str` | `"auto"` | Default tool-calling mode |
| `chat_history_reducer` | `dict \| None` | `None` | Reducer config |
| `chat_history_max_messages` | `int` | `100` | Reduction trigger (1–10000) |
| `enable_telemetry` | `bool` | `false` | Turns on AF OTel instrumentation |
| `enable_sensitive_telemetry` | `bool` | `false` | Puts prompt/completion bodies on spans |
| `session_ttl_seconds` | `int` | `3600` | TTL for stale `AgentThread`s |

### `SKAgentDefinition`

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | `str` | required | `^[a-zA-Z0-9_-]{1,64}$`, unique |
| `instructions` | `str` | `""` | System prompt |
| `description` | `str` | `""` | **Drives triage routing and group-chat selection** |
| `model` | `str \| None` | `None` | Override; else the global default |
| `model_display_name` | `str \| None` | `None` | UI/citation label only |
| `temperature` | `float \| None` | `None` | 0.0–2.0 |
| `max_tokens` | `int \| None` | `None` | 1–200000 |
| `top_p`, `presence_penalty`, `frequency_penalty` | `float \| None` | `None` | Sampling knobs |
| `response_format` | `str \| None` | `None` | `"text"` / `"json_object"` |
| `output_schema` | `dict \| None` | `None` | JSON Schema → `parsedOutput` |
| `tools` | `list[str]` | `[]` | Named MCP tools |
| `mcp_servers` | `list[str]` | `[]` | MCP server names (all tools) |
| `allowed_tools_by_server` | `dict[str, list[str]]` | `{}` | Per-server whitelist |
| `tool_bindings` | `list[str]` | `[]` | Names from the top-level catalogue |
| `function_choice_behavior` | `str` | `"auto"` | `auto` / `required` / `none` |
| `prompt_template` | `str \| None` | `None` | Jinja2/Handlebars |
| `skip_post_tool_synthesis` | `bool` | `false` | Return the first tool result without a second LLM call |

### `OrchestrationConfig`

| Field | Default | Applies to |
|---|---|---|
| `type` | `"single"` | — |
| `max_rounds` | `20` | group_chat, handoff, magentic |
| `handoffs[]` | `[]` | handoff |
| `edges[]` | `[]` | graph |
| `agent_order[]` | `[]` | *(declared, not consumed)* |
| `selection_strategy.type` | `"sequential"` | group_chat |
| `selection_strategy.initial_agent` | `None` | group_chat, handoff, graph |
| `selection_strategy.candidate_agents[]` | `[]` | group_chat |
| `selection_strategy.function_prompt` | `None` | group_chat (LLM selection) |
| `termination_strategy.type` | `"default"` | all |
| `termination_strategy.maximum_iterations` | `10` | all |
| `termination_strategy.keywords[]` | `[]` | group_chat, magentic |
| `termination_strategy.timeout_seconds` | `None` | all (1–3600) |
| `manager_model` / `magentic_manager_model` | `None` | triage, group_chat (auto), magentic |
| `manager_instructions` | `None` | same |
| `manager_name` | `"orchestrator"` | same |
| `manager_temperature`, `manager_max_tokens` | `None` | same |

### A worked example — single agent with MCP

```json
{
  "_schema_version": "2.0.0",
  "project_id": "550e8400-e29b-41d4-a716-446655440000",
  "agent": {
    "framework": "maf",
    "model": "azure/gpt-4.1-mini",
    "temperature": 0.7,
    "max_tokens": 4096
  },
  "semantic_kernel": {
    "agents": [
      {
        "name": "assistant",
        "instructions": "You are a helpful assistant with access to external tools via MCP.",
        "mcp_servers": ["weather"],
        "function_choice_behavior": "required"
      }
    ],
    "orchestration": { "type": "single" }
  },
  "mcp_servers": [
    { "name": "weather", "transport": "streamable-http", "url": "https://…/mcp", "enabled": true }
  ],
  "guardrails": {
    "enabled": true,
    "input_guardrails": [
      { "name": "input_validator", "type": "validation", "config": { "max_length": 10000 } }
    ]
  }
}
```

Reference configs live in `configs/team/`: `single_agent_mcp.json`, `group_chat.json`, `handoff_support.json`, `graph_flow.json`, `triage_router.json`. The fully annotated template is `configs/agent_config.reference.yaml` (851 lines).

---

## 12. Request lifecycle, end to end

```
 POST /api/v1/projects/{pid}/agent-teams/{tid}/invoke
        │
        ▼
 LazyTeamRegistry.get_or_load_team(pid, tid)          ← TeamBundle cached
        │                                                per (project, team)
        │  cache miss:
        │    config-service GET /agents|/agent-teams|/mcp-servers
        │       → remote_adapter  (records → MAF JSON)
        │       → team_loader     (compose members, MCP, KB bindings)
        │       → ConfigLoader    (defaults → env → JSON → overrides)
        │       → frozen AgentConfig + gateway + MCPManager
        │         + guardrails + SessionManager
        ▼
 AgentExecutionContext { config, gateway, mcp_registry, a2a_agents,
                         guardrails, session_manager, identity,
                         correlation_id }
        │
        ▼
 AgentExecutor
   ├─ guardrails.check_input()
   ├─ FrameworkRegistry.create("maf", config)        ← NEW ADAPTER PER REQUEST
   ├─ adapter.initialize(context)
   │     ├─ build auth hook from guardrails
   │     ├─ resolve tool_bindings → FunctionToolProvider
   │     ├─ MafAgentBuilder.build_all_agents()
   │     ├─ append A2AParticipant(s)
   │     └─ enable_af_observability()   if enable_telemetry
   ├─ adapter.invoke() | adapter.stream()
   │     ├─ single       → agent.runner.run(messages, tools)
   │     └─ orchestrated → _setup_orchestration_run()
   │                          MafOrchestrationBuilder.build(...)
   │                          workflow.run(messages[, stream=True])
   │                       under _bifrost_mcp_scope + usage_capture_scope
   ├─ guardrails.check_output()
   └─ adapter.shutdown()
        │
        ▼
 InvokeResponse { output, parsedOutput, usage, citations{ respondingAgent,
                  agentTrace[], performance, contextUsed, kbCitations },
                  metadata{ orchestration_type, agent_names, terminated_by } }
```

**There is no agent pool.** The adapter and all its MAF agents are constructed and torn down per request. What *is* cached is the `TeamBundle` (config, gateway client, MCP connections, session manager) — so the expensive part is amortised while per-request state stays clean.

Session history is persisted to an in-memory store or **Redis** (`memory.storage_backend`), never Postgres. On the streaming path persistence happens *after* the stream completes, so a partial stream never leaves a dangling user turn without its assistant reply.

---

## 13. Observability of MAF runs

`enable_af_observability(enable_sensitive_data=…)` is idempotent, process-wide, and lock-guarded. It calls upstream `agent_framework.observability.enable_instrumentation()`, which lights up the `ChatTelemetryLayer` already in `BifrostChatClient`'s MRO. Spans land on the host process's global `TracerProvider` — no exporter is created here.

Triggered by `semantic_kernel.enable_telemetry`. Prompt and completion bodies are attached only when `enable_sensitive_telemetry` is true **or** `AF_ENABLE_SENSITIVE_TELEMETRY` is set in the environment (AF instrumentation is process-wide, so a deployment-level env toggle is the practical control). Default is off.

The resulting `gen_ai.*` spans carry `OTEL_PROVIDER_NAME = "bifrost"`, are stamped with `agentstudio.project_id` and `session.id` by `PhoenixProjectSpanProcessor`, and are routed to Phoenix by the OTel collector. See `observability-architecture.md` for the full pipeline.

Business metrics emitted alongside: `agent_run_total{outcome}`, `agent_run_duration_ms`, `agent_delegation_total`, `agent_tool_calls_total`, `agent_llm_tokens_total{token_type}`, `agent_cost_usd_total{model}`, `guardrail_block_total{stage,reason}`.

---

## 14. What MAF gives us vs what AgentStudio adds

| Concern | MAF provides | AgentStudio adds |
|---|---|---|
| Agent runtime | `Agent`, instructions, tool loop | Config-driven construction, name validation, model resolution |
| LLM access | `BaseChatClient` contract | `BifrostChatClient` — VK routing, spend attribution, transaction IDs |
| Tool calling | `FunctionInvocationLayer`, `FunctionTool` | MCP bridge, three-layer scoping, guardrail auth hook, `tool_history` |
| Orchestration | 5 builders + `WorkflowBuilder` | Config mapping, round ceiling, wall-clock budgets, single-member fallback, triage-as-router |
| Multi-agent events | Raw `WorkflowEvent`s | De-duplication, lifecycle synthesis, straggler drain, 3-tier extraction |
| Memory | `AgentThread` | Redis-backed sessions, buffers, per-user caps, degradation flag |
| External agents | `A2AAgent` | Card resolution, API-key interception, participant wrapping |
| Telemetry | `enable_instrumentation` | Phoenix project stamping, business metrics, cost attribution |
| Safety | — | Full guardrail pipeline (input/output/tool), PII/PCI/PHI, injection, tool policy |
| Multi-tenancy | — | Project scoping end-to-end |

The pattern is consistent: **MAF supplies the mechanism, AgentStudio supplies the policy** — scoping, budgets, attribution, and the stable wire contract.

---

## 15. Known gaps and sharp edges

| # | Gap | Impact |
|---|---|---|
| 1 | **`GraphEdge.condition` is parsed but never wired** | Conditional graph routing silently doesn't work; edges fire unconditionally. Example configs use it. |
| 2 | **`orchestration.agent_order` is declared but not consumed** | Sequential order can only be changed by reordering `agents[]`. |
| 3 | **Termination types `aggregator` / `kernel_function` / `approval`** | Accepted by the schema, degrade silently to a round cap. |
| 4 | **Module docstring says triage uses `HandoffBuilder`** | Stale — it uses `SequentialBuilder` + `as_tool`. Misleading for anyone reading the file first. |
| 5 | **`uv.lock` pins `agent-framework-core` 1.9.0, pyproject floors `>=1.13.0`** | Lock and build resolve differently; the `get_response()` middleware workaround targets a 1.9 bug that may already be fixed. |
| 6 | **No human-in-the-loop** | `HandoffBuilder`'s `request_info` pause is unused; REST/SSE cannot service it. |
| 7 | **No agent pooling** | Adapter + all MAF agents rebuilt per request. Fine at current scale; a latency floor at high QPS. |
| 8 | **Per-sub-agent MCP scope is a union at the gateway** | The orchestrator LLM can *see* the union of all participants' tools. Execution is still per-agent enforced, but strict per-agent visibility needs a hook in the MAF runner. |
| 9 | **Guardrail tool denial is soft-failed to the model** | Deliberate (lets the model recover), but a denied call looks like a tool error rather than a hard block in the trace. |
| 10 | **Magentic cannot replay session history** | Multi-turn context is lost for the planner; only the latest input is fed. |
| 11 | **Streaming multi-agent shows no per-agent text** | By design, but users expecting live per-agent output will find only lifecycle events until the end. |

---

## 16. Quick reference

### Key files

| Concern | Path (under `src/nemo/agent-service-maf/src/agent_service_maf/`) |
|---|---|
| Adapter (the entry point) | `framework/maf/adapter.py` |
| Agent construction | `framework/maf/agent_builder.py` |
| Topologies | `framework/maf/orchestration_builder.py` |
| Tools + MCP bridge | `framework/maf/tools.py` |
| Bifrost chat client | `framework/maf/gateway_chat_client.py` |
| Event normalisation | `framework/maf/event_mapper.py` |
| Participant protocol | `framework/maf/participants.py` |
| A2A | `framework/maf/a2a_agent_builder.py` |
| AF telemetry toggle | `framework/maf/observability.py` |
| Registry / base class | `framework/registry.py`, `framework/base_agent.py` |
| Guardrail orchestration | `framework/executor.py` |
| Config schema | `config/validators.py` |
| config-service translation | `config/remote_adapter.py` |
| Team composition | `core/team_loader.py` |
| Wire types | `core/interfaces.py` |
| Sessions | `core/session.py`, `core/session_store.py` |

### Tests

`tests/unit/test_maf_adapter.py`, `test_maf_agent_builder.py`, `test_maf_tools.py`, `test_maf_gateway_chat_client.py`, `test_maf_orchestration.py`, `test_maf_orchestration_phase3b.py` (handoff / group_chat / triage / graph / magentic), `test_maf_orchestration_timeout.py`, `test_maf_observability.py`, plus `test_config_service_migration.py` for the config-service → MAF translation and `tests/e2e/test_orchestration_patterns_e2e.py` for live smoke.

### Debugging

```
Tools not being called?
  → is FunctionInvocationLayer in the client MRO? (AF logs
    "does not support function invoking" when it isn't)
  → check function_choice_behavior: "none" disables tool calls
  → check the "Built agent toolset" log line for exposed_tool_names

Agent sees tools it shouldn't?
  → x-bf-mcp-include-tools: empty string = deny-all, omitted = VK-wide
  → allowed_tools_by_server empty means "all tools", not "no tools"

Triage routes to the wrong specialist?
  → routing signal comes from each agent's `description` field

Orchestration times out unexpectedly?
  → with no timeout_seconds, the budget is max_rounds × 30s (else 300s)

Trace shows the wrong responding agent?
  → group_chat excludes the manager from participant_names on purpose
  → prefer_last applies to group_chat, magentic, handoff, triage

Magentic ignores conversation history?
  → by design; it only accepts a single task message
```
