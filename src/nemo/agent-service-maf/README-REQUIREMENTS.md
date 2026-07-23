# Agent Framework (MAF) — Requirements & Architecture

## What This Is

A **pluggable, protocol-agnostic Python service** for invoking AI agent **teams** through a single, unified HTTP/WebSocket interface — regardless of which agent framework runs underneath.

You define your teams once using a common contract. The framework handles routing, configuration, model selection, tool integration, guardrails, sessions, and async task lifecycle. Adding a new underlying agent framework (e.g. another orchestrator) is a one-file operation: implement `BaseAgent`, decorate with `@FrameworkRegistry.register("name")`, and it is immediately invocable through the same endpoints.

The shipped adapters today are:

- **`maf`** — the production adapter built on Microsoft Agent Framework, supporting nine orchestration patterns (see §5). It is the default framework (`agent.framework`).
- **`echo`** — a deterministic in-process adapter used for tests, scaffolding, and as the canonical example for new adapters.

## The Problem

Building with AI-agent frameworks couples the calling application to one framework's API, configuration format, tool system, and protocol. Swapping frameworks (or running several side-by-side for evaluation) means parallel integrations. Configuration is scattered across env vars, JSON files, and hardcoded values. Every framework handles tools differently, and switching models or providers touches code in many places.

## What This Framework Provides

### 1. Common Agent / Team Interface

Every adapter implements the same contract via `BaseAgent`:

```python
class BaseAgent(ABC):
    async def invoke(request, context) -> AgentResponse      # synchronous call
    async def stream(request, context) -> AsyncIterator       # streaming events
    def get_capabilities() -> AgentCapabilities               # self-describe
    async def initialize(context) -> None                     # set up
    async def shutdown() -> None                              # tear down
```

Callers never need to know whether they are talking to the Microsoft Agent Framework adapter, the echo adapter, or a future custom framework. Request shape, response shape, and streaming event format are identical.

A **team** is a named collection of inner agents plus an orchestration spec. Teams are project-scoped (every team config carries a UUID `project_id`) and materialised lazily on first request.

### 2. Multi-Protocol API (project-scoped)

All resource routes are project-scoped under `/api/v1/projects/{project_id}`. There are two parallel families: explicit **team-addressed** routes (the modern form) and **agent-addressed** alias routes that resolve through the default team for the project.

**Team-addressed (modern)**:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/projects/{project_id}/agent-teams` | List teams under the project |
| GET    | `/projects/{project_id}/agent-teams/{team_id}` | Team metadata + health |
| POST   | `/projects/{project_id}/agent-teams/{team_id}/invoke` | Synchronous invocation |
| POST   | `/projects/{project_id}/agent-teams/{team_id}/invoke/stream` | SSE event stream |
| POST   | `/projects/{project_id}/agent-teams/{team_id}/invoke/async` | Fire-and-forget; returns a `task_id` |
| WS     | `/projects/{project_id}/agent-teams/{team_id}/ws` | Bidirectional session |
| GET    | `/projects/{project_id}/agent-teams/{team_id}/sessions` | List sessions for the team |
| GET    | `/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}` | Fetch a session transcript |
| DELETE | `/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}` | Forget a session |

**Agent-addressed (default-team alias)**:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/projects/{project_id}/agents` | List agents discoverable in the project's default team |
| GET    | `/projects/{project_id}/agents/{agent_id}/capabilities` | What an agent supports |
| POST   | `/projects/{project_id}/agents/invoke` | Invoke the default agent of the default team |
| POST   | `/projects/{project_id}/agents/invoke/stream` | Stream from the default agent |
| POST   | `/projects/{project_id}/agents/{agent_id}/invoke` | Invoke a named agent |
| POST   | `/projects/{project_id}/agents/{agent_id}/invoke/stream` | SSE for a named agent |
| POST   | `/projects/{project_id}/agents/{agent_id}/invoke/async` | Async submit |
| WS     | `/projects/{project_id}/agents/{agent_id}/ws` | Bidirectional session for one agent |
| GET    | `/projects/{project_id}/agents/{agent_id}/sessions` | Per-agent session list |
| GET    | `/projects/{project_id}/agents/{agent_id}/sessions/{session_id}` | Per-agent session transcript |
| DELETE | `/projects/{project_id}/agents/{agent_id}/sessions/{session_id}` | Per-agent session forget |

