# AgentStudio

AgentStudio is an AI-and-data platform where teams bring in data from anywhere, build knowledge bases, wire up pipelines, and let AI agents do the heavy lifting. Think of it as a workbench: you connect to your data sources, shape the data, teach your agents about it, and then let them answer questions, run analyses, or drive automations — all from one place.

It runs on Kubernetes, stores everything on a shared filesystem (POSIX-first, with an S3 compatibility layer for Iceberg), and uses Temporal for reliable, long-running workflows.

## What you can do

**Connect to data** — Register connectors for Amazon S3, PostgreSQL, MySQL, Google Cloud, NetApp ONTAP, ONTAP Metrics, Google Cloud NetApp Volumes Metrics, and Redash. Browse remote schemas and file trees right from the GUI, then pull data into the platform on demand or on a schedule.

**Create datasets** — Structured (Apache Iceberg tables via Lakekeeper catalog) or unstructured (file collections). Upload files manually or acquire them through connectors. The platform handles cataloging, schema inference, column-level stats, and PII detection.

**Build knowledge bases** — Point a KB at one or more datasets, and a Temporal workflow fans out to extract, parse, chunk, embed, and write into LanceDB. Once built, the kb-retrieval-service serves vector, full-text, and hybrid search with optional reranking — ready for RAG.

**Design agents** — Each agent gets a system prompt, an LLM (routed through the Bifrost gateway), optional knowledge bases for RAG, and optional MCP tool servers. Guardrails (max iterations, timeout, content filters) keep things in check. Chat with agents in the GUI or call them from pipelines.

**Wire up pipelines** — A visual DAG editor lets you chain processing steps: data transforms, agent calls, conditions, schedules, and more. Pipelines execute through Temporal with topological ordering, retries, and live progress tracking.

**Launch workspaces** — Spin up isolated JupyterLab (or other) environments per project. They mount the shared filesystem so you can explore data, run notebooks, and prototype without leaving the platform.

**Manage MCP servers** — A curated catalog of MCP servers (ONTAP, Kubernetes, PostgreSQL, DuckDB, GitHub, Prometheus, web search, filesystem, and more) can be attached to agents as tool providers.

## Architecture at a glance

| Layer | What lives here |
|-------|----------------|
| **GUI** | React / FluentUI web app — projects, connectors, datasets, KBs, agents, pipelines, workspaces, cost dashboard |
| **API Gateway** | Go service — routes requests, proxies Temporal and workspaces, handles Keycloak auth |
| **Config Service** | Node.js/TypeScript — CRUD for every entity (projects, datasets, connectors, agents, pipelines, KBs, MCP servers, credentials), backed by PostgreSQL |
| **Workflow Engine** | Go — stateless orchestrator that starts Temporal workflows (acquisition, KB creation, pipeline execution, cleanup) |
| **Agent Service** | Python — runs LLM agents with RAG (via kb-retrieval-service), MCP tools, structured output, and guardrails |
| **KB Retrieval Service** | Rust — serves vector, FTS, and hybrid search over LanceDB indexes on the shared filesystem |
| **Analytics Engine** | Go — analytics processing |
| **Storage Manager** | Node.js/TypeScript — PVC lifecycle, dynamic provisioning, volume mounts, storage class management |
| **Workspace Manager** | Manages isolated workspace environments (JupyterLab, etc.) |
| **Workers** | Python, on Temporal task queues — **connector-worker** (S3, DB, ONTAP metrics, GCNV metrics, Redash acquisition), **dataset-processor** (import, stats, PII), **kb-processor** (extract → chunk → embed → LanceDB) |
| **Infra** | PostgreSQL, Redis, Temporal, Lakekeeper (Iceberg catalog), Bifrost LLM gateway, S3 Gateway (VersityGW), Keycloak, Kubernetes Gateway API |

## Getting started

### Prerequisites

- Docker (or Podman)
- A Kubernetes cluster (GKE, kind, or similar)
- Helm 3.0+
- Node.js 20+ and Go 1.22+ (for local builds)
- `kubectl` configured for your cluster

### Build

```bash
make build            # Build all services locally
make docker-build     # Build Docker images for every service
```

You can target a single service with `make docker-build-service SERVICE=gui`, and skip expensive ones with `SKIP_SERVICES=kb-retrieval-service`.

### Deploy

The Makefile provides per-tier deployment targets. Each tier is a separate Helm release in its own namespace. All targets are idempotent — safe to re-run.

```bash
# Full AKS stack (database → identity → workers → platform → llm-gateway → services → console)
make deploy-all-tiers-aks

# Full local stack (KIND / Docker Desktop / k3d / minikube)
make deploy-local

# With TLS via cert-manager (AKS)
make deploy-all-tiers-aks ENDPOINT=studio.example.com CERT_MANAGER_GATEWAY_TLS=1
```

Individual phases:

| Phase | Target | What it installs |
|-------|--------|-----------------|
| 0 (opt) | `make deploy-observability` | Prometheus + Grafana |
| 1 | `make deploy-foundation` | Kubernetes Gateway API + PostgreSQL |
| 2 | `make deploy-identity` | Keycloak (OIDC provider) |
| 3 | `make helm-workers-upgrade-aks` | Processing workers (dataset, KB, connector), S3Gateway, storage-manager |
| 4 | `make helm-platform-upgrade-aks` | Redis, Temporal, Lakekeeper (depends on S3Gateway from Phase 3) |
| 4 | `make helm-llm-gateway-upgrade-aks` | Bifrost LLM gateway |
| 4 | `make helm-services-upgrade-aks` | Application services (API Gateway, Config, agents, etc.) |
| 4 | `make helm-console-upgrade-aks` | GUI (console) |

