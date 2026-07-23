# Agent Framework (MAF) — Development Guide

## Where the service lives

This service sits at `src/nemo/agent-service-maf/` inside the [agent-studio](../../../README.md) monorepo. It is exposed to Nx as the `agent-service-maf` project (`project.json`) and gets thin Makefile proxies at the repo root for install / build / test / lint:

```bash
# from the agent-studio repo root
make agent-service-maf-install        # pip install -e .[dev]
make agent-service-maf-docker-build   # build the production image
make agent-service-maf-test-unit
make agent-service-maf-test-int
make agent-service-maf-test-all
make agent-service-maf-lint
make agent-service-maf-typecheck
make agent-service-maf-format
make agent-service-maf-regen-openapi  # refresh the OpenAPI golden fixture
```

For day-to-day work prefer running `make` inside `src/nemo/agent-service-maf/` directly — every target below assumes that as the working directory.

## Development workflows

### A. Standalone inner loop (recommended for code changes)

Only the FastAPI app runs; you provide a Bifrost endpoint and tell MAF where its team configs live.

```bash
cd src/nemo/agent-service-maf
pip install -e ".[dev,agent-framework]"      # one-time; Python 3.12 strongly recommended
export CONFIG_SOURCE=file
export AGENT_TEAMS_DIR=$PWD/configs/team     # local sample teams
export AGENT_GATEWAY__URL=http://your-bifrost-host/v1
# Optional: only set AGENT_GATEWAY__API_KEY when pointing at a non-Bifrost
# gateway. In remote mode (CONFIG_SOURCE=remote), MAF resolves a per-project
# Bifrost virtual key from config-service at bundle-load time and any value
# set here is ignored.
make dev                                      # uvicorn on :8000 with --reload
```

`make dev` runs `PYTHONPATH=src uvicorn agent_service_maf.interface_layer.api:create_app --factory --host 0.0.0.0 --port 8000 --reload`.

Smoke-test scripts that exercise specific patterns are in `scripts/`:

```bash
./scripts/test_single_agent_mcp.sh
./scripts/test_sequential_pipeline.sh
./scripts/test_concurrent.sh
./scripts/test_triage.sh
./scripts/test_magentic.sh
./scripts/test_memory.sh
./scripts/test_guardrails.sh
./scripts/test_citations.sh
./scripts/test_rfc_conflict_evolution.sh
./scripts/test_rfc_search_relevance.sh
```

### B. End-to-end with mock LLM + mock MCP

The `docker/docker-compose.e2e.yml` stack stands up the service alongside `mock-llm` and `mock-mcp` containers (see `docker/mock-services/`). This is what the `e2e` test marker exercises.

```bash
make e2e-up           # build + start the stack
make test-e2e-docker  # runs pytest against the live containers and tears down
make e2e-logs         # peek at container logs
make e2e-down
```

### C. Production-image local build

Build context is the **repo root**, not this folder, because the Dockerfile copies sibling paths:

```bash
make docker-build     # docker build -f deploy/Dockerfile -t agent-service-maf:latest ../../..
```

The image is multi-stage (`docker.repo.eng.netapp.com/python:3.12-slim`), runs as non-root UID 1000, exposes port `8000`, and ships with the `agent-framework` + `guardrails-secrets` extras pre-installed. `HEALTHCHECK` targets `/health` (liveness only — `/ready` belongs in the Kubernetes readinessProbe).

### D. Kubernetes deployment (production path)

The service is shipped via the shared `nemo` umbrella Helm chart. Its sub-chart lives at:

```
deployments/helm/nemo/charts/agent-service-maf/
├── Chart.yaml
├── values.yaml
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    ├── networkpolicy.yaml
    ├── hpa.yaml
    └── servicemonitor.yaml
```

The chart defaults to `enabled: false` to keep the legacy `agent-service` chart in charge until cutover. Flip per environment:

```bash
# from the agent-studio repo root
helm upgrade --install nemo deployments/helm/nemo \
  --set agent-service-maf.enabled=true \
  --set agent-service.enabled=false        # if running side-by-side, leave both true for canary
```

The chart template wires:

