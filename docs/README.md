# AgentStudio Documentation

This directory contains architecture, design, operational, and reference documentation for the AgentStudio platform.

## Architecture

| Doc | Description |
| --- | ----------- |
| [HLD.md](HLD.md) | Long-form platform HLD: subsystems, scaling, monitoring, HA |
| [design/platform-hld.md](design/platform-hld.md) | Canonical architecture overview: building blocks, entities, flows |
| [architecture-diagrams.md](architecture-diagrams.md) | Mermaid source for architecture diagrams |

## Design docs

All subsystem designs live in [design/](design/). Start with the [design README](design/README.md) for an indexed table of all feature docs, conventions, and glossary.

Core areas: [connectors](design/connectors.md), [datasets](design/datasets.md), [knowledge bases](design/knowledge-base.md), [unified embedding models](design/unified-embedding-models.md), [Bifrost LLM gateway](design/bifrost-migration.md), [agents](design/agents.md), [pipelines](design/pipelines.md), [workspaces](design/workspaces.md), [workflows](design/workflows.md).

## Deployment and operations

| Doc | Description |
| --- | ----------- |
| [deployment-design.md](deployment/deployment-design.md) | Phased deploy (Makefile targets), releases, hooks, failure recovery |
| [cloud-deployment-runbook.md](deployment/cloud-deployment-runbook.md) | GKE + Trident + Cloud DNS automated deploy |
| [gateway-api-migration-guide.md](deployment/gateway-api-migration-guide.md) | Ingress NGINX to Gateway API (NGF) migration |
| [gateway-api-nginx-annotations-mapping.md](deployment/gateway-api-nginx-annotations-mapping.md) | Legacy NGINX annotations to Gateway API mapping |
| [nginx-gateway-payload-limit-troubleshooting.md](deployment/nginx-gateway-payload-limit-troubleshooting.md) | NGF ClientSettingsPolicy for body size limits |
| [cert-manager-private-tls-runbook.md](deployment/cert-manager-private-tls-runbook.md) | Private PKI TLS with cert-manager |
| [lakekeeper-troubleshooting.md](deployment/lakekeeper-troubleshooting.md) | Lakekeeper Helm, bootstrap, UI auth, API, S3 endpoint |
| [apply-coredns-local-mode.md](deployment/apply-coredns-local-mode.md) | CoreDNS hosts mode for local clusters |

## Authentication and authorization

| Doc | Description |
| --- | ----------- |
| [keycloak-integration.md](auth/keycloak-integration.md) | Keycloak deployment, issuers, GUI vars, troubleshooting |
| [keycloak-oidc-setup-guide.md](auth/keycloak-oidc-setup-guide.md) | Manual Keycloak client setup |
| [keycloak-reset-guide.md](auth/keycloak-reset-guide.md) | Keycloak reset and DB cleanup |
| [service-auth-matrix.md](auth/service-auth-matrix.md) | Service-to-service auth matrix (OIDC, SigV4) |
| [simplified-auth-model.md](auth/simplified-auth-model.md) | Project-level identity, header propagation |

## Testing

| Doc | Description |
| --- | ----------- |
| [integration-test-coverage.md](../tests/integration/integration-test-coverage.md) | Plain-language map of which user journeys our integration tests verify, by product capability, with a link to each test |
| [integration-test-priorities.md](../tests/integration/integration-test-priorities.md) | P0-P3 prioritization of the integration suites against the four core adoption journeys, with coverage gaps |
| [integration-cicd.md](testing/integration-cicd.md) | Integration tests in CI/CD: reusable workflow, per-env config contract, shared Allure service, nightly, ephemeral/vCluster calling convention |

## Storage

| Doc | Description |
| --- | ----------- |
| [storage-class-guide.md](storage/storage-class-guide.md) | StorageClass usage patterns (Trident, NFS) |
| [storage-access-modes-guide.md](storage/storage-access-modes-guide.md) | RWO vs RWM selection, AccessModeResolver |
| [pvc-dynamic-provisioning-design.md](storage/pvc-dynamic-provisioning-design.md) | Dynamic PVC bucket provisioning design |
| [static-pv-provisioning-design.md](storage/static-pv-provisioning-design.md) | Static PV pool design |
| [csi-driver-installation.md](storage/csi-driver-installation.md) | NFS/SMB CSI driver installation |
| [rbac-permissions-verification.md](storage/rbac-permissions-verification.md) | RBAC for storage operations |
| [s3gateway-bucket-registration-fix.md](storage/s3gateway-bucket-registration-fix.md) | VersityGW bucket registration troubleshooting |

## Observability