**Tasks (async-invoke lifecycle)**:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/projects/{project_id}/tasks/{task_id}` | Poll a submitted async task (status + result) |
| DELETE | `/projects/{project_id}/tasks/{task_id}` | Cancel an in-flight task |

**Admin & system (un-prefixed except where noted)**:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/health` | Liveness probe — always 200 once the process is up |
| GET    | `/ready` | Readiness probe — gates traffic on downstream deps (Redis, MCP, config-service) |
| POST   | `/api/v1/admin/config/invalidate` | Drop a cached config record (remote source) |
| GET    | `/admin/config/status` | Cache stats for the remote config layer |

### 3. Async-Invoke Pattern

`/invoke/async` accepts the same body as `/invoke`, schedules the work as an asyncio background task, and returns a `task_id` immediately. Callers then poll `GET /projects/{project_id}/tasks/{task_id}` until status is `succeeded`, `failed`, or `cancelled` (or `DELETE` to cancel).

Tasks live in a pluggable **`TaskStore`** with two backends (in-memory and Redis) and a two-tier TTL: 10 minutes for `running`, 1 hour for terminal states. On graceful shutdown the `TaskManager` marks every in-flight task `failed` with `"Service shutting down — task aborted"` so polling clients see a clean terminal state instead of `running` zombies. Full design notes: [`docs/design/async-invoke.md`](./docs/design/async-invoke.md).

### 4. Three-Source Configuration with Two Source Modes

Configuration values are layered, with strict priority:

```
Defaults (hardcoded in agent_service_maf.config.defaults)
        ↓ overridden by
Environment variables (AGENT_* + CONFIG_* + KEYCLOAK_* + ...)
        ↓ overridden by
Source-of-truth records (config-service over HTTP, or local JSON file)
        ↓ overridden by
Per-request `config_overrides` payload (highest priority)
```

The source of truth is selected by the **`CONFIG_SOURCE`** env var:

- **`CONFIG_SOURCE=remote`** (default for production) — `RemoteConfigCache` fetches team / agent / MCP-server / KB records from the central **config-service** over HTTP, authenticating with a Keycloak service-account token (client-credentials flow). Records are cached in-process with a TTL + LRU eviction. When config-service is unhealthy, `CONFIG_STALE_WHILE_ERROR=true` (default) serves the last-known-good payload instead of 503ing the request.
- **`CONFIG_SOURCE=file`** — `FileConfigLoader` reads from `AGENT_TEAMS_DIR` (required for teams) and optional `AGENT_AGENTS_DIR`. This is the test / CI escape hatch and also what `make dev` uses out of the box. File mode auto-warms every discovered team to keep semantics bit-identical to the pre-migration eager-registration contract.

In both modes loading is **lazy**: teams materialise on first request. Operators can pre-warm specific teams via `AGENT_WARM_TEAMS=projectId/teamId,projectId/teamId,...`.

Secrets (`KEYCLOAK_CLIENT_SECRET`, `AGENT_GATEWAY__API_KEY`, etc.) MUST come from env vars — `_check_secrets_in_json` rejects them in any JSON payload regardless of source.

### 5. MAF Adapter — Nine Orchestration Patterns

The production adapter is `maf` (`@FrameworkRegistry.register("maf")`), built on Microsoft Agent Framework. Orchestration types map to AF workflow builders via `MafOrchestrationBuilder`; see §5 patterns below.

