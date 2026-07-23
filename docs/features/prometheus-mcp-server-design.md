# Prometheus MCP Server — Design Document

> **Note (gateway migration):** Earlier revisions of this doc described
> the wire path as agent → LiteLLM → MCP pod. AgentStudio has since
> migrated entirely to the **Bifrost** LLM gateway. Bifrost owns the
> same MCP-client registry + per-server routing surface; read every
> "LiteLLM" / "LiteLLM proxy" reference below as "Bifrost" / "Bifrost
> gateway". The on-the-wire shape (streamable-http to `/mcp` on the
> managed MCP pod) is unchanged. See
> [bifrost-migration.md](../design/bifrost-migration.md).

## Executive Summary

This document describes the integration of a **Prometheus MCP server** into the AgentStudio platform, enabling AI agents to query Prometheus metrics via PromQL through standardized MCP tool interfaces. The server uses the open-source [`pab1it0/prometheus-mcp-server`](https://github.com/pab1it0/prometheus-mcp-server) (Python, MIT license), wrapped in a thin container image that rebinds the transport to match AgentStudio's managed MCP pod conventions. When deployed, the server auto-populates its `PROMETHEUS_URL` to point at AgentStudio's own Prometheus instance, enabling zero-config provisioning.

---

## Table of Contents

1. [Open-Source Evaluation](#open-source-evaluation)
2. [Architecture](#architecture)
3. [Transport and Protocol](#transport-and-protocol)
4. [MCP Tool Interface](#mcp-tool-interface)
5. [Configuration](#configuration)
6. [Container Image](#container-image)
7. [Health Probes](#health-probes)
8. [Networking](#networking)
9. [Deployment](#deployment)
10. [Security](#security)
11. [Alternatives Considered](#alternatives-considered)

---

## Open-Source Evaluation

Three open-source Prometheus MCP servers were evaluated:

| Criteria | pab1it0/prometheus-mcp-server | giantswarm/mcp-prometheus | yshngg/prometheus-mcp-server |
|---|---|---|---|
| Language | Python | Go | Go |
| Stars | 373 | 5 | 3 |
| License | MIT | Apache-2.0 | Apache-2.0 |
| Tools | 6 | 18 | ~6 |
| Transport | stdio, http, sse | stdio, sse, streamable-http | stdio |
| Docker image | `ghcr.io/pab1it0/prometheus-mcp-server` | Source only | Source only |
| Auth | Basic, Bearer, Multi-tenant | Basic, Bearer, Multi-tenant | Basic |
| Maintenance | Active (20 contributors, v1.5.3 Jan 2026) | Low activity | Inactive |

### Selection: pab1it0/prometheus-mcp-server

Rationale:

1. **Community adoption** — 373 stars and 79 forks indicate real-world usage and bug exposure. The giantswarm alternative has 5 stars.
2. **Sufficient tooling** — The 6 tools (`execute_query`, `execute_range_query`, `list_metrics`, `get_metric_metadata`, `get_targets`, `health_check`) cover the core use cases: PromQL queries, metric discovery, and target inspection. The 18-tool giantswarm server adds alerting rules, exemplars, and TSDB stats, which are useful for SRE workflows but not essential for agent-driven metric exploration.
3. **Pre-built Docker image** — Available at `ghcr.io/pab1it0/prometheus-mcp-server:latest`, avoiding a source build step.
4. **Python MCP SDK** — Uses `mcp[cli]>=1.6.0` which natively supports streamable-http transport via `transport=http`, producing a `/mcp` endpoint compatible with Bifrost's MCP routing.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        nemo namespace                                │
│                                                                      │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────────┐   │
│  │  Agent    │───▶│  Bifrost     │───▶│  mcp-server-prometheus   │   │
│  │  Service  │    │  gateway :8080│    │  Pod :8000/mcp           │   │
│  └──────────┘    └──────────────┘    └──────────┬───────────────┘   │
│                                                  │                    │
│  ┌──────────────────┐                            │ PromQL HTTP API    │
│  │  config-service   │                            │ :9090              │
│  │  (provisioning)   │                            │                    │
│  └──────────────────┘                            │                    │
└──────────────────────────────────────────────────┼────────────────────┘
                                                   │
                                                   ▼
                       ┌──────────────────────────────────────────────┐
                       │              monitoring namespace             │
                       │                                               │
                       │  ┌────────────────────────────────────────┐   │
                       │  │  Prometheus                             │   │
                       │  │  prometheus-prometheus:9090             │   │
                       │  │  (kube-prometheus-stack)                │   │
                       │  └────────────────────────────────────────┘   │
                       └──────────────────────────────────────────────┘
```

The data flow:

1. An agent calls an MCP tool (e.g., `execute_query`) through the Bifrost gateway.
2. Bifrost forwards the request via streamable-http to the managed MCP pod at `http://<name>.nemo.svc.cluster.local:8000/mcp`.
3. The MCP pod translates the tool call into a Prometheus HTTP API request (`/api/v1/query` or `/api/v1/query_range`).
4. Prometheus responds with metric data, which the MCP server formats and returns to the agent.

---

## Transport and Protocol

The upstream image defaults to **stdio** transport on port **8080**. AgentStudio's `MCPRuntimeManager` requires all managed MCP pods to serve **streamable-http** on port **8000** at the `/mcp` endpoint.

The Python MCP SDK (v1.6+) maps the environment variable `PROMETHEUS_MCP_SERVER_TRANSPORT=http` to streamable-http transport internally. When started in this mode, the server exposes:

- `/mcp` — streamable-http MCP endpoint (used by Bifrost)
- `/` — root endpoint that returns 200 (used for health probes)

The wrapper Dockerfile overrides three env vars to match AgentStudio conventions:

| Env Var | Upstream Default | AgentStudio override |
|---|---|---|
| `PROMETHEUS_MCP_SERVER_TRANSPORT` | `stdio` | `http` |
| `PROMETHEUS_MCP_BIND_HOST` | `127.0.0.1` | `0.0.0.0` |
| `PROMETHEUS_MCP_BIND_PORT` | `8080` | `8000` |

---

## MCP Tool Interface

All tools accept parameters as JSON objects and return text results.

### `execute_query`

Execute a PromQL instant query.

| Parameter | Required | Description |
|---|---|---|
| `query` | Yes | PromQL expression |
| `time` | No | Evaluation timestamp (RFC3339 or Unix) |
| `timeout` | No | Query timeout |

### `execute_range_query`

Execute a PromQL range query.

| Parameter | Required | Description |
|---|---|---|
| `query` | Yes | PromQL expression |
| `start` | Yes | Start time (RFC3339 or Unix) |
| `end` | Yes | End time (RFC3339 or Unix) |
| `step` | Yes | Step interval (e.g., `1m`, `5m`) |

### `list_metrics`

List all available metric names. Supports pagination and filtering.

### `get_metric_metadata`

Get metadata (type, help text, unit) for a specific metric or all metrics.

### `get_targets`

Get information about all scrape targets and their health status.

### `health_check`

Health check endpoint for verifying connectivity to the Prometheus server.

---

## Configuration

### Environment Variables

| Variable | Required | Secret | Default | Description |
|---|---|---|---|---|
| `PROMETHEUS_URL` | No | No | Auto-populated | URL of the Prometheus server |
| `PROMETHEUS_USERNAME` | No | Yes | — | Username for basic authentication |
| `PROMETHEUS_PASSWORD` | No | Yes | — | Password for basic authentication |
| `PROMETHEUS_TOKEN` | No | Yes | — | Bearer token for authentication |
| `ORG_ID` | No | No | — | Organization ID for multi-tenant setups |

### Auto-Population via `defaultEnvFn`

When a user deploys a Prometheus MCP server from the catalog, `PROMETHEUS_URL` is auto-populated through a three-stage chain:

```
Helm values.yaml                    config-service deployment.yaml
  prometheusMcp:          ──▶        env:
    defaultUrl: ""                     - name: PROMETHEUS_MCP_DEFAULT_URL
                                         value: "http://prometheus-prometheus.monitoring.svc.cluster.local:9090"
                                                    │
                                                    ▼
                                   mcpServerCatalog.ts defaultEnvFn()
                                     reads process.env.PROMETHEUS_MCP_DEFAULT_URL
                                     falls back to "http://prometheus-prometheus.monitoring:9090"
                                                    │
                                                    ▼
                                   MCPRuntimeManager.createDeployment()
                                     injects PROMETHEUS_URL into the managed pod
```

If the operator overrides `prometheusMcp.defaultUrl` in their Helm values, that URL propagates through the chain. Otherwise, the default points to AgentStudio's own Prometheus instance at `prometheus-prometheus.monitoring.svc.cluster.local:9090`.

---

## Container Image

### Why a Wrapper Image

The upstream `ghcr.io/pab1it0/prometheus-mcp-server:latest` cannot be used directly because:

1. **Port mismatch** — Upstream defaults to 8080; `MCPRuntimeManager` hardcodes port 8000 for all managed pods (Service, probes, URL generation).
2. **Transport mismatch** — Upstream defaults to stdio; managed pods must serve streamable-http.
3. **Bind address** — Upstream binds to `127.0.0.1`; pods must bind to `0.0.0.0`.

The wrapper image (`nemo/mcp-server-prometheus`) is a single-layer override:

```dockerfile
FROM ghcr.io/pab1it0/prometheus-mcp-server:latest
USER 1000
EXPOSE 8000
ENV PROMETHEUS_MCP_SERVER_TRANSPORT=http \
    PROMETHEUS_MCP_BIND_HOST=0.0.0.0 \
    PROMETHEUS_MCP_BIND_PORT=8000
```

This maintains the `nemo/*` image naming convention used by all other catalog entries and provides version control independent of the upstream release cadence.

### `readOnlyRootFilesystem` Compatibility

The `MCPRuntimeManager` defaults to `readOnlyRootFilesystem: true`. The upstream image sets `PYTHONDONTWRITEBYTECODE=1` (no `__pycache__` writes) and pre-compiles bytecode during the build. The runtime manager mounts `/tmp` as a writable emptyDir. No override is needed (unlike the DuckDB image which requires `readOnlyRootFilesystem: false`).

---

## Health Probes

The catalog entry uses **TCP probes** (`healthProbe: 'tcp'`) on port 8000.

Although the upstream Dockerfile's HEALTHCHECK uses `curl -f http://localhost:${PORT}/`, testing in the actual deployment revealed that `GET /` returns **HTTP 404** in the current version of the MCP Python SDK's streamable-http transport. The SDK only exposes the `/mcp` endpoint — the root path is not handled. This caused the K8s liveness probe to fail and the pod to crash-loop.

A TCP probe is the correct choice here (matching the DuckDB MCP server pattern). It confirms the Python process is listening and accepting connections on port 8000. While weaker than an HTTP probe, it avoids coupling to undocumented HTTP path behavior in the upstream SDK.

---

## Networking

### Egress (MCP Pod → Prometheus)

The MCP pod runs in the **nemo** namespace. Prometheus runs in the **monitoring** namespace on port 9090.

The `MCPRuntimeManager` creates a per-pod `NetworkPolicy` dynamically. The catalog entry specifies:

- `securityProfile: 'network-access'` — allows egress to common ports (443, 80, 5432, 6443)
- `egressPorts: [9090]` — additionally allows egress on port 9090 (Prometheus)

### Ingress (MCP Pod ← Bifrost)

The dynamically created NetworkPolicy allows ingress from the Bifrost gateway pods (labels `app.kubernetes.io/name: bifrost, component: bifrost`) on port 8000. This is the standard pattern for all managed MCP pods. See [bifrost-migration.md](../design/bifrost-migration.md) for the gateway-side allowlist semantics.

### Cross-Namespace Ingress (Prometheus ← MCP Pod)

An additive ingress NetworkPolicy is deployed in the observability chart to allow traffic from `mcp-stdio-runner` pods in the nemo namespace to Prometheus on port 9090. This is a no-op if no default-deny policy exists in the monitoring namespace, but prevents silent connection failures if one is added later.

The pod selector uses `operator.prometheus.io/name: prometheus`, which is the label the Prometheus Operator applies to the StatefulSet pods it manages (as opposed to Helm-generated labels like `app.kubernetes.io/name` which go on the Prometheus CR, not the pods).

---

## Deployment

### Zero-Config Provisioning

Users can deploy a Prometheus MCP server from the catalog with zero manual configuration:

1. Select "Prometheus" from the MCP server catalog in the UI.
2. The `PROMETHEUS_URL` field is pre-filled with the platform's Prometheus URL via `defaultEnvFn`.
3. Click deploy — `MCPRuntimeManager` provisions the pod, service, and network policy.
4. Attach the server to an agent — the `promptFragment` guides the agent on PromQL usage.

The `PROMETHEUS_URL` env var is marked `required: false` in the `envSchema` because `defaultEnvFn` auto-populates it. This allows users to deploy without entering any values while still showing the pre-filled default in the wizard UI for transparency.

### Catalog Entry Summary

| Field | Value |
|---|---|
| `id` | `prometheus_mcp` |
| `name` | Prometheus |
| `category` | `monitoring` |
| `image` | `nemo/mcp-server-prometheus` |
| `securityProfile` | `network-access` |
| `resourcePreset` | `small` (100m/256Mi request, 500m/512Mi limit) |
| `egressPorts` | `[9090]` |
| `healthProbe` | `tcp` |

---

## Security

- **Non-root execution** — Container runs as UID 1000 (both upstream and wrapper enforce this).
- **Read-only filesystem** — `readOnlyRootFilesystem: true` with `/tmp` as writable emptyDir.
- **Network isolation** — Egress restricted to DNS (53), common ports (443, 80, 5432, 6443), and Prometheus (9090). Ingress limited to Bifrost gateway pods on port 8000.
- **No privilege escalation** — `allowPrivilegeEscalation: false`, `capabilities: { drop: ['ALL'] }`.
- **No RBAC required** — The server makes HTTP calls to Prometheus, no Kubernetes API access needed.

---

## Alternatives Considered

### 1. giantswarm/mcp-prometheus (Go)

A Go-based MCP server with 18 tools, native streamable-http support, and advanced features (alerting rules, TSDB stats, exemplars, label/series discovery).

**Rejected** because:
- Only 5 GitHub stars — minimal community validation.
- 18 tools add context window overhead for agents that only need basic metric querying.
- Would require building from source (no pre-built Docker image).

### 2. Supergateway Wrapping

Using the `supercorp/supergateway` pattern (stdio-to-HTTP bridge) as done for PostgreSQL, GitHub, SQLite, and Memory MCP servers.

**Not needed** because the Python MCP SDK v1.6+ natively supports streamable-http transport. Adding supergateway would mean installing both Node.js (for supergateway) and Python (for prometheus-mcp-server) in the same image, adding unnecessary complexity.

### 3. Direct Upstream Image (No Wrapper)

Using `ghcr.io/pab1it0/prometheus-mcp-server:latest` directly without a `nemo/mcp-server-prometheus` wrapper.

**Rejected** because:
- Port 8080 → 8000 rebinding cannot be done via catalog `defaultEnvFn` (env vars are injected into the pod, but the image's `EXPOSE` and any port expectations are baked in).
- Breaks the `nemo/*` image naming convention used by all 7 existing catalog entries.
- No version control independent of upstream releases.

### 4. yshngg/prometheus-mcp-server (Go)

**Rejected** — only 3 stars, minimal maintenance, stdio-only transport.