| Doc | Description |
| --- | ----------- |
| [OBSERVABILITY_PLAN.md](observability/OBSERVABILITY_PLAN.md) | Metrics strategy, Prometheus, Grafana |
| [KIND_METRICS_SETUP.md](observability/KIND_METRICS_SETUP.md) | ServiceMonitors, structured logging, tracing for Kind |
| [worker-hpa-runbook.md](observability/worker-hpa-runbook.md) | Temporal queue metrics + HPA for workers |
| [phoenix-runbook.md](observability/phoenix-runbook.md) | Phoenix (Arize) deploy/upgrade and troubleshooting |
| [phoenix-agent-observability-design.md](observability/phoenix-agent-observability-design.md) | Phoenix architecture and OTLP integration |

## Workspaces

| Doc | Description |
| --- | ----------- |
| [WORKSPACE_SUBDOMAIN_ROUTING_DESIGN.md](workspaces/WORKSPACE_SUBDOMAIN_ROUTING_DESIGN.md) | Workspace routing design (`ws-<id>.<endpoint>`) |
| [WORKSPACE_SUBDOMAIN_ROUTING_LOCAL_DEV_SETUP.md](workspaces/WORKSPACE_SUBDOMAIN_ROUTING_LOCAL_DEV_SETUP.md) | Local DNS, mkcert, /etc/hosts for Kind |
| [WORKSPACE_ID_FORMAT_DESIGN.md](workspaces/WORKSPACE_ID_FORMAT_DESIGN.md) | Base36 workspace ID format spec |
| [workspace-crd-design.md](workspaces/workspace-crd-design.md) | Workspace CRD and operator design |
| [JUPYTER_WORKSPACE_PROXY_DESIGN.md](workspaces/JUPYTER_WORKSPACE_PROXY_DESIGN.md) | JupyterLab proxy design |
| [JUPYTER_WORKSPACE_PROXY_IMPLEMENTATION.md](workspaces/JUPYTER_WORKSPACE_PROXY_IMPLEMENTATION.md) | JupyterLab proxy implementation details |

## Analytics and data

| Doc | Description |
| --- | ----------- |
| [analytics-service-redesign-final.md](analytics/analytics-service-redesign-final.md) | Analytics engine architecture and redesign |
| [analytics-service-redesign-quick-reference.md](analytics/analytics-service-redesign-quick-reference.md) | Analytics engine quick reference |
| [analytics-agent-design.md](analytics/analytics-agent-design.md) | Agent chat UI refactor with SSE and MCP |
| [analytics-engine-migration-guide.md](analytics/analytics-engine-migration-guide.md) | Session API to FlightSQL connection API migration |
| [flightsql-proxy-design.md](analytics/flightsql-proxy-design.md) | FlightSQL proxy sidecar design |
| [adbc-migration-summary.md](analytics/adbc-migration-summary.md) | ADBC migration for analytics-engine |
| [database-index-analysis.md](analytics/database-index-analysis.md) | PostgreSQL index analysis and recommendations |

## Feature designs

| Doc | Description |
| --- | ----------- |
| [pipeline-editor-handle-system-design.md](features/pipeline-editor-handle-system-design.md) | Pipeline editor handle system (types, validation, UX) |
| [duckdb-iceberg-mcp-server-design.md](features/duckdb-iceberg-mcp-server-design.md) | DuckDB/Iceberg MCP server for agents |
| [mcp-server-gateway-design.md](features/mcp-server-gateway-design.md) | MCP via the LLM gateway (Bifrost) |
| [prometheus-mcp-server-design.md](features/prometheus-mcp-server-design.md) | Prometheus MCP server design |
| [FACET_AND_DATASET_STATE_PLAN.md](features/FACET_AND_DATASET_STATE_PLAN.md) | Generic Facet model for state and job tracking |
| [PROGRESS_AND_STATS_PLAN.md](features/PROGRESS_AND_STATS_PLAN.md) | Progress and stats separation (workflow-engine vs config-service) |
| [dataset-creation-auth-fix.md](features/dataset-creation-auth-fix.md) | Dataset creation auth flow and Keycloak secret sync |

## Docker and builds

| Doc | Description |
| --- | ----------- |
| [docker-multiarch-builds.md](docker/docker-multiarch-builds.md) | Multi-arch Docker builds with Buildx |
| [docker-build-no-space.md](docker/docker-build-no-space.md) | Docker "no space" troubleshooting |
| [docker-progressive-manifest-plan-gaps.md](docker/docker-progressive-manifest-plan-gaps.md) | Progressive manifest merge gaps |

## Reference data

| Path | Description |
| ---- | ----------- |
| [agent-configs/](agent-configs/) | Sample agent and pipeline JSON configs |
| [knowledge-bases/](knowledge-bases/) | KB corpus (storage policy docs for RAG) |
| [figures/](figures/) | Diagram assets |