| Pattern        | Implementation                                                                    |
| -------------- | --------------------------------------------------------------------------------- |
| `single`       | `ChatCompletionAgent.invoke()` (native SK)                                        |
| `sequential`   | `SequentialOrchestration` (native SK)                                             |
| `concurrent`   | `ConcurrentOrchestration` (native SK)                                             |
| `handoff`      | `HandoffOrchestration` + `OrchestrationHandoffs` (native SK)                      |
| `group_chat`   | `GroupChatOrchestration` + `RoundRobinGroupChatManager` (native SK)               |
| `magentic`     | `MagenticOrchestration` + `StandardMagenticManager` (native SK)                   |
| `triage`       | `HandoffOrchestration` (router → specialists) (native SK)                         |
| `reflection`   | `GroupChatOrchestration` generator + critic alternating (custom dispatch)         |
| `graph`        | Custom `_agent_complete()` + `gateway.complete_with_tools()` (SK lacks a native GraphFlow) |

All native patterns run on `InProcessRuntime`. `GatewayChatCompletion` inherits from SK's `ChatCompletionClientBase` with `SUPPORTS_FUNCTION_CALLING=True`, so SK's built-in auto function-invocation loop drives tool calls.

### 6. LLM Gateway (Bifrost — External)

The framework never calls LLM provider APIs directly. All model interactions go through a thin **`BifrostClient`** that forwards requests to an external **Bifrost** proxy. Bifrost handles:

- **Model routing** — a single string like `anthropic/claude-sonnet-4-20250514` resolves to the right provider
- **Automatic fallback** — primary → fallback models on rate-limit or provider error
- **Cost & token accounting** — totals returned in the response
- **Rate limiting** — RPM / TPM enforced at the gateway
- **Provider abstraction** — Anthropic, OpenAI, Azure, Cohere, anything Bifrost speaks

`agent_service_maf.gateway` is a **thin client only** (`http_llm_client.py`, `llm_gateway.py`, `tool_strategy.py`, `cost_tracker.py`, `secret_redactor.py`). It points at Bifrost's URL, forwards requests, normalises responses, and redacts secrets from logs. It does not own models, costs, caching, or rate-limit policy.

> Note: `litellm` is still listed as a transitional dependency in `pyproject.toml` for legacy code paths and is being removed as the BifrostClient migration completes.

### 7. MCP Tool Integration

Tools are exposed as **MCP (Model Context Protocol)** server connections. Two configuration shapes are supported:

- **Inline (v2.0.0 config)** — each team config carries an `mcp_servers[]` array directly. Used by file-source teams.
- **By ID (remote)** — agents carry `mcp_servers: ["server-id", ...]`, the team loader resolves every unique id against config-service via `get_mcp_server`, folds the inline shape into the team payload, and rewrites each agent's list from `id → server name`.

`MCPManager.connect_all()` runs at first-materialisation (post-build lifecycle hook) unless `mcp.lazy_connect=true`, which defers the connect until the first tool call. `transport_factory.py` picks the right MCP transport (`stdio`, `sse`, `streamable-http`) based on the inline shape; `MCPKernelPlugin.from_mcp_servers` then bridges every discovered MCP tool into the SK kernel, honouring per-server `default_arguments` and tool allow/deny lists.

A separately runnable adapter (`python -m agent_service_maf.interface_layer.protocols.mcp_server`) lets the service expose itself **as** an MCP server to other clients.

### 8. Guardrails Pipeline

Every invocation passes through a three-stage pipeline. Guardrails are **per-agent configurable** through the catalog at `agent_service_maf/guardrails/catalog/`:

**Three stages:**

| Stage     | Catalog (representative)                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| **input** | `prompt_injection`, `pii_masker`, `phi_masker`, `pci_masker`, `secret_leakage`, `custom_regex`, `word_blocklist`, `adversarial_unicode`, `input_validator`, `system_prompt_leakage`, `content_filter`, `language` |
| **output**| `schema_validator`, `output_length`, `output_sanitizer`, `system_prompt_leakage`, `language`                          |
| **tools** | `tool_authorizer`, `tool_result_guard`, `param_validator`                                                             |

Each guardrail returns one of `BLOCK` / `MODIFY` / `WARN`. Authorising-class guardrails (`tool_authorizer`) gate which tools an agent may call. Sanitisers replace content in place (e.g. `pii_masker` rewrites `john@example.com → [EMAIL_REDACTED]`). Schema validators emit `WARN` by default but can be configured to `BLOCK`.

