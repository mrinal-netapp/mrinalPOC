# Observability Setup for the AgentStudio Platform

This guide covers setting up observability — metrics, logging, and tracing — in a
local Kind (Kubernetes in Docker) cluster or any Kubernetes environment.

## Architecture Overview

Every AgentStudio service exposes a `GET /metrics` endpoint returning Prometheus
exposition format. The observability stack (Prometheus, Grafana, optional Jaeger)
is deployed **separately** from AgentStudio services.

| Service | Language | `/metrics` | Structured Logs | OTel Tracing |
|---------|----------|------------|-----------------|--------------|
| agent-service | Python (FastAPI) | Prometheus | JSON | OTLP → **Phoenix** (`PHOENIX_COLLECTOR_ENDPOINT`) |
| apigateway-service | Go (chi) | Prometheus | JSON (slog) | OTLP |
| config-service | TypeScript (Express) | Prometheus | JSON | OTLP |
| workflow-engine | Go (gin) | Prometheus | JSON (slog) | OTLP |
| analytics-engine | Go (chi) | Prometheus | JSON (slog) | OTLP |
| workspace-manager | TypeScript (Express) | Prometheus | JSON | OTLP |
| storage-manager | TypeScript (Express) | Prometheus | JSON | OTLP |
| kb-retrieval-service | Rust (axum) | Prometheus | JSON (tracing) | (planned) |
| vector-query-service | Python (Flask) | Prometheus | JSON | OTLP |
| nemo-operator | Go (controller-runtime) | Prometheus | - | - |

### Deployment Order

```
Phase 0 – Observability  make deploy-observability
Phase 1 – Foundation     make deploy-foundation
Phase 2 – Identity       make deploy-identity
                         make helm-platform-upgrade-local
                         make helm-workers-upgrade-local
                         make helm-services-upgrade-local
                         make helm-console-upgrade-local
```

Uninstall each tier with `helm uninstall <release> -n <namespace>`, or use `make undeploy-local`.

---

## Quick Start: metrics-server

The simplest way to get pod-level resource metrics (`kubectl top`):

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system --type='json' \
  -p='[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"}]'
kubectl wait --for=condition=available --timeout=300s deployment/metrics-server -n kube-system
```

Verify:
```bash
kubectl top pods -n agentstudio-services
kubectl top nodes
```

---

## Prometheus + Grafana (via Observability Chart)

### Option A: Use the bundled Helm chart (recommended)

The repository includes a dedicated `observability` Helm chart at
`deployments/helm/observability/`. It installs kube-prometheus-stack
(Prometheus + Grafana), **Arize Phoenix** (LLM/agent traces + UI on port 6006), and optionally Jaeger.

```bash
make helm-observability-upgrade
```

This deploys into the `monitoring` namespace. Prometheus is pre-configured to
discover ServiceMonitors across all namespaces.

### Option B: Manual helm install

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
  --set grafana.service.type=NodePort \
  --set grafana.service.nodePort=30000 \
  --set prometheus.service.type=NodePort \
  --set prometheus.service.nodePort=30090 \
  --set prometheus.prometheusSpec.retention=7d
```

---

## Enabling ServiceMonitors

Each AgentStudio service sub-chart includes a `ServiceMonitor` template, disabled by
default. Enable them during services tier upgrade:

```bash
# Enable all ServiceMonitors
make helm-services-upgrade-local HELM_EXTRA_ARGS="\
  --set apigateway-service.metrics.serviceMonitor.enabled=true \
  --set config-service.metrics.serviceMonitor.enabled=true \
  --set workflow-engine.metrics.serviceMonitor.enabled=true \
  --set analytics-engine.metrics.serviceMonitor.enabled=true \
  --set workspace-manager.metrics.serviceMonitor.enabled=true \
  --set storage-manager.metrics.serviceMonitor.enabled=true \
  --set kb-retrieval-service.metrics.serviceMonitor.enabled=true"
```

Or set `metrics.serviceMonitor.enabled: true` in `values.yaml` for each
service you want scraped.

### Verify Prometheus is scraping AgentStudio services

```bash
kubectl port-forward -n monitoring svc/prometheus-kube-prometheus-prometheus 9090:9090
```

Then open `http://localhost:9090` → **Status → Targets**. You should see one
target per enabled ServiceMonitor.

---

## Accessing Grafana

```bash
# Get admin password
kubectl get secret --namespace monitoring prometheus-grafana \
  -o jsonpath="{.data.admin-password}" | base64 --decode ; echo

# Port forward
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80
```

Open `http://localhost:3000` (username: `admin`).

---

## Service Metrics Reference