After install, a post-deploy hook creates a default S3 bucket and bootstraps Lakekeeper (EULA + default warehouse). See the [Lakekeeper Troubleshooting Guide](docs/deployment/lakekeeper-troubleshooting.md).

### Tear down

Uninstall each tier individually using `helm uninstall <release> -n <namespace>`, or use `make undeploy-local` for local clusters.

### Standalone images

MCP servers, workspace images, and job helpers live under `src/images/` and have their own build targets:

```bash
make images-build                    # Build all standalone images
make image-build IMAGE=mcp-server-kubernetes   # Build one
```

### Cloud deploy (GKE)

```bash
make deploy-gke-auto    # Creates cluster, node pool, storage, DNS, then deploys the full stack
```

## Configuration

Tunables are split across per-tier charts under `deployments/helm/{platform,services,workers,console,llm-gateway}/values.yaml`. Key Makefile variables:

| Setting | What it controls |
|---------|-----------------|
| `ENDPOINT` | Domain for TLS and subdomains (`auth.*`, `s3.*`, `catalog.*`, `ws.*`) |
| `CONTAINER_IMAGE_REPO` | Container registry base path |
| `HELM_NS_*` | Per-tier namespace overrides |
| `HELM_EXTRA_ARGS` | Extra args forwarded to all `helm upgrade` calls |

AKS-specific overlays (ANF NFS storage, static-PIP annotations) are in each tier's `values-aks.yaml`.

## Project layout

```
agentstudio/
├── src/
│   └── nemo/
│       ├── gui/                    # React web app (FluentUI)
│       ├── apigateway-service/     # Go — routing, auth proxy
│       ├── config-service/         # Node.js — entity CRUD, provider catalog
│       ├── workflow-engine/        # Go — Temporal orchestrator
│       ├── agent-service/          # Python — LLM agents, RAG, MCP tools
│       ├── kb-retrieval-service/   # Rust — vector + FTS search
│       ├── analytics-engine/       # Go — analytics processing
│       ├── storage-manager/        # Node.js — PVC and volume lifecycle
│       └── workers/
│           ├── connector-worker/   # Python — data acquisition (S3, DB, ONTAP, Redash)
│           ├── dataset-processor/  # Python — import, stats, PII
│           ├── kb-processor/       # Python — extract, chunk, embed → LanceDB
│           └── shared/             # Shared worker utilities
├── src/images/                     # Standalone container images
│   ├── workspace-jupyterlab/       # JupyterLab workspace image
│   ├── mcp-server-ontap/           # MCP servers (ONTAP, K8s, Postgres,
│   ├── mcp-server-kubernetes/      #   DuckDB, GitHub, Prometheus,
│   ├── mcp-server-postgres/        #   web search, filesystem, SQLite,
│   ├── mcp-server-duckdb/          #   SearXNG, memory)
│   ├── ...                         #
│   └── job-setup/                  # Job bootstrap image
├── src/nemo-operator/              # Kubernetes operator
├── deployments/
│   └── helm/
│       ├── nemo/                   # Main Helm chart
│       ├── database/               # PostgreSQL chart
│       └── observability/          # Prometheus + Grafana
├── docs/                           # Design docs, runbooks, ADRs
│   └── design/                     # Platform HLD, subsystem designs
├── api/                            # OpenAPI specs
│   └── openapi/
├── scripts/                        # Build and deploy helpers
└── Makefile                        # One-stop build and deploy
```

## Connectors

The provider catalog currently supports:

| Provider | Scope | Acquisition | Browse actions |
|----------|-------|-------------|---------------|
| Amazon S3 | Resource | Yes | List files and folders |
| PostgreSQL | Resource | Yes | List databases, schemas, tables, describe columns |
| MySQL | Resource | Yes | List databases, schemas, tables, describe columns |
| Google Cloud | Account | — | List regions, services, resources, databases, instances, volumes, files |
| NetApp ONTAP | Account | — | List SVMs, volumes, LUNs, snapshots, aggregates, network interfaces, test mounts |
| ONTAP Metrics | Account | Yes | Test connection |
| GCNV Metrics | Account | Yes | Test connection |
| Redash | Account | Yes | List queries, dashboards, data sources, describe queries |

## Documentation

Detailed design docs live under `docs/design/`:

- [Platform HLD](docs/design/platform-hld.md) — building blocks, entities, storage model
- [Connectors](docs/design/connectors.md) — connector types, acquisition flow
- [Datasets](docs/design/datasets.md) — kinds, lifecycle, catalog integration
- [Knowledge Bases](docs/design/knowledge-base.md) — creation pipeline, retrieval, search modes
- [Agents](docs/design/agents.md) — agent model, RAG, MCP tools
- [Pipelines](docs/design/pipelines.md) — DAG editor, execution, task queues
- [Workspaces](docs/design/workspaces.md) — templates, lifecycle
- [Workflows](docs/design/workflows.md) — Temporal execution model, durability, scaling
- [Deployment Design](docs/deployment/deployment-design.md) — phased deploy, failure recovery
- [Gateway API Migration](docs/deployment/gateway-api-migration-guide.md) — ingress to Gateway API

## License

[Add your license here]
