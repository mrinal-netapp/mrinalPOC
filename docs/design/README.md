# Design docs

Design docs describe platform and feature architecture, data flows, and key decisions. Implementation details live in code; these docs give a concise "how it works" and "why."

## How to use these docs

Start with **[Platform HLD](platform-hld.md)** to understand building blocks, entities, and major flows. Then open the feature doc for the area you care about (knowledge bases, connectors, datasets, etc.). Use these docs for "how it works" and "why"; keep implementation details in code and link from the doc where helpful.

## How these docs fit in

- **Design docs (this folder)** — Architecture and "how it works" / "why"; audience = engineers implementing or changing behavior. Start with [platform-hld.md](platform-hld.md), then the feature doc for your area.
- **[docs/HLD.md](../HLD.md)** — Long-form subsystem and deployment detail; reference when you need deeper operational or component-level context.
- **Code and OpenAPI** — Source of truth for APIs, types, and implementation; design docs link to key modules and endpoints.

## Start here

**[Platform HLD](platform-hld.md)** — Building blocks, core entities, interactions, and major user flows. Read this first, then the feature doc for the area you care about.

## Feature docs

| Feature | Doc | Scope | Status |
| ------- | --- | ----- | ------ |
| Platform | [platform-hld.md](platform-hld.md) | Building blocks, entities, interactions, major flows | Done |
| Keycloak per-project authz | [keycloak-per-project-authorization.md](keycloak-per-project-authorization.md) | Keycloak identity model (§3.1) + per-project authorization (§8); scope of PR #31 | Done |
| Knowledge bases | [knowledge-base.md](knowledge-base.md) | Creation, retrieval, alternate backend, file convention, incremental | Done |
| Unified embedding models | [unified-embedding-models.md](unified-embedding-models.md) | All embeddings routed through Bifrost (local MiniLM via TEI, remote providers); per-credential keys; unified `metadata.json` schema; embedding-dimensions catalog | Done |
| Bifrost LLM gateway | [bifrost-migration.md](bifrost-migration.md) | Sole gateway architecture: per-project teams + VKs, per-credential provider keys, MCP routing | Done |
| Vector DB comparison | [vector-db-comparison.md](vector-db-comparison.md) | LanceDB vs PostgreSQL+pgvector: features, benchmark, results | Done |
| Connectors | [connectors.md](connectors.md) | Connector types, acquisition modes, scheduling, credentials | Done |
| Connector explorer | [connector-explorer.md](connector-explorer.md) | Unified ExplorerAction, provider catalog, GUI tree | Implemented |
| ONTAP connector + MCP | [ontap-connector.md](ontap-connector.md) | NetApp ONTAP discovery connector and managed MCP server | Done |
| Metrics acquisition | [metrics-acquisition.md](metrics-acquisition.md) | ONTAP/GCNV metrics connector, adapters, Parquet schemas | Partial |
| Streaming pipeline | [stream-pipeline.md](stream-pipeline.md) | Zero-copy streaming acquisition with Redis streams | Done |
| Volume discovery | [volume-discovery.md](volume-discovery.md) | Standalone architecture: scalable volume crawl, Parquet artifacts, refresh/CDC foundations | Done |
| Datasets | [datasets.md](datasets.md) | Dataset kinds, lifecycle, catalog, storage, data acquisition | Done |
| Pipelines | [pipelines.md](pipelines.md) | Pipeline DAG, execution, agent blocks, HIL, scheduling | Done |
| Agents | [agents.md](agents.md) | Agent service, RAG, tools, Bifrost gateway integration | Done |
| Agent hardening | [agent-service-hardening.md](agent-service-hardening.md) | Structured output, guardrails, tool filtering | Partial |
| Agent code sandbox | [agent-code-sandbox-build-vs-buy.md](agent-code-sandbox-build-vs-buy.md) | Build-vs-buy for untrusted code execution | Proposed |
| Workspaces | [workspaces.md](workspaces.md) | Workspace manager, templates, lifecycle, routing | Done |
| Workflows | [workflows.md](workflows.md) | Execution model, task queues, durability, progress, scaling | Done |
| Temporal migration | [temporal-python-workers.md](temporal-python-workers.md) | Historical: K8s Jobs to Temporal activity migration | Done |
| Web crawl strategy | [adr-web-crawl-strategy-mcp-first.md](adr-web-crawl-strategy-mcp-first.md) | ADR: MCP-first web crawl approach | Accepted |
| Web search gates | [web-search-provider-acceptance-gates.md](web-search-provider-acceptance-gates.md) | QA checklist for Tavily/SearxNG MCP providers | Checklist |
| A2A deferral | [adr-agent-team-a2a-exposure-deferral.md](adr-agent-team-a2a-exposure-deferral.md) | ADR: defer external A2A exposure | Accepted |
| A2A design (deferred) | [agent-team-a2a-exposure-deferred.md](agent-team-a2a-exposure-deferred.md) | Deferred design for external A2A | Deferred |

## Conventions

- Each feature doc starts with a reference to [Platform HLD](platform-hld.md) and the building blocks it uses.
- Use a narrative style: introduce concepts before details; open sections with context.
- The first time a term appears that may be unfamiliar (e.g. RAG, Temporal, FTS), define it in one sentence or link to References / glossary.
- Use a consistent level-2 pattern where it fits: Overview, How it works (or equivalent), Implementation notes / References.
- Link to related feature docs (e.g. KB doc links to datasets; agents doc links to knowledge-base.md).
- Each feature doc ends with a **References** subsection (internal: design docs, HLD, code; external: official docs for third-party systems).

**Design doc checklist** — When writing or updating a feature doc, ensure a new engineer can answer: What is this feature for (one sentence)? Where does it sit in the platform? What do I read first (Doc map)? Where are unfamiliar terms defined or linked? Where do I go for more (References)? How does it connect to other features?

## Terms used in design docs

| Term | Meaning |
| ---- | ------- |
| **RAG** | Retrieval-augmented generation: using retrieved document chunks as context for an LLM so answers are grounded in project data. See [knowledge-base.md](knowledge-base.md). |
| **Temporal** | Workflow orchestration engine we use for durable, replayable workflows. [temporal.io](https://docs.temporal.io/). |
| **Keycloak** | Identity and access management; we use it for auth and service-account JWTs. [keycloak.org](https://www.keycloak.org/documentation). |
| **Iceberg** | Table format for structured data; we use it via the catalog for datasets. [iceberg.apache.org](https://iceberg.apache.org/). |
| **LanceDB** | Embedded vector database (Lance format on disk); used for KB vectors and FTS. [lancedb.com](https://lancedb.com/). |
| **Bifrost** | The sole LLM gateway — handles chat completions, embeddings, and MCP routing with per-project virtual keys for governance. See [bifrost-migration.md](bifrost-migration.md). |
| **TEI** | [Text Embeddings Inference](https://github.com/huggingface/text-embeddings-inference) — Hugging Face's production embedding server. Hosts our in-cluster `sentence-transformers/all-MiniLM-L6-v2` model behind Bifrost. |
| **MCP** | Model Context Protocol for tools/servers used by agents. [modelcontextprotocol.io](https://modelcontextprotocol.io/). |
| **Blue-green (versioning)** | New version written to a new path; a single pointer (e.g. metadata.json) is switched so rollout/rollback is atomic. |