**Per-agent overrides**: a `"customer-support"` agent might enforce strict PII masking with a narrow tool allowlist; a `"code-review"` agent might disable PII masking but enforce strict output schema. Both modes share the same registry — they only differ in configured rules.

**Fail-safe modes**: `guardrails.enabled=false` disables every check; `guardrails.fail_open=true` logs guardrail errors but still allows the request through (handy during development).

Some guardrails require optional extras (e.g. `secret_leakage` lazily imports `detect-secrets` from the `guardrails-secrets` extra). They raise `ConfigurationError` if the extra is missing while the guardrail is enabled.

### 9. Sessions & Memory

The framework ships a pluggable `SessionStore` (in-memory + Redis) and a `MemoryBuffer` integrated into every invocation. Session IDs flow either through the WebSocket lifecycle or via the `context.sessionId` field in the request. Configured retention is per-team via the `memory.*` config section; eviction is driven by a TTL plus a max-message cap.

### 10. Built-in Tool Functions

Native Python tools that bypass MCP (and skip its serialisation overhead) live in `agent_service_maf/tools/functions/`. The shipped tool is `kb_retrieve` — a thin call into the in-cluster `kb-retrieval-service` (`KB_ENDPOINT_URL`) returning passages + citations. Tools self-register via `@register_function("name")` and are bound to agents via the `tools[]` field in the agent config.

### 11. Output-Schema Validation (Option B)

Agents can declare a JSON Schema that their output is validated against on every invocation. When the LLM's output matches, `InvokeResponse.parsedOutput` carries the type-coerced, validated dict; on a mismatch it stays `null` and the raw `output` text is preserved.

Two **independent** agent-config knobs on `SKAgentDefinition`:

| Field             | Type                              | Purpose                                                                                    |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `response_format` | `"text" \| "json_object" \| null` | Provider-side hint pushed via `prompt_execution_settings`. No server validation.            |
| `output_schema`   | JSON Schema dict / `null`         | Server-side validator. MAF parses + validates every invocation and populates `parsedOutput`. |

