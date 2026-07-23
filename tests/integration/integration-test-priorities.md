# Integration Test Prioritization (P0-P3)

A priority ranking for every integration suite, so we know **what must never break**, **what to run first** when time or environments are limited, and **what should gate a release**. It covers the suites in the current code plus the data-management suites introduced by [PR #319](https://github.com/NetApp-Nemo/AgentStudio/pull/319).

Companion to [integration-test-coverage.md](integration-test-coverage.md), which describes *what* each suite validates. This document adds *how important* each one is.

## How priorities are assigned (the logic)

Each suite is ranked on four factors:

- **Business criticality** — does it prove one of the four core adoption journeys (P0 journeys below)?
- **Blast radius** — is it a foundation many journeys depend on (a project, an agent, a model), or a leaf feature?
- **Commonality** — is it the primary happy path, or a secondary variation / edge case?
- **Safety & data integrity** — does a regression risk security, data loss, or wrong answers?

| Priority | Meaning | Suggested release policy |
|----------|---------|--------------------------|
| **P0** | Critical golden paths: the four core journeys and the foundations they all depend on. | Must be green to release. A P0 failure blocks. |
| **P1** | High: primary variations and quality/safety gates of the P0 journeys, and the main enterprise connectors. | Should be green; failures block unless explicitly waived. |
| **P2** | Medium: secondary configurations, negative/validation matrices, env-gated cloud connectors, detail surfaces. | Run in full/nightly; failures triaged, not necessarily blocking. |
| **P3** | Low: niche connectors and deep edge/limit cases. | Best-effort; often skip without special env. |

> The release policy is a recommendation. There are no `p0`-`p3` pytest markers today; see [Running by priority](#running-by-priority).

## The four P0 journeys

| # | Journey | Outcome we protect |
|---|---------|--------------------|
| **J1** | **Rapid proof of value with minimal setup** — upload local files (up to 100 files / 1 GB) → dataset → knowledge base (with optional PII redaction) → register a model → simple chat agent bound to the KB → test in playground and inspect request/response. | Validate data-grounded agent answers end to end with minimal setup and no external data-source integration. |
| **J2** | **Build and deploy a RAG agent on enterprise storage** — connect an enterprise source (ONTAP, ANF, GCNV, NFS volume, PostgreSQL, MySQL, SharePoint) → validate access → datasets → on-demand/scheduled acquisition → knowledge bases → author an agent (KBs + model + guardrails) → validate in playground → deploy as an API endpoint. | Enterprise data connected, refreshed, converted to KBs, validated through the agent, and deployed as an API. |
| **J3** | **Build an agent using real-time signals (MCP tools)** — register MCP toolsets exposing telemetry (ONTAP, GCNV, ANF, FSxN metrics; cloud metric stores; log sources) → register a model → agent with runtime tool invocation + guardrails (optionally KBs) → validate tool usage, intermediate execution, and final responses. | Agent safely invokes the right tools at runtime, exposes execution, and produces trusted operational recommendations. |
| **J4** | **Orchestrate multi-agent workflows (agent teams + A2A)** — build specialized agents → compose into a team with a coordination strategy and manager agent → connect external agents via A2A (Snowflake, Bedrock, Foundry, Vertex) → validate context exchange/delegation/outcome → deploy and expose via APIs. | Agent team collaborates end to end, exchanges context, delegates, and exposes orchestration through APIs. |

## P0 journeys and the tests that prove them

- **J1** — [Manual upload dataset](suites/data_management/test_dataset_manual_unstructured.py) -> [KB happy path](suites/knowledge_base/test_kb_happy_path.py) -> [Provider model registration](suites/models/test_provider_model_registration.py) -> [Agent instantiation & invoke](suites/agent_service/instantiation/test_instantiation_agent.py) -> [Single-KB RAG agent](suites/agent_service/kb_retrieval/test_retrieval_single_kb_agent.py) -> [Standard invoke / inspect](suites/agent_service/interface/test_interface_rest.py). Guardrail redaction: [input guardrails](suites/agent_service/guardrails/test_input_guardrails.py).
- **J2** — [Credential lifecycle](suites/data_management/test_credential_lifecycle.py) -> datasource connectors ([PostgreSQL](suites/data_management/test_datasource_postgresql.py), [MySQL](suites/data_management/test_datasource_mysql.py), [S3](suites/data_management/test_datasource_s3.py), [ONTAP](suites/data_management/test_datasource_ontap.py), [NFS volume](suites/data_management/test_datasource_volume.py)) -> dataset acquisition ([structured](suites/data_management/test_dataset_acquired_structured.py), [unstructured](suites/data_management/test_dataset_acquired_unstructured.py)) -> KB pipelines ([S3](suites/knowledge_base/test_s3compatible_pipeline.py), [PostgreSQL](suites/knowledge_base/test_postgres_pipeline.py), [MySQL](suites/knowledge_base/test_mysql_pipeline.py)) -> KB-bound agent.
- **J3** — MCP tool provisioning ([platform](suites/tools/platform/test_artifact_store_mcp.py), [catalog GCNV](suites/tools/catalog/test_gcnv_mcp.py), [remote](suites/tools/remote/test_remote_mcp_no_auth.py)) -> agent tool invocation ([catalog](suites/agent_service/mcp/test_mcp_single_catalog.py), [remote](suites/agent_service/mcp/test_mcp_single_remote.py)). Telemetry sources: [ONTAP](suites/knowledge_base/test_ontap_metrics_pipeline.py) / [GCP](suites/knowledge_base/test_gcp_metrics_pipeline.py) / [ANF](suites/knowledge_base/test_anf_metrics_pipeline.py) metrics.
- **J4** — [Team instantiation & invoke](suites/agent_service/instantiation/test_instantiation_team.py) -> orchestration ([sequential](suites/agent_service/orchestration_policy/test_orchestration_sequential.py), [concurrent](suites/agent_service/orchestration_policy/test_orchestration_concurrent.py), [coordinate](suites/agent_service/orchestration_policy/test_orchestration_coordinate.py), [route](suites/agent_service/orchestration_policy/test_orchestration_route.py)) -> [team memory](suites/agent_service/memory/test_memory_team_isolation.py), [team RAG](suites/agent_service/kb_retrieval/test_retrieval_single_kb_team.py).

See [P0 coverage gaps](#p0-coverage-gaps) for journey steps that are not yet tested.

## P0 - Critical (must never break)

| Suite | Area | Supports | Why P0 |
|-------|------|----------|--------|
| [Project lifecycle](suites/projects/test_project_lifecycle.py) | Projects | All | Every journey starts in a project; also the `smoke` gate. If this breaks, nothing else runs. |
| [Provider model registration](suites/models/test_provider_model_registration.py) | Models | J1, J2 | "Register a model with credentials" is a required step in both RAG journeys. |
| [Manual upload dataset](suites/data_management/test_dataset_manual_unstructured.py) | Data management | J1 | The zero-integration "upload files -> dataset" entry point that defines J1. |
| [KB happy path](suites/knowledge_base/test_kb_happy_path.py) | Knowledge bases | J1, J2 | Turning a dataset into a searchable KB is the core of both RAG journeys. |
| [Single-KB RAG agent](suites/agent_service/kb_retrieval/test_retrieval_single_kb_agent.py) | Agents | J1, J2 | Grounded, cited answers from a KB-bound agent is the promised outcome. |
| [Agent instantiation & invoke](suites/agent_service/instantiation/test_instantiation_agent.py) | Agents | All | Build-an-agent-and-get-a-response underpins every journey. |
| [Agent tool invocation (catalog MCP)](suites/agent_service/mcp/test_mcp_single_catalog.py) | Agents / Tools | J3 | Runtime tool invocation with visible execution is the core of J3. |
| [Team instantiation & invoke](suites/agent_service/instantiation/test_instantiation_team.py) | Agents | J4 | Multi-agent team collaboration is the core of J4. |

## P1 - High (primary variations, safety gates, main connectors)

| Suite | Area | Supports | Why P1 |
|-------|------|----------|--------|
| [Roles & permissions](suites/projects/test_project_roles.py) | Projects | J2 | Enterprise access control; security regressions are high-impact. |
| [Built-in embedding models](suites/models/test_platform_hosted_models.py) | Models | J1, J2 | KBs need an embedding model; the built-ins are the default path. |
| [Credential lifecycle](suites/data_management/test_credential_lifecycle.py) | Data management | J2 | Credentials gate every enterprise connector; dependency enforcement prevents data-integrity bugs. |
| [PostgreSQL datasource](suites/data_management/test_datasource_postgresql.py) | Data management | J2 | Primary database connector. |
| [MySQL datasource](suites/data_management/test_datasource_mysql.py) | Data management | J2 | Primary database connector. |
| [S3 datasource](suites/data_management/test_datasource_s3.py) | Data management | J1, J2 | Object store underpins unstructured data and the manual-upload target. |
| [ONTAP datasource](suites/data_management/test_datasource_ontap.py) | Data management | J2, J3 | Flagship NetApp enterprise source. |
| [NFS volume datasource](suites/data_management/test_datasource_volume.py) | Data management | J2 | NAS-over-NFS is explicitly called out in J2. |
| [Structured dataset acquire](suites/data_management/test_dataset_acquired_structured.py) | Data management | J2 | Database -> dataset acquisition path. |
| [Unstructured dataset acquire](suites/data_management/test_dataset_acquired_unstructured.py) | Data management | J1, J2 | Files -> dataset acquisition path. |
| [S3 KB pipeline](suites/knowledge_base/test_s3compatible_pipeline.py) | Knowledge bases | J1, J2 | Full connector -> dataset -> KB -> search pipeline. |
| [PostgreSQL KB pipeline](suites/knowledge_base/test_postgres_pipeline.py) | Knowledge bases | J2 | Full pipeline. |
| [MySQL KB pipeline](suites/knowledge_base/test_mysql_pipeline.py) | Knowledge bases | J2 | Full pipeline. |
| [KB search modes](suites/knowledge_base/test_kb_retrieval_configs.py) | Knowledge bases | J1, J2 | Retrieval quality (vector/fts/hybrid) drives answer quality. |
| [Sessions](suites/agent_service/session/test_session.py) | Agents | J1-J4 | Playground/chat is session-based. |
| [Agent memory isolation](suites/agent_service/memory/test_memory_agent_isolation.py) | Agents | J1, J2 | Conversation memory correctness and isolation. |
| [Team memory isolation](suites/agent_service/memory/test_memory_team_isolation.py) | Agents | J4 | Team context exchange without cross-session leakage. |
| [Orchestration: sequential](suites/agent_service/orchestration_policy/test_orchestration_sequential.py) | Agents | J4 | Team orchestration style. |
| [Orchestration: concurrent](suites/agent_service/orchestration_policy/test_orchestration_concurrent.py) | Agents | J4 | Team orchestration style. |
| [Orchestration: coordinate](suites/agent_service/orchestration_policy/test_orchestration_coordinate.py) | Agents | J4 | Manager/coordinator strategy central to J4. |
| [Orchestration: route](suites/agent_service/orchestration_policy/test_orchestration_route.py) | Agents | J4 | Routing to the right specialist agent. |
| [Guardrails: input](suites/agent_service/guardrails/test_input_guardrails.py) | Agents | J1, J2, J3 | PII/secret redaction and content blocking; safety. |
| [Guardrails: output](suites/agent_service/guardrails/test_output_guardrails.py) | Agents | J2, J3 | Unsafe response handling. |
| [Guardrails: combined](suites/agent_service/guardrails/test_input_output_guardrails.py) | Agents | J2, J3 | Input + output guardrails together. |
| [RAG multi-KB agent](suites/agent_service/kb_retrieval/test_retrieval_multiple_kb_agent.py) | Agents | J2 | Answering across multiple KBs. |
| [RAG single-KB team](suites/agent_service/kb_retrieval/test_retrieval_single_kb_team.py) | Agents | J4 | Team-based RAG. |
| [RAG multi-KB team](suites/agent_service/kb_retrieval/test_retrieval_multiple_kb_team.py) | Agents | J4 | Team-based RAG across KBs. |
| [Interface: standard (REST)](suites/agent_service/interface/test_interface_rest.py) | Agents | All | Standard invoke transport used everywhere. |
| [Interface: streaming (SSE)](suites/agent_service/interface/test_interface_streaming.py) | Agents | J1-J4 | Playground streams responses. |
| [Platform MCP tools](suites/tools/platform/test_artifact_store_mcp.py) | Tools | J3 | Built-in tool availability (artifact store). |
| [Platform MCP tools (analytics)](suites/tools/platform/test_analytics_datasets_mcp.py) | Tools | J3 | Built-in analytics-datasets tool. |
| [Catalog MCP tools (GCNV)](suites/tools/catalog/test_gcnv_mcp.py) | Tools | J3 | GCNV telemetry tools explicitly in J3. |
| [Catalog MCP tools (GCNV logs)](suites/tools/catalog/test_gcnv_logs_mcp.py) | Tools | J3 | Log-source telemetry tools. |
| [Remote MCP tools (no auth)](suites/tools/remote/test_remote_mcp_no_auth.py) | Tools | J3 | Registering external MCP toolsets/APIs. |
| [Remote MCP tools (auth)](suites/tools/remote/test_remote_mcp_with_auth.py) | Tools | J3 | Authenticated external toolsets. |
| [Agent tool invocation (remote MCP)](suites/agent_service/mcp/test_mcp_single_remote.py) | Agents | J3 | Remote tool invocation variant. |

## P2 - Medium (secondary config, validation, env-gated cloud, detail surfaces)

| Suite | Area | Supports | Why P2 |
|-------|------|----------|--------|
| [Members management](suites/projects/test_project_members.py) | Projects | J2 (collaboration) | Team member CRUD; not on the core single-user path. |
| [Model validation matrix](suites/models/test_model_validation_matrix.py) | Models | J1, J2 | Negative/validation guardrails on model config. |
| [GCP datasource](suites/data_management/test_datasource_gcp.py) | Data management | J3 | Cloud connector; skips without env. |
| [Azure cloud datasource](suites/data_management/test_datasource_azure_cloud.py) | Data management | J2, J3 | Cloud connector; skips without env. |
| [Metrics datasets (GCP/ONTAP/Azure)](suites/data_management/test_dataset_metrics.py) | Data management | J3 | Metrics acquisition; env-gated. |
| [Resource delete dependencies](suites/data_management/test_resource_dependencies.py) | Data management | J2 | Cross-entity delete ordering robustness. |
| [KB indexing matrix](suites/knowledge_base/test_kb_matrix.py) | Knowledge bases | J2 | Index-mode/chunk/quantization variations + validation. |
| [KB detail page](suites/knowledge_base/test_kb_detail_page.py) | Knowledge bases | J1, J2 | Detail/edit surface. |
| [ANF metrics pipeline](suites/knowledge_base/test_anf_metrics_pipeline.py) | Knowledge bases | J3 | ANF telemetry; env-gated. |
| [ANF MCP server](suites/knowledge_base/test_anf_mcp_server.py) | Knowledge bases / Tools | J3 | Managed ANF tool server; env-gated. |
| [GCP metrics pipeline](suites/knowledge_base/test_gcp_metrics_pipeline.py) | Knowledge bases | J3 | Env-gated metrics pipeline. |
| [ONTAP metrics pipeline](suites/knowledge_base/test_ontap_metrics_pipeline.py) | Knowledge bases | J3 | Env-gated metrics pipeline. |
| [Overrides: temperature](suites/agent_service/overrides/test_temperature_override.py) | Agents | - | Per-invoke tuning. |
| [Overrides: model](suites/agent_service/overrides/test_model_override.py) | Agents | - | Per-invoke model switch. |
| [Interface: WebSocket](suites/agent_service/interface/test_interface_websocket.py) | Agents | J1-J4 | Additional transport. |
| [Interface: async](suites/agent_service/interface/test_interface_async.py) | Agents | J1-J4 | Background jobs (poll/cancel). |
| [Structured output (JSON)](suites/agent_service/output/test_ouput_agent_json.py) | Agents | - | Schema-validated output. |
| [Structured output (text)](suites/agent_service/output/test_ouput_agent_text.py) | Agents | - | Plain-text output config. |

## P3 - Low (niche connectors, edge/limit cases)

| Suite | Area | Supports | Why P3 |
|-------|------|----------|--------|
| [Redash datasource](suites/data_management/test_datasource_redash.py) | Data management | J2 | Niche connector; env-gated. |
| [KB chunk/vector config matrix](suites/knowledge_base/test_kb_config_matrix.py) | Knowledge bases | J2 | Deep config-persistence variants (vector index not trained/awaited). |
| [Memory: agent message limit](suites/agent_service/memory/test_memory_agent_history_messge_limit.py) | Agents | - | Edge-config cap enforcement. |
| [Memory: agent session cap](suites/agent_service/memory/test_memory_agent_session_limit.py) | Agents | - | Edge-config cap enforcement. |
| [Memory: team message limit](suites/agent_service/memory/test_memory_team_history_messge_limit.py) | Agents | - | Edge-config cap enforcement. |
| [Overrides: max tokens](suites/agent_service/overrides/test_max_tokens_override.py) | Agents | - | Minor tuning. |
| [Overrides: all combined](suites/agent_service/overrides/test_all_overrides.py) | Agents | - | Minor tuning combination. |

## P0 coverage gaps

Steps that the four P0 journeys describe but the integration suite does **not** yet prove. These are the highest-value places to add coverage.

| Journey | Step not covered | Notes |
|---------|------------------|-------|
| J1 | PII redaction at the dataset/KB stage | Only agent-input guardrail redaction is tested; ingestion-stage redaction is untested. |
| J1 | Upload at scale (up to 100 files / 1 GB) | Manual upload is tested with a small file, not at the stated limits. |
| J2 | SharePoint connector | No datasource suite. |
| J2 | Scheduled acquisition + refresh behavior | Only on-demand acquire is tested. |
| J2 / J4 | Deploy and expose an agent/team as an API endpoint | The deploy step of J2/J4 has no integration coverage. |
| J3 | FSxN metrics; 1P metric stores across clouds | ONTAP/GCP/ANF/GCNV covered; FSxN and cloud metric stores are not. |
| J4 | A2A external integrations (Snowflake, Bedrock, Foundry, Vertex) | No A2A suites. |

## Running by priority

There are no `p0`-`p3` pytest markers yet, so select the P0 golden-path set by path:

```bash
cd tests/integration
pytest -v -s \
  suites/projects/test_project_lifecycle.py \
  suites/models/test_provider_model_registration.py \
  suites/data_management/test_dataset_manual_unstructured.py \
  suites/knowledge_base/test_kb_happy_path.py \
  suites/agent_service/instantiation/test_instantiation_agent.py \
  suites/agent_service/instantiation/test_instantiation_team.py \
  suites/agent_service/kb_retrieval/test_retrieval_single_kb_agent.py \
  suites/agent_service/mcp/test_mcp_single_catalog.py
```

(The `suites/data_management/` paths require [PR #319](https://github.com/NetApp-Nemo/AgentStudio/pull/319).) Environment-gated suites skip cleanly when their config is absent — see [integration-test-coverage.md](integration-test-coverage.md) and [README.md](README.md).

> If priority-based selection becomes routine, add `p0`-`p3` markers to [`pytest.ini`](pytest.ini) and tag each suite once, then run `pytest -m p0`. Not built yet — no marker plumbing until there is a recurring need for it.

## Keeping this document current

When you add or change a suite: give it a priority using the logic above, drop it in the matching table, and note which journey (J1-J4) it supports. When a P0 coverage gap gets a test, move it from the gaps table into the P0/P1 tables.