### Standard HTTP metrics (all services)

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_requests_total` | Counter | method, path, status | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | method, path, status | Request duration |
| `http_requests_in_flight` | Gauge | — | Concurrent requests |

### Analytics-engine specific

| Metric | Type | Description |
|--------|------|-------------|
| `flightsql_queries_total` | Counter | Total FlightSQL queries |
| `flightsql_query_errors_total` | Counter | FlightSQL query errors |
| `flightsql_connection_errors_total` | Counter | Connection errors |
| `flightsql_retries_total` | Counter | Retries |
| `query_cache_hits_total` | Counter | Cache hits |
| `query_cache_misses_total` | Counter | Cache misses |
| `query_cache_size` | Gauge | Current cache entries |
| `flightsql_query_duration_seconds` | Histogram | Query duration |

### kb-retrieval-service specific

| Metric | Type | Description |
|--------|------|-------------|
| `connection_pool_size` | Gauge | Current pool size |
| `connection_pool_hits_total` | Counter | Pool hits |
| `connection_pool_misses_total` | Counter | Pool misses |
| `connection_pool_evictions_total` | Counter | Pool evictions |

---

## Logging

All services now emit **structured JSON logs** to stdout. Each log line includes:

```json
{
  "time": "2026-02-15T12:00:00Z",
  "level": "info",
  "msg": "request",
  "service": "apigateway-service",
  "method": "GET",
  "path": "/config/api/v1/projects",
  "status": 200,
  "duration": "12.345ms",
  "request_id": "abc-123",
  "traceparent": "00-..."
}
```

- **Request ID** (`X-Request-Id`): Generated at the API Gateway (or accepted
  from the client); propagated to all backend services.
- **Trace context** (`traceparent`, `tracestate`): Propagated when OTel tracing
  is enabled.
- Health/ready endpoints are logged at **debug** level to reduce noise.

Control log level via `LOG_LEVEL` environment variable (default: `info`).

---

## Distributed Tracing (OpenTelemetry)

Tracing is **opt-in**. Set `OTEL_EXPORTER_OTLP_ENDPOINT` in each service to
enable it. When the env var is empty or unset, tracing is a no-op.

### Enable via Helm

```bash
make helm-services-upgrade-local HELM_EXTRA_ARGS="\
  --set apigateway-service.tracing.otlpEndpoint=otel-collector.monitoring:4318 \
  --set config-service.tracing.otlpEndpoint=otel-collector.monitoring:4318"
```

### Enable Jaeger backend

```bash
make helm-observability-upgrade HELM_EXTRA_ARGS="--set jaeger.enabled=true"
```

Then port-forward Jaeger:
```bash
kubectl port-forward -n monitoring svc/jaeger-query 16686:16686
```

Open `http://localhost:16686` to browse traces.

---

## Phoenix (LLM / agent observability)

Phoenix runs in the **`monitoring`** namespace as part of `make helm-observability-upgrade`. By default it stores trace data in **SQLite** on a persistent volume (`sqlite:////data/phoenix.db` under `PHOENIX_WORKING_DIR`), so it does not depend on the shared cluster PostgreSQL. You can switch to PostgreSQL via `phoenix.database.backend` in the observability chart values.

### URLs and environment variables

| Variable | Service | Purpose |
|----------|---------|---------|
| `PHOENIX_COLLECTOR_ENDPOINT` | agent-service | OTLP HTTP exporter target, e.g. `http://phoenix.monitoring.svc.cluster.local:6006/v1/traces`. If unset, tracing is disabled. |
| `PHOENIX_UI_URL` | apigateway-service | Upstream for reverse proxy to Phoenix UI/API, e.g. `http://phoenix.monitoring.svc.cluster.local:6006`. |

External browser URL (when Gateway + TLS are configured): **`https://phoenix.{endpoint}:{gatewayHttpsPort}`** (same pattern as `workflows.{endpoint}`).

### Verify

```bash
kubectl get pods -n monitoring -l app.kubernetes.io/name=phoenix
kubectl logs -n monitoring deploy/phoenix --tail=50
```

After invoking an agent, open the Phoenix UI and confirm spans appear. See [phoenix-runbook.md](phoenix-runbook.md) for troubleshooting.

---

## Useful Prometheus Queries

```promql
# All targets
up

# HTTP request rate across all AgentStudio services
sum(rate(http_requests_total{namespace="nemo"}[5m])) by (job)

# HTTP error rate (5xx)
sum(rate(http_requests_total{namespace="nemo",status=~"5.."}[5m])) by (job)

# P95 latency by service
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace="nemo"}[5m])) by (job, le))

# FlightSQL query rate (analytics-engine)
rate(flightsql_queries_total[5m])

# Cache hit ratio (analytics-engine)
rate(query_cache_hits_total[5m]) / (rate(query_cache_hits_total[5m]) + rate(query_cache_misses_total[5m]))

# CPU usage by pod
rate(container_cpu_usage_seconds_total{namespace="nemo",container!="POD",container!=""}[5m])

# Memory usage by pod
container_memory_working_set_bytes{namespace="nemo",container!="POD",container!=""}
```

---

## Troubleshooting

### No targets in Prometheus

```bash
kubectl get servicemonitors -n agentstudio-services
kubectl get svc -n agentstudio-services --show-labels
```

Ensure ServiceMonitors are enabled (`metrics.serviceMonitor.enabled: true`)
and their label selectors match the Kubernetes Service labels.

### Tracing not working

1. Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the pod:
   ```bash
   kubectl exec -n agentstudio-services deploy/apigateway-service -- env | grep OTEL
   ```
2. Check the collector / Jaeger is running in the `monitoring` namespace.
3. Look for `"tracing enabled"` or `"tracing disabled"` in the service logs.

### Phoenix UI or agent traces missing

1. Confirm Phoenix is running: `kubectl get pods -n monitoring -l app.kubernetes.io/name=phoenix`.
2. Confirm **agent-service** has `PHOENIX_COLLECTOR_ENDPOINT` set:
   ```bash
   kubectl exec -n agentstudio-services deploy/agent-service -- env | grep PHOENIX
   ```
3. Confirm NetworkPolicy allows **agent-service** and **apigateway-service** in `nemo` to reach Phoenix on port 6006 (`allow-nemo-to-phoenix` in `monitoring`).
4. If Phoenix crashes on startup: with default **SQLite**, check PVC binding and `/data`. With **PostgreSQL** backend, ensure PostgreSQL is up and the `phoenix` database exists (init container when `database.create` is true).
5. For DNS (`phoenix.{endpoint}`), ensure the hostname is on the Gateway certificate and CoreDNS hosts entries include `phoenix.{endpoint}` in local dev.

### Logs not in JSON

Ensure you are running the latest image. Older images used unstructured `log`
or Morgan-based logging.