- `CONFIG_SERVICE_URL` from the `nemo.configServiceClusterURL` helper — also the source of the per-project Bifrost virtual key (`ProjectVKResolver` calls `GET /api/v1/projects/{pid}/models/{model_id_hint}` and reads `gatewayApiKey` at bundle-load time)
- `KEYCLOAK_INTERNAL_ISSUER` from the `nemo.keycloakInternalIssuer` helper
- `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` from the `keycloak-oidc-secrets` secret (currently reusing the agent-service Keycloak client; see the TODO note in `deployment.yaml` for the dedicated-client migration)
- `AGENT_GATEWAY__URL` from `nemo.llmGatewayUrl` (Bifrost cluster URL)
- **No** `AGENT_GATEWAY__API_KEY` — the chart deliberately does not set it; the VK comes from config-service per project. A bundle whose project has no resolvable VK is marked unhealthy with `MissingProjectVirtualKeyError` rather than silently using a deployment-wide key.
- `REDIS_URL` from `redis-master:6379/0`; sentinel optional via `REDIS_SENTINEL_URL` / `_MASTER` (omitted when `redisStandalone: true`)

> **Heads up — Makefile targets that point at `deploy/helm/`, `deploy/k8s/`, and `deploy/bicep/` are legacy / aspirational.** Those folders do not exist in-tree — `deploy/` contains only the `Dockerfile`. The real Kubernetes path is the umbrella chart above. Treat any `make helm-*`, `make k8s-*`, or `make ca-*` target as documentation of the standalone shape we plan to ship separately, not as something you can run today.

## Environment variables (canonical reference)

