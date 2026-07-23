# Platform Observability Plan (Revised)

## Verification: No consumers of existing GET /metrics

Checked the codebase for any use of the current **GET /metrics** endpoints:

- **analytics-engine** (`GET /metrics` → JSON): Only defined and documented; no HTTP client or dashboard calls it.
- **kb-retrieval-service** (`GET /metrics` → JSON): Used only in `tests/route_integration.rs` for endpoint existence; no production consumer.
- **vector-query-service** (`GET /metrics` → JSON): README suggests manual `curl`; no service or dashboard consumes it.
- **KIND_METRICS_SETUP.md** ServiceMonitor examples use `path: /metrics` for **Prometheus scraping**, not for the current JSON payloads.

**Conclusion:** No backwards-compatibility is required for the existing JSON metrics. We can **unify on a single path and format**.

**Note on POST metrics (unchanged):**  
- Config-service **POST** `/api/v1/deployments/:deploymentId/metrics` (deployment metrics ingestion) is implemented and persisted; the architecture diagram describes SysManager reporting metrics, but no caller exists in this repo. Leave as-is for now.  
- Storage-manager **POST** `/api/v1/metrics` is a placeholder (logs and returns accepted); no callers. Can be removed or deprecated separately.

---

## Simplified metrics strategy: one path, one format

**Unify on:**

- **Path:** `GET /metrics` (standard for Prometheus)
- **Format:** Prometheus exposition format only (no dual JSON endpoint)
- **No** “keep JSON at `/metrics` and add Prometheus at `/metrics/prometheus`” — replace the existing JSON endpoints with Prometheus.

### Per service

| Service | Current | Change |
|--------|---------|--------|
| **API Gateway** | No /metrics | Add `GET /metrics` with Prometheus (request count, latency by route/method/status). |
| **Workflow-engine** | No /metrics | Add `GET /metrics` with Prometheus (HTTP request count, latency). |
| **Analytics-engine** | `GET /metrics` → JSON (cache, queries, latency) | **Replace** with `GET /metrics` → Prometheus. Expose same concepts as Prometheus counters/histograms (e.g. query total, errors, cache hits/misses, request duration histogram). Remove JSON handler. |
| **Config-service** | No GET /metrics | Add `GET /metrics` with Prometheus (HTTP request count, latency). |
| **Workspace-manager** | No /metrics | Add `GET /metrics` with Prometheus (HTTP request count, latency). |
| **Storage-manager** | No GET /metrics | Add `GET /metrics` with Prometheus (HTTP request count, latency). |
| **KB-retrieval-service** | `GET /metrics` → JSON (pool, requests) | **Replace** with `GET /metrics` → Prometheus. Expose pool stats and request count/latency as Prometheus metrics. Remove JSON response. |
| **Vector-query-service** | `GET /metrics` → JSON (pool, requests) | **Replace** with `GET /metrics` → Prometheus. Same idea: pool + request metrics in exposition format. Remove JSON. |
| **AgentStudio-operator** | `:8080/metrics` Prometheus (controller-runtime) | Keep as-is. |

### Implementation details

- **Go:** Use `github.com/prometheus/client_golang`; instrument HTTP with a middleware that records count and latency (histogram) by method and route (and status if desired). For analytics-engine, replace the existing metrics handler with a handler that writes Prometheus format (and optionally keeps in-memory stats only for the metrics registry).
- **TypeScript:** Use `prom-client`; add a single `GET /metrics` route and HTTP middleware for request count/duration; integrate in BaseServer so all Express services get it.
- **Rust (kb-retrieval-service):** Use `metrics` (or `prometheus`) crate and `metrics-exporter-prometheus`; replace the current JSON `/metrics` handler with one that writes exposition format from the same underlying counters (total, success, fail, latency, pool stats).
- **Python (vector-query-service):** Use `prometheus_client`; replace the JSON `/metrics` handler with a Prometheus handler (same counters: request count, latency, pool).

### ServiceMonitors (in AgentStudio chart)

- Every AgentStudio service that exposes `GET /metrics`: ensure container port (e.g. `metrics` or `http`) and add a **ServiceMonitor** manifest in the AgentStudio Helm chart (same namespace as the service). These CRs are only discovery metadata; they do not deploy Prometheus. The **separately deployed** Prometheus (see below) will scrape targets based on these ServiceMonitors when configured to discover them across namespaces.

---

## Observability stack: separate deployment and phase

The observability stack (Prometheus, Grafana, OTLP collector, Jaeger, optional Loki) is **deployed and managed separately** from AgentStudio application services. It is **not** a subchart or dependency of the AgentStudio Helm chart.

### Principles

- **Separate release:** One or more Helm releases (e.g. `observability` or `monitoring`) distinct from `nemo`, `database`, `keycloak`.
- **Separate namespace:** Deploy the stack in its own namespace (e.g. `monitoring`). Application services stay in `nemo` (and other app namespaces).
- **Separate deployment phase/target:** In CI/CD or local workflow, observability is a **dedicated target** (Phase 0) that runs **before** foundation. Example: `make deploy-observability` independently. See [Deployment Design](../deployment/deployment-design.md).