Per-request `context.outputSchema` overrides `agent.output_schema`. Validation failures never block the response — they emit a structured `parsed_output_validation_failed` WARNING log and `parsedOutput` falls to `null`. Full spec + supported JSON-Schema subset: see [README-DEVELOPMENT.md → Per-request and agent-level output schemas](./README-DEVELOPMENT.md#per-request-and-agent-level-output-schemas-option-b) and `agent_service_maf/framework/_outcome_schema.py`.

### 12. Streaming Event System

All adapters emit the same event vocabulary over both SSE and WebSocket:

| Event         | Purpose                                    |
| ------------- | ------------------------------------------ |
| `started`     | Agent has begun processing                 |
| `thinking`    | Agent is reasoning (no output yet)         |
| `token`       | A chunk of output text                     |
| `tool_call`   | Agent is calling a tool                    |
| `tool_result` | Tool returned a result                     |
| `artifact`    | Agent produced a file or structured output |
| `error`       | Something went wrong                       |
| `completed`   | Agent finished processing                  |

Adapters without native streaming (e.g. `echo`) emit a `thinking` followed by a single `token` and a `completed`.

### 13. Observability

The service uses the shared in-repo `observability_client_runtime` SDK (the same package config-service, kb-retrieval-service, and the workers use), wiring structlog JSON logging with OTel `trace_id`/`span_id` injection, an ASGI trace middleware, and OTLP trace/metric/log export. It is installed into the image from `src/common-py/observability/observability-client` (see `deploy/Dockerfile`). Configuration is via the platform-standard `AGENT_STUDIO_OBSERVABILITY_*` / `OTEL_*` env-var family.

> When the SDK is absent (e.g. a bare `pip install -e .` local run), `agent_service_maf.interface_layer.api` degrades to a structlog-only fallback — JSON logs to stdout with the `SecretRedactor` and contextvar merging still active — so the service runs normally and secrets are never emitted unredacted.

## Tech Stack

| Component        | Technology                                | Purpose                                                       |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Language         | Python 3.12 (runtime), 3.11+ (source)     | Service runtime                                               |
| Web framework    | FastAPI + sse-starlette + websockets      | REST, SSE, WebSocket                                          |
| Adapter (primary)| Microsoft Agent Framework (`agent-framework-core` + `-orchestrations`) + protobuf 4.x–5.x | Nine orchestration patterns                    |
| LLM gateway      | Bifrost (external)                        | Model routing, cost, rate limit                               |
| Config source    | Internal config-service (HTTP) + Keycloak | Production source of truth, file mode for tests              |
| Async task store | Redis (in-memory backend for tests)       | TaskStore for `/invoke/async` + session store + memory buffer |
| MCP runtime      | Official `mcp` Python SDK                 | stdio / sse / streamable-http transports                      |
| Validation       | Pydantic v2 + pydantic-settings           | Models, config, env binding                                   |
| Guardrails       | In-tree catalog + optional `detect-secrets` | Input / output / tool stage                                 |
| Logging          | `structlog` + shared `observability_client_runtime` | Structured JSON + OTel traces/metrics/logs (OTLP)   |
| Testing          | pytest + pytest-asyncio + pytest-mock     | unit, integration, e2e markers                                |
| Lint / type      | Ruff + mypy (strict)                      | Code quality                                                  |
| Container        | Multi-stage Dockerfile (`deploy/Dockerfile`) | Production image, non-root UID 1000                       |
| Orchestration    | Helm chart at `deployments/helm/nemo/charts/agent-service-maf/` | Kubernetes deployment (shared `nemo` chart) |

## Project Structure

The service lives at `src/nemo/agent-service-maf/` inside the [agent-studio](../../../README.md) monorepo and is consumed by Nx as the `agent-service-maf` project:

```
src/nemo/agent-service-maf/
├── src/agent_service_maf/             # Importable as `agent_service_maf`
│   ├── core/                        # Interfaces, context, exceptions, session, task,
│   │                                # team registry (lazy), team loader, redis factory,
│   │                                # team bundle, identity, readiness, memory buffer
│   ├── config/                      # Settings, defaults, file_loader, remote_loader,
│   │                                # remote_adapter, service_auth, validators,
│   │                                # model_catalog, _override_applier
│   ├── interface_layer/             # FastAPI app, routes, auth, error formatter, SSE / WS
│   │   └── protocols/               # Scaffold for parallel REST / chat / A2A / MCP-server
│   │                                # routers (`mcp_server.py` is runnable standalone)
│   ├── framework/                   # BaseAgent, registry, executor, response_builder,
│   │   │                            # _outcome_schema, echo_adapter
│   │   └── maf/                     # Microsoft Agent Framework adapter, agent_builder,
│   │                                # orchestration_builder, gateway_chat_client,
│   │                                # tools, event_mapper, observability
│   ├── gateway/                     # BifrostClient, cost_tracker, tool_strategy,
│   │                                # secret_redactor, llm_gateway
│   ├── guardrails/                  # base + pipeline + registry + catalog/*
│   ├── mcp/                         # config_loader, mcp_manager, mcp_registry,
│   │                                # tool_registry, transport_factory, identity transport
│   ├── tools/                       # binding, function_provider, functions/ (kb_retrieve)
│   └── examples/                    # Reference adapter (`echo_agent.py`)
├── configs/
│   ├── agent_config.reference.json  # Full reference config (JSON form)
│   ├── agent_config.reference.yaml  # Same, with inline docs on every field
│   └── team/                        # Sample team configs used by tests + dev-harness
├── tests/                           # unit/, integration/, e2e/, fixtures/, conftest.py
├── docker/                          # docker-compose.e2e.yml + mock-services/{llm,mcp}
├── deploy/                          # Dockerfile (production image; build context = repo root)
├── scripts/                         # OpenAPI gen, dev demo scripts, smoke-test shell scripts
└── docs/                            # design notes (async-invoke) + config-service migration
```

The package is installed/imported as `agent_service_maf`:

```python
from agent_service_maf.interface_layer.api import create_app
```

**Kubernetes deployment** is governed by the **Helm chart at `deployments/helm/nemo/charts/agent-service-maf/`** (part of the shared `nemo` umbrella chart). It is currently `enabled: false` by default — flip per environment with `--set agent-service-maf.enabled=true` once you are ready to cut over from the legacy `agent-service` chart.

## Quick Start

### Run standalone (fast inner loop, file-mode config)

```bash
cd src/nemo/agent-service-maf
pip install -e ".[dev,agent-framework]"   # one-time setup (Python 3.12 strongly recommended)
export CONFIG_SOURCE=file
export AGENT_TEAMS_DIR=$PWD/configs/team
export AGENT_GATEWAY__URL=http://your-bifrost-host/v1
export AGENT_GATEWAY__API_KEY=...          # only if Bifrost requires it
make dev                                    # uvicorn on :8000 with --reload

# Invoke (the project_id comes from configs/team/<team>.json)
curl -X POST http://localhost:8000/api/v1/projects/<project-id>/agent-teams/<team-id>/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello!"}'
```

### Run the production image locally

```bash
# From the repo root (Dockerfile expects the AgentStudio root as build context)
docker build -f src/nemo/agent-service-maf/deploy/Dockerfile \
             -t agent-service-maf:local .
docker run --rm -p 8000:8000 \
  -e CONFIG_SOURCE=file \
  -e AGENT_TEAMS_DIR=/app/configs/team \
  -e AGENT_GATEWAY__URL=http://host.docker.internal:4000/v1 \
  agent-service-maf:local
```

### Deploy to Kubernetes via the shared `nemo` chart

```bash
# From the agent-studio repo root
helm upgrade --install nemo deployments/helm/nemo \
  --set agent-service-maf.enabled=true \
  --set agent-service.enabled=false        # if cutting over from the legacy chart
```

The chart wires `CONFIG_SOURCE=remote`, derives `CONFIG_SERVICE_URL` and `KEYCLOAK_INTERNAL_ISSUER` from the shared `nemo.*` helpers, and pulls `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` from the `keycloak-oidc-secrets` secret. See `deployments/helm/nemo/charts/agent-service-maf/values.yaml` for the full env surface.

See [README-DEVELOPMENT.md](./README-DEVELOPMENT.md) for the full env-var reference, Make targets, deployment notes, and the Option-B output-schema deep-dive.

## Configuration Example

Override the model and orchestration for a single request:

```json
POST /api/v1/projects/<project-id>/agent-teams/<team-id>/invoke
{
  "input": "Analyze this data",
  "config_overrides": {
    "agent": {
      "model": "openai/gpt-4o",
      "temperature": 0.3
    },
    "semantic_kernel": {
      "orchestration": { "type": "concurrent" }
    }
  }
}
```

The override applier merges this with the team's record (config-service or local file), validates the result with Pydantic, and re-routes — all in one request, with no team-config edit needed.

## Output-Schema Validation (Option B)

Agents can declare a JSON Schema that their text output is validated against on every invocation. When the LLM's output matches, `InvokeResponse.parsedOutput` carries the type-coerced, validated dict; on a mismatch it stays `null` and the raw `output` text is preserved.

Two independent agent-config knobs (see `SKAgentDefinition`):

| Field             | Type                              | Purpose                                                                                       |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `response_format` | `"text" \| "json_object" \| null` | Provider-side hint pushed via `prompt_execution_settings`. No server-side validation.         |
| `output_schema`   | JSON Schema dict / `null`         | Server-side validator. When set, MAF parses + validates every invocation and populates `parsedOutput`. |

Per-request `context.outputSchema` overrides `agent.output_schema`. Full spec, decision tree, and supported subset documented in [README-DEVELOPMENT.md](./README-DEVELOPMENT.md#per-request-and-agent-level-output-schemas-option-b).