Names below are what the running service actually reads (see `agent_service_maf.config.settings`, `agent_service_maf.interface_layer.api`, and the chart's `values.yaml`).

### Config source

| Variable                       | Default     | Notes                                                                                  |
| ------------------------------ | ----------- | -------------------------------------------------------------------------------------- |
| `CONFIG_SOURCE`                | `remote`    | `remote` (config-service over HTTP) or `file` (local JSON dir).                        |
| `CONFIG_SERVICE_URL`           | _(empty)_   | Base URL of the central config-service. When empty, MAF falls through to file mode.    |
| `CONFIG_CACHE_TTL`             | `60`        | In-process TTL (seconds) for cached config-service responses.                          |
| `CONFIG_CACHE_MAX_SIZE`        | `1000`      | LRU cap for the in-process cache.                                                      |
| `CONFIG_HTTP_TIMEOUT`          | `10.0`      | Per-call HTTP timeout for config-service requests (seconds).                           |
| `CONFIG_STALE_WHILE_ERROR`     | `true`      | When `true`, serve the last-known-good cached payload if config-service returns an error. |
| `AGENT_TEAMS_DIR`              | _(empty)_   | File-mode: directory containing one JSON team config per team.                         |
| `AGENT_AGENTS_DIR`             | _(empty)_   | File-mode: optional dir with standalone agent records used by `/agents/{id}` routes.    |
| `AGENT_WARM_TEAMS`             | _(empty)_   | Comma-separated `projectId/teamId` pairs to pre-warm at startup.                       |
| `AGENT_DEFAULT_TEAM`           | _(empty)_   | Team id promoted to project-default. Captured before warm-up so it wins on first add.   |

### Keycloak service account (for `CONFIG_SOURCE=remote`)

| Variable                                  | Notes                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `KEYCLOAK_INTERNAL_ISSUER`                | Issuer URL of the in-cluster Keycloak realm.                                          |
| `KEYCLOAK_CLIENT_ID`                      | Service-account client id (currently reuses the agent-service client).                |
| `KEYCLOAK_CLIENT_SECRET`                  | Service-account client secret — env-only, never JSON.                                 |
| `KEYCLOAK_TOKEN_REFRESH_LEEWAY_SECONDS`   | Default `60`. Safety window before token expiry.                                      |

### Interface / auth

| Variable                              | Maps to                       | Notes                                                                              |
| ------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `AGENT_INTERFACE__HOST`               | uvicorn bind host             | Default `0.0.0.0`.                                                                 |
| `AGENT_INTERFACE__PORT`               | uvicorn bind port             | Default `8000`.                                                                    |
| `AGENT_INTERFACE__AUTH__ENABLED`      | `interface.auth.enabled`      | `true`/`false`.                                                                    |
| `AGENT_INTERFACE__AUTH__SCHEME`       | `interface.auth.scheme`       | `api_key` (default) or `gateway_identity`.                                         |
| `AGENT_INTERFACE__AUTH__API_KEYS`     | `interface.auth.api_keys`     | Comma-separated list of accepted `X-API-Key` values.                               |
| `AGENT_ENVIRONMENT`                   | —                             | `development` enables permissive CORS.                                             |

### LLM gateway (Bifrost)

| Variable                          | Maps to                 | Notes                                                                  |
| --------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `AGENT_GATEWAY__URL`              | `gateway.url`           | Bifrost OpenAI-compatible base URL (typically ends in `/litellm/v1`; for MCP routing MAF derives the bare `<host>/mcp` from this — see "MCP" below). |
| `AGENT_GATEWAY__DEFAULT_MODEL`    | `gateway.default_model` | Fallback when no inner agent specifies a model.                        |
| `AGENT_GATEWAY__MAX_RETRIES`      | `gateway.max_retries`   |                                                                        |

> **`AGENT_GATEWAY__API_KEY` is intentionally absent.** In remote mode the bearer used on every Bifrost completion is the **per-project virtual key (VK)** resolved at bundle-load time by `ProjectVKResolver` (calls `CONFIG_SERVICE_URL/api/v1/projects/{pid}/models/{model_id_hint}` and reads `gatewayApiKey`). The chart's `values.yaml` no longer sets `AGENT_GATEWAY__API_KEY`. File-mode standalone runs against a non-Bifrost gateway may still export it; remote-mode runs would have it overridden per bundle anyway. A project whose VK can't be resolved fails fast with `MissingProjectVirtualKeyError` rather than silently using a fallback key.

### KB retrieval (built-in `kb_retrieve` tool)

| Variable                  | Default                                | Notes                                            |
| ------------------------- | -------------------------------------- | ------------------------------------------------ |
| `KB_ENDPOINT_URL`         | `https://…/retrieval/invoke` (cloud APIM) | Supports `{projectId}` / `{kbId}` placeholders. Set to `http://kb-retrieval-service:5000/api/v1/projects/{projectId}/knowledgebases/{kbId}/search` to talk to the in-cluster Rust service (path-based); leave templating out to talk to Cloud APIM's body-based endpoint. The substitution happens per call. |
| `KB_SERVICE_TOKEN`        | _(empty)_                              | Optional service-account bearer; when set, sent as `Authorization: Bearer …`. When empty, the inbound user JWT is used (legacy-compat). Read per call so rotation is restart-free. |
| `KB_TIMEOUT_SECONDS`      | `30`                                   |                                                  |
| `KB_MAX_RESPONSE_BYTES`   | `1048576` (1 MiB)                      | Defensive cap on response size.                  |

> **Dual-key threshold body.** No env knob, but worth knowing: when a `kb_retrieve` binding's pinned params include `similarityThreshold`, the outbound JSON body emits **both** `similarityThreshold` (Cloud APIM legacy key) and `minScore` (in-cluster Rust `kb-retrieval-service` key). Both upstreams ignore unknown keys, so one MAF build works against either deployment without a config switch.

> **Per-agent ragConfig.** Each agent's `ragConfig[kbId]` (`topK`, `similarityThreshold`, `similarityThresholdEnabled`, `searchMode`) is baked into the synthesised `kb_retrieve` FunctionBinding's pinned params at bundle build. Agents in the same team that diverge on these settings for the same KB get suffixed variant bindings (`<name>__r2`, `__r3`, …) so each agent dispatches against its own configuration without leaking another's settings to the LLM. See `_rag_signature_for` in `core/team_loader.py`.

### Redis (sessions, memory, async tasks)

| Variable                  | Default                | Notes                                                                  |
| ------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `REDIS_URL`               | `redis://redis-master:6379/0` | Single-instance / sentinel-aware client URL.                     |
| `REDIS_SENTINEL_URL`      | _(empty)_              | When set, enables sentinel mode (omitted when chart `redisStandalone: true`). |
| `REDIS_SENTINEL_MASTER`   | _(empty)_              | Sentinel master name.                                                  |

### MCP

| Variable                          | Default | Notes                                                                              |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `AGENT_MCP__STRICT_SCHEMAS`       | `true`  | Reject MCP servers whose tool schemas fail validation at connect time.             |
| `AGENT_MCP__LAZY_CONNECT`         | `true`  | When `true`, MCP connections (and therefore tool discovery) are deferred until the first tool call; when `false`, discovery runs at bundle build so the LLM sees the tool surface on the very first invoke. Disable for short-lived smoke tests where the first call would otherwise return an empty tool list. |

**Two MCP transport models, selected per-server by config-service record shape:**

- **Direct-session** (file-source fixtures, no Bifrost in path) — each `mcp_servers[]` entry carries its own `url`; MAF opens one session per server, attribution via `ClientSessionGroup._tool_to_session`.
- **Bifrost-multiplexed** (config-service records with `gatewayServerName`) — Bifrost serves a **single aggregated `/mcp` endpoint** at the gateway root that proxies every registered MCP client. `mcp_server_record_to_inline_config` writes the bare `<host>/mcp` URL plus a separate `gateway_server_name` field; `derive_mcp_base_url` strips the full `/litellm/v1` OpenAI-compat subpath so MCP lands at the root (NOT at `/litellm/mcp`, which Bifrost 405s on). `MCPDiscovery.discover_server` filters the aggregated `tools/list` to entries whose name starts with `<gateway_server_name>-` and strips that prefix when registering — so per-agent tool isolation is preserved (agents only see their own server's tools) and the LLM sees clean tool names. `MCPToolInvoker.call_tool` re-prefixes on dispatch so Bifrost still routes to the correct upstream client.

### Observability (shared `observability_client_runtime` SDK)

Logging / tracing / metrics are delegated to the shared `observability_client_runtime` — the same package config-service, kb-retrieval-service, and the Temporal workers use. It is installed into the image by `deploy/Dockerfile` from `src/common-py/observability/observability-client`, and configured at startup in `interface_layer/api.py`. Env contract is platform-standard (identical to the workers):

| Variable                                             | Default                | Notes                                                                 |
| ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `LOG_LEVEL`                                          | `INFO`                 | `DEBUG`/`INFO`/`WARNING`/`ERROR`.                                      |
| `AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH`           | `/dev/stdout`          | App-log sink (stdout in k8s).                                         |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`                 | _(empty)_              | OTLP HTTP base URL for trace export.                                  |
| `AGENT_STUDIO_OBSERVABILITY_METRICS_OTLP_ENDPOINT`   | _(empty)_              | OTLP HTTP base URL for metrics export (falls back to `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`). |
| `AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT`      | _(empty)_              | OTLP HTTP base URL for log export.                                    |
| `OTEL_SERVICE_NAME`                                  | `agent-service-maf`    | `service.name` on traces + metrics.                                   |
| `AGENT_STUDIO_OBSERVABILITY_TRACE_FILE_PATH`         | `Trace_Logs/trace.jsonl` | Local span JSONL sink (in addition to OTLP).                        |
| `AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT` | _(unset)_              | Optional `/metrics` scrape port.                                     |

Any other `ObservabilityLoggingConfig` field can be set via `AGENT_STUDIO_OBSERVABILITY_<FIELD>`.

> When the SDK is absent (a bare `pip install -e .` for a quick local run), `interface_layer/api.py` degrades to a structlog-only fallback: JSON logs to stdout with `SecretRedactor` and contextvar merging still active (no OTel traces/metrics). Secrets are never emitted unredacted on either path.

### Runtime

| Variable      | Notes                                                       |
| ------------- | ----------------------------------------------------------- |
| `PYTHONPATH`  | `/app/src` in the image, `src` for `make dev`.              |

MCP server records and KB / agent / team records all come from the **config-service** (remote mode) or from JSON files under `AGENT_TEAMS_DIR` / `AGENT_AGENTS_DIR` (file mode) — there is no separate `MCP_CONFIG_PATH` env var.

## Project layout (quick recap)

```
src/agent_service_maf/
├── core/                 # Interfaces, context, exceptions, identity, sessions,
│                         # task manager + store, lazy team registry, team loader/bundle,
│                         # memory buffer, readiness, redis factory
├── config/               # 3-source settings (defaults / env / source / per-request),
│                         # file_loader, remote_loader (+ adapter, service_auth)
├── interface_layer/      # FastAPI app (api.py), routes.py, auth, error formatter,
│   └── protocols/        # parallel REST / chat / A2A / MCP-server scaffolding;
│                         # `mcp_server.py` is runnable standalone
├── framework/            # BaseAgent + registry + executor + response_builder,
│   │                     # _outcome_schema, echo_adapter
│   └── maf/              # Microsoft Agent Framework adapter, agent_builder,
│                         # orchestration_builder, gateway_chat_client,
│                         # tools, event_mapper, observability
├── gateway/              # BifrostClient, llm_gateway, cost_tracker, tool_strategy, secret_redactor
├── guardrails/           # base + pipeline + registry + catalog/* (input/output/tools)
├── mcp/                  # config_loader, mcp_manager, mcp_registry, tool_registry,
│                         # transport_factory, _identity_transport
├── tools/                # binding, function_provider, functions/ (kb_retrieve)
└── examples/             # echo_agent.py (reference adapter)
```

Other top-level folders:

- `configs/` — `agent_config.reference.{json,yaml}` (the schema reference) and `team/*.json` (sample team configs used by tests + dev-harness).
- `tests/` — `unit/`, `integration/`, `e2e/` (markers in `pyproject.toml`), plus `fixtures/openapi.expected.json` for the §G5 drift check.
- `docker/` — `docker-compose.e2e.yml` + `mock-services/` (mock LLM + mock MCP). Used by `make test-e2e-docker`.
- `deploy/` — production `Dockerfile` (build context = repo root). **No** sibling `docker-compose.yaml` / `helm/` / `k8s/` / `bicep/` despite legacy Makefile targets.
- `docs/` — `design/async-invoke.md` and the config-service migration notes (analysis, plan, adapter capabilities).
- `scripts/` — `generate_openapi.py`, `demo_triage_logging.py`, `cleanup_legacy_session_keys.py`, and a set of pattern smoke-test shell scripts.

## Running tests

```bash
make test-unit        # tests/unit/, fast and isolated
make test-int         # tests/integration/, component interactions
make test-e2e         # tests/e2e/ without the Docker stack (pure-Python e2e)
make test-e2e-docker  # tests/e2e/ against docker/docker-compose.e2e.yml
make test-all         # everything + coverage (term-missing + htmlcov/)
```

Marker semantics (`pyproject.toml`):

```
[tool.pytest.ini_options]
asyncio_mode = "auto"
markers = [
    "unit", "integration", "e2e",
]
```

### OpenAPI drift check

The full OpenAPI document is checked into `tests/fixtures/openapi.expected.json` and `tests/integration/test_openapi_drift.py` diffs it against the live app. After any intentional route / schema change, regenerate the fixture and commit it alongside the code change:

```bash
make regen-openapi
git add tests/fixtures/openapi.expected.json
```

## Code quality

```bash
make lint        # ruff check + ruff format --check
make typecheck   # mypy --strict on src/agent_service_maf
make format      # ruff format + ruff check --fix
```

Ruff lint config selects `E,F,I,N,W,UP,ANN,B,SIM`. mypy runs strict against the `agent_service_maf` package; the `tool.mypy.overrides` block lets opaque third-party imports skip stub checks (`agent_framework.*`, `mcp.*`, `redis.*`, etc.). `interface_layer/protocols/*` and a handful of scaffold files are exempt from lint while they evolve.

## Adding a new framework adapter

The whole point of the framework registry is single-file additions. To register an adapter named `my_framework`:

1. Create `src/agent_service_maf/framework/my_framework_adapter.py`.
2. Subclass `BaseAgent` and apply `@FrameworkRegistry.register("my_framework")`.
3. Implement `invoke()`, `stream()`, `get_capabilities()`, and (optionally) `initialize()` / `shutdown()`.
4. Add the import to `agent_service_maf/framework/__init__.py` so the decorator fires at import time.
5. Cover the adapter in `tests/unit/` (use `echo_adapter.py` and the SK adapter as references).

That's it — no router, config, or wiring changes needed; any team whose record sets `agent.framework: "my_framework"` will immediately resolve to your adapter.

## Per-request and agent-level output schemas (Option B)

The Option-B output-schema path validates an agent's text output against a JSON Schema and populates `InvokeResponse.parsedOutput` with the type-coerced, validated dict. It is provider-agnostic, runs server-side, and never blocks the request — a validation miss returns `parsedOutput=null` and a structured `parsed_output_validation_failed` WARNING log; the raw `output` text is always preserved.

### Wire contract reminder

* **Request**: `context.outputSchema` (camelCase) on the `InvokeRequest` body. Plain JSON Schema dict.
* **Response**: `parsedOutput` (camelCase) on `InvokeResponse`. `null` when no parsing path runs or validation fails; a plain `dict` otherwise (NOT a Pydantic instance).

### Two independent agent-level knobs

Both live on `SKAgentDefinition` and may be set independently:

```jsonc
{
  "name": "invoice_agent",
  "instructions": "Return a JSON object with fields customerId (string) and amount (number).",
  // PROVIDER-side hint: makes the LLM emit JSON. No validation.
  "response_format": "json_object",
  // SERVER-side validator: a JSON Schema. parsedOutput is populated on match.
  "output_schema": {
    "type": "object",
    "properties": {
      "customerId": {"type": "string"},
      "amount":     {"type": "number"}
    },
    "required": ["customerId", "amount"]
  }
}
```

### Four configuration combinations

| Knobs set                          | LLM constraint              | Server validation | `parsedOutput`                                 |
| ---------------------------------- | --------------------------- | ----------------- | ---------------------------------------------- |
| neither                            | none                        | none              | `null`                                         |
| `response_format` only             | provider JSON mode          | none              | raw parsed dict                                |
| `output_schema` only               | none                        | full schema       | validated dict or `null`                       |
| both                               | provider JSON mode + schema | full schema       | validated dict or `null` (strongest guarantee) |

Schema-path wins over `response_format` when both are set — validation is the stronger signal.

### Precedence rules

`context.outputSchema` (per-request) > `agent.output_schema` (agent default) > unset.

The per-request override lets callers pin a tighter schema for one request without re-deploying the agent config. The agent default lets you write the schema once and let every invocation use it.

### Supported JSON Schema subset

The legacy AgentStudio subset, ported essentially verbatim:

* Primitive types: `string`, `integer`, `number`, `boolean`, `array`, `object`, `null`
* `properties` on objects (recursive)
* `required` array (otherwise fields default to `Optional[T] = None`)
* `items` on arrays (recursive → `list[T]`)
* `$ref` resolution against sibling `definitions` / `$defs`
* `title` on nested objects (used as the synthesised model class name)

Out of scope (gracefully degrade to `dict` / `str`): `oneOf`, `anyOf`, `enum`, `pattern`, `minimum`, `maximum`, `format`, `additionalProperties`. Schemas using these still load — the constructs are simply ignored. JSON Schema's default "object accepts extra properties" semantics are preserved (`extra="allow"`).

### Failure modes (all silent, all logged)

| Log line | When it fires | Effect |
| --- | --- | --- |
| `outcome_model_build_failed` | `build_outcome_model(schema)` raised (malformed schema). | Schema cached as a known-failure; `parsedOutput` falls back to the raw parsed dict (legacy compat). |
| `parsed_output_validation_failed` | Schema built fine, Pydantic rejected the LLM's output. | `parsedOutput = null`; raw `output` text preserved. |
| `expect_json_but_not_parseable` | `response_format=json_object` but the LLM emitted unparseable text. | `parsedOutput = null`; raw `output` text preserved. |
| `agent_output_schema_invalid` | Team-load-time pre-flight rejected the agent's `output_schema`. | Bundle stays healthy; `bundle.startup_error` set and visible via `GET /agent-teams`. |

Ops can dashboard `parsed_output_validation_failed` to track schema drift between the prompt and the LLM's actual output.

### Relationship to the `SchemaValidator` guardrail

The two are complementary:

| Concern | `SchemaValidator` guardrail | Option B (this path) |
| --- | --- | --- |
| Where it runs | Guardrails pipeline (output stage) | `ResponseBuilder.finalize()` / `_invoke_single` post-processing |
| What it checks | `expected_format` + `required_fields[]` presence | Full JSON Schema → Pydantic validation |
| Failure mode | WARN or BLOCK (configurable) | Silent fail, structured WARNING log |
| What it populates | Nothing on the response shape | `InvokeResponse.parsedOutput` |
| Use when | "Block obviously wrong output before it reaches the client" | "Give the client a typed, schema-validated dict" |

Both can be configured on the same agent. They do not duplicate work — `SchemaValidator` does string `json.loads`, Option B does Pydantic validation with type coercion.

### Local testing

* **Unit tests**: `tests/unit/test_outcome_schema.py`, plus the expanded `tests/unit/test_response_builder.py::TestOptionBDecisionTree`.
* **Integration tests**: `tests/integration/test_outcome_validation.py` covers adapter-side schema resolution + the team-loader pre-flight.

## How this codebase was originally built (historical context)

The initial 8-phase build (Interface & Protocol → Config → LLM Gateway → Guardrails → Framework Adapters → MCP → E2E → Deployment, ~112 tasks) was orchestrated by a Claude Code "agent team": one **team-leader-agent** (model: opus) plus 16 phase-specific code/test agent pairs and 5 cross-cutting quality agents (SBOM, coverage, integration, SAST, linguistic). Agent definitions, plan documents, and execution-tracker live (where preserved) under `.claude/agents/` and `plans/`.

That orchestration pattern delivered the foundational implementation. The codebase has since matured into the standard agent-studio service workflow: changes flow through normal PRs, the cross-cutting checks are part of the agent-studio CI pipeline, and the per-phase code/test agents are no longer invoked for routine work. The agent definitions remain as living documentation of how the original waves were sequenced and of the engineering standards each phase agreed on — see `plans/engineering-standards.md` and `plans/requirements-coverage-audit.md` if you need to revisit that context.

## Pointers

| Topic                              | Where to look                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| App startup & lifespan             | `src/agent_service_maf/interface_layer/api.py`                                                           |
| All HTTP / SSE / WS routes         | `src/agent_service_maf/interface_layer/routes.py`                                                        |
| Async-invoke design                | `docs/design/async-invoke.md`                                                                          |
| Config-service migration notes     | `docs/config-service-migration-analysis.md`, `docs/config-service-migration-plan.md`                   |
| Helm chart                         | `deployments/helm/nemo/charts/agent-service-maf/`                                                      |
| OpenAPI golden fixture             | `tests/fixtures/openapi.expected.json` (regenerate with `make regen-openapi`)                          |
| Reference team configs             | `configs/team/*.json`                                                                                  |
| Full configuration reference       | `configs/agent_config.reference.yaml` (every field annotated)                                          |
| Sample adapter to copy             | `src/agent_service_maf/examples/echo_agent.py`                                                           |
| Per-project Bifrost VK resolver    | `src/agent_service_maf/gateway/project_vk_resolver.py`                                                   |
| Team / single-agent bundle build   | `src/agent_service_maf/core/team_loader.py` (both paths; see `_rag_signature_for` for ragConfig grouping) |
| Lazy registry + resolver plumbing  | `src/agent_service_maf/core/team_registry_lazy.py`                                                       |
| MCP prefix-routing for Bifrost     | `src/agent_service_maf/mcp/mcp_manager.py` (`MCPDiscovery.discover_server`, `MCPToolInvoker.call_tool`), `src/agent_service_maf/mcp/config_loader.py` (`gateway_server_name` field), `src/agent_service_maf/config/remote_adapter.py` (`derive_mcp_base_url`, `mcp_server_record_to_inline_config`) |
| `kb_retrieve` URL templating + body | `src/agent_service_maf/tools/functions/kb_retrieve.py`                                                  |
| Loud-failure points (no fallbacks) | `agent_record_to_sk_agent` in `remote_adapter.py` (missing `gatewayModelId` → `ValueError`); `ProjectVKResolver` (missing VK → `MissingProjectVirtualKeyError`) |