### What lives where

| Responsibility | AgentStudio chart | Observability chart(s) |
|----------------|------------|-------------------------|
| AgentStudio app services (gateway, config, workflow, etc.) | Yes | No |
| Expose `GET /metrics` (Prometheus format) from each service | Yes | No |
| ServiceMonitor/PodMonitor CRs (for AgentStudio services) | Yes (in `nemo` namespace) | No |
| Prometheus (scraping, storage) | No | Yes |
| Grafana (dashboards) | No | Yes |
| OTLP collector (traces/metrics) | No | Yes |
| Jaeger (or Tempo) (trace backend) | No | Yes |
| **Phoenix** (Arize — LLM/agent traces, OTLP HTTP, UI) | No | Yes |
| Optional: Loki, Promtail (logs) | No | Yes |

AgentStudio chart **only** emits telemetry (metrics endpoints, OTLP if configured). It does **not** install or configure Prometheus, Grafana, or trace backends.

### Deployment flow

1. **Phase 0 – Observability (optional):** `make deploy-observability` (Prometheus, Grafana, **Phoenix** for LLM observability, optional Jaeger — all into `monitoring` namespace). Phoenix defaults to **SQLite on a PVC** (`/data`), so it does **not** require the shared PostgreSQL namespace; optional **PostgreSQL** backend is available via Helm values if you prefer a central DB.
2. **Phase 1 – Foundation:** `make deploy-foundation` (Gateway API, PostgreSQL).
3. **Phase 2 – Identity:** `make deploy-identity` (Keycloak).
4. **Platform Infra:** `make helm-platform-upgrade-aks` (Redis, Temporal, Lakekeeper, S3Gateway + hooks).
5. **App Services:** `make helm-services-upgrade-aks` + `make helm-console-upgrade-aks` (full AgentStudio stack; services expose `/metrics` and optional OTLP).

Uninstall order should reverse this (observability first, then AgentStudio, then deps).

### Implementation

- **Helm chart:** Add a dedicated chart (e.g. `deployments/helm/observability`) that:
  - Uses community charts as subcharts or dependencies (e.g. `kube-prometheus-stack` for Prometheus + Grafana + ServiceMonitor discovery, **local subchart `phoenix`** for Arize Phoenix, and optionally Jaeger).
  - Creates namespace `monitoring` (or configurable).
  - Configures Prometheus to discover ServiceMonitors in all namespaces (e.g. `serviceMonitorSelectorNilUsesHelmValues: false`), so it scrapes AgentStudio services via the ServiceMonitors defined in the AgentStudio chart.
- **Makefile:** Add targets such as `helm-observability-install`, `helm-observability-upgrade`, `helm-observability-uninstall`, `helm-observability-status`, and document them in the main `make help` and in [KIND_METRICS_SETUP.md](KIND_METRICS_SETUP.md).
- **Documentation:** In KIND_METRICS_SETUP and HLD, state that the observability stack is optional and deployed as a separate phase; provide the recommended order (deps → nemo → observability).

---

## Logging and tracing (unchanged from original plan)

- **Logging:** Structured (JSON) logs with correlation ID (`X-Request-Id`) and optional trace ID; propagate from gateway to backends; standardize per runtime (Go: slog/zerolog; TypeScript: pino; Rust: keep tracing-subscriber; Python: structlog or JSON logging).
- **Tracing:** OpenTelemetry with OTLP; W3C Trace Context propagation; instrument gateway and all backends; single trace per API request; optional OTLP collector + Jaeger when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. **LLM/agent traces** from **agent-service** go to **Phoenix** via `PHOENIX_COLLECTOR_ENDPOINT` (OTLP HTTP to `http://phoenix.monitoring.svc.cluster.local:6006/v1/traces`); the Phoenix UI is exposed at `phoenix.{endpoint}` through the API Gateway (see [phoenix-runbook.md](phoenix-runbook.md)).

---

## Summary

- **Metrics:** No existing consumers of GET /metrics → **no backwards compatibility**. Use one path (`/metrics`) and Prometheus exposition only; replace current JSON endpoints in analytics-engine, kb-retrieval-service, and vector-query-service with Prometheus. Add Prometheus `/metrics` to gateway, workflow-engine, config-service, workspace-manager, storage-manager. Add ServiceMonitor manifests in the AgentStudio chart for discovery; Prometheus itself is not in the AgentStudio chart.
- **Observability stack:** Deployed and managed **separately** from AgentStudio (own Helm release and namespace `monitoring`). Deploy as Phase 0 before other phases using `make deploy-observability`. AgentStudio only emits telemetry; Prometheus, Grafana, **Phoenix**, OTLP collector, and Jaeger are in the observability chart/target. See [Deployment Design](../deployment/deployment-design.md) and [Phoenix runbook](phoenix-runbook.md).
- **Logging and tracing:** As in the original holistic plan (correlation ID, structured logs, optional distributed tracing).
