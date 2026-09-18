# AgentStudio Observability — Architecture Guide

> Source of truth: `NetApp-Nemo/AgentStudio` @ `main` (commit `b01a2a9ad`, *feat(observability): Feature/wait for observability stack (#729)*).
> Everything below is drawn from the Helm charts under `deployments/helm/observability/`, the shared observability clients under `src/common-*/observability/`, and the three Go proxies under `src/nemo/observability/`.

---

## 1. Overview

AgentStudio runs a **self-hosted, OpenTelemetry-first observability stack** in the `monitoring` namespace. Every service emits the three signals through a common client library, ships them by OTLP to a central collector, and the collector fans them out to four backends.

The single most important design decision: **agent/LLM traces and infrastructure traces are split at the collector.** Agent spans go to **Arize Phoenix** unsampled; everything else goes to **Grafana Tempo** tail-sampled. That is what makes AI observability (prompts, tokens, cost, tool calls) usable without paying for 100 % retention of ordinary HTTP spans.

The second design decision: **no browser and no Grafana datasource ever talks to a backend directly.** Three Go reverse proxies sit in front, authenticate against Keycloak, and rewrite every PromQL / LogQL / TraceQL query so a user only sees their own projects.

| Signal | Producer | Transport | Backend | Retention |
|---|---|---|---|---|
| Traces (agent/LLM) | OpenInference + Agent Framework | OTLP/HTTP → collector | **Phoenix** `:6006` | 30 d |
| Traces (infra) | Shared OTel clients | OTLP → collector | **Tempo** `:3200` | 7 d (168 h) |
| Traces (Bifrost) | Bifrost OTEL plugin | OTLP/HTTP → collector | **Tempo** (100 %) | 7 d |
| Metrics | OTLP push + Prometheus scrape | OTLP → collector `:8889` | **Prometheus** | 90 d / 100 GB |
| Logs | stdout JSON → DaemonSet tail | OTLP/gRPC → collector | **Loki** `:3100` | 7 d (168 h) |

---

## 2. End-to-end architecture

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  APPLICATION TIER   (agentstudio-services / -workers / -llm-gateway / -edge)          │
│                                                                                       │
│  agent-service-maf   config-service    workflow-engine   kb-retrieval    bifrost      │
│  agent-service       artifact-service  apigateway-svc    (Rust)          (Go/LLM GW)  │
│  python workers      storage-manager   analytics-engine                  eval-worker  │
│        │                    │                 │                │              │       │
│        │  OTLP/HTTP traces + metrics          │                │              │       │
│        │  stdout JSON logs                    │                │              │       │
└────────┼────────────────────┼─────────────────┼────────────────┼──────────────┼───────┘
         │                    │                 │                │              │
         │                    ▼                 ▼                ▼              │
         │        ┌───────────────────────────────────────────────────┐         │
         │        │  OTLP  gRPC :4317   /   HTTP :4318                │◄────────┘
         │        │  observability-otel-collector  (Deployment, x1)   │
         │        └───────────────────────────────────────────────────┘
         │                              ▲
         │  /var/log/pods/*.log         │  OTLP/gRPC :4317
         │        ┌─────────────────────┴───────────────────┐
         └───────►│  otel-collector DaemonSet (1 per node)  │
                  │  filelog → CRI unwrap → drop infra ns   │
                  └─────────────────────────────────────────┘

                        ┌──── CENTRAL COLLECTOR PIPELINES ────┐
                        │                                      │
      traces/phoenix ───┤ filter: agent span?  YES  ───────────┼──► Phoenix   :6006  (unsampled)
      traces/bifrost ───┤ filter: service==bifrost ────────────┼──► Tempo     :4317  (100 %)
      traces/tempo   ───┤ filter: agent span?  NO + sampling ──┼──► Tempo     :4317  (10 % + errors + slow)
      traces/spanmetrics┤ ALL spans → spanmetrics connector ───┼──┐
      metrics        ───┤ OTLP push + spanmetrics ─────────────┼──┴► prometheus exporter :8889
      logs           ───┤ noise filter → severity → project_id ┼──► Loki      :3100/otlp
                        └──────────────────────────────────────┘
                                          │
                          Prometheus scrapes :8889 (ServiceMonitor)
```

### 2.1 Read path (who can see what)

```
                Browser / AgentStudio UI
                          │
              ┌───────────┴────────────┬─────────────────────┐
              │                        │                     │
   grafana.<endpoint>        app.<endpoint>/prometheus   phoenix.<endpoint>
       (no edge JWT)            (edge JWT REQUIRED)        (no edge JWT)
              │                        │                     │
              ▼                        ▼                     ▼
     ┌────────────────┐      ┌───────────────────┐   ┌────────────────┐
     │ grafana-proxy  │      │ observability-    │   │ phoenix-proxy  │
     │     :8080      │      │ proxy :9091       │   │     :8080      │
     │ OIDC authcode  │      │ /prometheus lane  │   │ handoff token  │
     └───────┬────────┘      │ Bearer JWT        │   └───────┬────────┘
             │               └─────────┬─────────┘           │
   X-WEBAUTH-USER/ROLE/EMAIL           │                     │ GraphQL
             ▼                         │                     │ allow-list
     ┌────────────────┐                │                     ▼
     │    Grafana     │                │            ┌────────────────┐
     └───────┬────────┘                │            │ Phoenix :6006  │
             │ X-Grafana-User          │            │ (single-tenant)│
             ▼                         │            └────────────────┘
     ┌───────────────────────┐         │
     │ observability-proxy   │◄────────┘
     │ PromQL / LogQL /      │
     │ TraceQL rewriting     │
     └───┬────────┬──────────┘
         │        │        │
         ▼        ▼        ▼
   Prometheus   Loki     Tempo
     :9090     :3100     :3200
```

NetworkPolicies enforce this shape: **Grafana is not on the allow-list for Prometheus / Loki / Tempo.** It has to go through `observability-proxy`.

---

## 3. Signal 1 — Traces

### 3.1 How a span is classified

`deployments/helm/observability/charts/otel-collector/templates/configmap.yaml` builds one OTTL condition (`otel-collector.agentSpanCondition`). A span is an **agent span** when *any* of these is true:

```
resource.attributes["service.name"] == "agent-service"
resource.attributes["service.name"] == "agent-service-maf"
resource.attributes["service.name"] == "apigateway-service"
attributes["openinference.span.kind"] != nil      # openinference-instrumentation-*
attributes["gen_ai.system"]          != nil       # OTel GenAI semconv
attributes["llm.model_name"]         != nil       # older LLM instrumentation
```

The net is cast deliberately wide: **any new service using OpenInference or GenAI semantic conventions is routed to Phoenix with no config change.**

`agentServiceNames` is a Helm value (`otel-collector.tracing.agentServiceNames`), so adding a service is a one-line values edit.

### 3.2 Three trace pipelines

```
                       ┌───────────────────────────────────────────┐
   incoming OTLP spans │  memory_limiter (192 MiB)                 │
   ────────────────────┤                                           │
                       └───┬──────────────┬─────────────────┬──────┘
                           │              │                 │
              ┌────────────▼───┐  ┌───────▼────────┐  ┌─────▼──────────────┐
              │ traces/phoenix │  │ traces/bifrost │  │ traces/tempo       │
              ├────────────────┤  ├────────────────┤  ├────────────────────┤
              │ exclude bifrost│  │ keep ONLY      │  │ exclude bifrost    │
              │ keep agent only│  │ service=bifrost│  │ keep infra only    │
              │ normalize      │  │ copy x-project-│  │ tail_sampling      │
              │ batch          │  │ id → project_id│  │ normalize · batch  │
              │                │  │ normalize·batch│  │                    │
              │ NO SAMPLING    │  │ 100 % KEPT     │  │ 10 % + err + slow  │
              └───────┬────────┘  └───────┬────────┘  └─────────┬──────────┘
                      ▼                   ▼                     ▼
                  Phoenix              Tempo                  Tempo
                 OTLP/HTTP           OTLP/gRPC              OTLP/gRPC
```

**Why Bifrost gets its own lane.** The generic span-level split would send the LLM child span (which carries cost and token counts) to Phoenix while leaving the HTTP root span (which carries the correlation ID) in Tempo — breaking the trace in half. `filter/bifrost_only` + `filter/exclude_bifrost` keep the whole Bifrost trace intact in Tempo at 100 %.

**Tail sampling policy** (`traces/tempo` only):

| Policy | Type | Setting |
|---|---|---|
| `always-sample-errors` | `status_code` | `[ERROR]` |
| `always-sample-slow` | `latency` | `> 500 ms` (`tracing.slowThresholdMs`) |
| `probabilistic-sample` | `probabilistic` | `10 %` (`tracing.samplingPercentage`) |

`decision_wait: 10s`, `num_traces: 200`, `expected_new_traces_per_sec: 50`.

### 3.3 Transform steps worth knowing

| Processor | What it fixes |
|---|---|
| `transform/trace_normalize` | Strips `SpanKind.` / `StatusCode.` prefixes that some SDKs emit |
| `transform/bifrost_project_id` | Copies `http.request.header.x-project-id` → `project_id` (string **or** single-element slice), because `observability-proxy` scopes TraceQL on a literal `project_id` attribute |

Without `transform/bifrost_project_id`, project users would see **zero** Bifrost traces.

### 3.4 Phoenix — agent/LLM trace backend

- Image `arizephoenix/phoenix`, pinned by digest (`sha256:5ce8d477…`, was `version-15.12.0`).
- Service port **6006** (OTLP HTTP ingest **and** UI on the same port).
- `PHOENIX_DEFAULT_RETENTION_POLICY_DAYS=30`, `PHOENIX_TELEMETRY_ENABLED=false`.
- Storage: **SQLite on a 10 Gi PVC** by default (Phase-0 friendly — no dependency on shared Postgres); cloud overlays switch `database.backend: postgresql` against `shared-postgresql.database.svc.cluster.local`.
- **Migration guard** (added in `#729`): an init container runs `files/scripts/migration-guard.py`, reads the stored Alembic revision, walks the migration chain in the image, and if the revision is unknown (image up/downgrade) it **backs up the DB and lets Phoenix recreate it** — instead of a permanent `CrashLoopBackOff`.

### 3.5 Tempo — infrastructure trace backend

- OTLP **gRPC** ingest on `:4317`, query API on `:3200`.
- `backend: local`, blocks at `/var/tempo/blocks`, WAL at `/var/tempo/wal`, 30 Gi PVC.
- `block_retention: 168h`, `max_bytes_per_trace: 5 MB`.

---

## 4. Signal 2 — Metrics

### 4.1 Two ways metrics arrive

```
   (a) OTLP push                            (b) spanmetrics connector
   ─────────────                            ────────────────────────
   app → OTLP metrics → collector           ALL spans → spanmetrics
                          │                       │
                          └───────┬───────────────┘
                                  ▼
                    prometheus exporter :8889
                    namespace: "otelcol"
                    resource_to_telemetry_conversion: true   ◄── promotes
                                  │                              project_id
                                  │                              to a label
                          ServiceMonitor (30 s)
                                  ▼
                            Prometheus :9090
```

`spanmetrics` derives RED metrics from **every** span with zero app changes:

- histogram buckets `50ms, 100ms, 250ms, 500ms, 1s, 2s, 5s`
- dimensions `http.method`, `http.status_code`, `http.route`
- flush every `15s`, metric namespace prefix `traces.`

`resource_to_telemetry_conversion: enabled` is what makes `project_id` a first-class Prometheus label — the whole project-scoped dashboard story depends on it.

### 4.2 Application metric families

**Shared RED metrics** (emitted by `_RedMetricsSpanProcessor` in every language client):

```
http.server.request.count
http.server.request.error.count
http.server.request.duration_ms
  labels: http.request.method, url.path, http.response.status_code,
          project_id, entity_id, entity_type
```

**agent-service-maf business metrics** (`observability/run_metrics.py`):

| Metric | Type | Labels |
|---|---|---|
| `agent_run_total` | counter | `outcome` = success / error / timeout / guardrail_blocked |
| `agent_run_duration_ms` | histogram | — |
| `agent_runs_inflight` | up/down counter | — |
| `agent_run_timeouts_total` | counter | — |
| `agent_run_retries_total` | counter | — |
| **`guardrail_block_total`** | counter | `stage` (input/output/tool), `reason` |
| `agent_tool_calls_total` | counter | bounded labels |
| `agent_llm_requests_total` | counter | `model` |
| `agent_llm_tokens_total` | counter | `token_type` (input/output) |
| **`agent_cost_usd_total`** | counter | `model` — sourced from Bifrost `usage.cost` |
| `agent_delegation_total` | counter | — |
| `agent_dependency_failures_total` | counter | — |
| `agent_memory_ops_total` | counter | (`core/session_store.py`) |

**config-service** (`services/referenceEdgeMetrics.ts`): `reference_edges_applied_total`, `reference_edges_removed_total`, `reference_edge_drift_total`, `reference_edges_reconciler_last_success_timestamp_seconds`, `reference_edges_reconciler_scanned_total`.

**kb-retrieval-service**: `connection_pool_size`, `connection_pool_hits_total`, `connection_pool_misses_total`, `connection_pool_evictions_total`.

**eval-worker** is the exception: it does **not** use the shared client. It installs the Temporal SDK's own Prometheus exporter on `0.0.0.0:9465` (`METRICS_PORT`) and has no OTel traces.

### 4.3 Prometheus & Grafana

Deployed via `kube-prometheus-stack` (`fullnameOverride: prometheus`).

- `serviceMonitorSelectorNilUsesHelmValues: false` — discovers ServiceMonitors in **all** namespaces (needed so `agentstudio-*` services are scraped).
- Retention **90 d / 100 GB**, PVC-backed 100 Gi (`emptyDir` would lose history on restart).
- `alertmanager: disabled`, `nodeExporter` + `kubeStateMetrics` enabled.
- Operator admission webhook Jobs carry `sidecar.istio.io/inject: "false"` — otherwise the istio-proxy sidecar never exits and the Helm hook Job hangs, stalling the whole upgrade on meshed clusters.

### 4.4 prometheus-adapter → HPA

Bridges Prometheus into `custom.metrics.k8s.io` so worker HPAs can scale on Temporal queue backlog:

| Custom metric | PromQL source |
|---|---|
| `temporal_queue_backlog_dataset` | `rate(schedule_to_start_latency_count{task_queue="dataset-processing"}[2m])` |
| `temporal_queue_backlog_kb` | `…{task_queue="kb-processing"}` |
| `temporal_queue_backlog_connector` | `…{task_queue="connector-operations"}` |

### 4.5 ServiceMonitors — and what a CRD actually is

#### Custom Resource Definitions, briefly

Kubernetes ships with built-in object types — `Pod`, `Service`, `Deployment`, `ConfigMap`. A **CRD (CustomResourceDefinition)** lets you register a *new* object type with the API server, so `kubectl get servicemonitors` works exactly like `kubectl get pods`.

A CRD on its own is just a schema — it stores objects and validates them, nothing more. It only becomes useful when paired with an **operator**: a controller that watches for those objects and *does something*.

```text
   CRD          defines the TYPE          "a ServiceMonitor looks like this"
   Custom       an INSTANCE of the type   "scrape agent-service-maf every 30s"
   Resource
   Operator     the CONTROLLER that acts  watches ServiceMonitors → regenerates
                                          Prometheus scrape config → reloads it
```

This is the standard Kubernetes extension pattern: **declare desired state as an object, let a controller reconcile reality to match.**

#### What a ServiceMonitor is

A ServiceMonitor (`monitoring.coreos.com/v1`, from the **Prometheus Operator**) declaratively says: *scrape these Services, on this port, at this path, this often.*

The problem it solves:

```text
   WITHOUT the operator                 WITH ServiceMonitors
   ────────────────────                 ────────────────────
   one monolithic prometheus.yml        each chart ships its own
   static_configs / kubernetes_sd       ServiceMonitor next to the service
   + relabel rules                             │
        │                                      ▼
   every new service = edit the         operator watches for the CRD,
   central config + reload              regenerates scrape config, reloads
```

Scrape configuration becomes **decentralised and owned by each service's chart**, instead of a central file every team has to edit.

#### Ours, concretely

`deployments/helm/services/charts/agent-service-maf/templates/servicemonitor.yaml`:

```yaml
{{- if and .Values.enabled (default false .Values.metrics.serviceMonitor.enabled) (.Capabilities.APIVersions.Has "monitoring.coreos.com/v1") }}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: agent-service-maf
spec:
  selector:
    matchLabels:
      {{- include "agent-service-maf.selectorLabels" . | nindent 6 }}
  endpoints:
    - port: {{ default "http" .Values.metrics.port }}
      path: {{ default "/metrics" .Values.metrics.path }}
      interval: {{ default "30s" .Values.metrics.serviceMonitor.interval }}
{{- end }}
```

Note the capability guard on line 1 — `.Capabilities.APIVersions.Has "monitoring.coreos.com/v1"` means the chart only renders the ServiceMonitor **if the Prometheus Operator CRDs exist in the cluster**, so deployment doesn't break on clusters without them.

#### The selection chain — and the subtlety

```text
   ServiceMonitor
        │  selector.matchLabels
        ▼
   Kubernetes Service          ← selects the SERVICE, not pods
        │  the Service's own selector
        ▼
   Endpoints  →  Pod A, Pod B, Pod C
        │
        ▼
   Prometheus scrapes EACH POD individually
```

Prometheus does **not** scrape through the Service's load balancer. It resolves the Endpoints object and hits every pod separately — so you get **per-replica metrics**. (Scraping through the Service would return one arbitrary replica's counters each interval, which would be useless.)

Two gotchas:

- **`port` is the port's _name_ on the Service**, not a number — `port: http`, not `port: 8000`
- **`PodMonitor`** is the sibling CRD, for pods with no Service in front of them

This also explains `serviceMonitorSelectorNilUsesHelmValues: false` in §4.3 — without it, the operator would only discover ServiceMonitors carrying the Helm release's own labels, and none of the `agentstudio-*` service charts would be scraped.

#### Where they are — about 14

| Tier | Services with a ServiceMonitor |
|---|---|
| Services | agent-service-maf, agent-service, config-service, workflow-engine, apigateway-service, kb-retrieval-service, analytics-engine, artifact-service |
| Workers | storage-manager |
| Platform | temporal |
| LLM gateway | bifrost |
| Observability | otel-collector |

#### The architecturally interesting one

The **otel-collector** ServiceMonitor scrapes `:8889` — and that is the bridge between two opposite models:

```text
   apps ──OTLP PUSH──► collector ──► prometheus exporter :8889
                                              ▲
                                              │ PULL (scrape)
                                     Prometheus, via ServiceMonitor
```

OpenTelemetry is **push**-based; Prometheus is **pull**-based. The collector terminates the push side and re-exposes everything — including the spanmetrics derived from traces (§4.1) — as a scrapeable Prometheus endpoint.

So ServiceMonitors do two distinct jobs here: scraping services that expose `/metrics` natively (RED metrics), **and** scraping the collector to pull in everything that arrived over OTLP push.

---

## 5. Signal 3 — Logs

### 5.1 Path: stdout, not OTLP push

```
   app writes JSON to stdout
              │
              ▼
   /var/log/pods/<ns>_<pod>_<uid>/<container>/0.log
              │
   ┌──────────┴───────────────────────────────────────────┐
   │  DaemonSet collector (one per node)                  │
   │   filelog/pods  start_at: end                        │
   │   regex_parser  → k8s.namespace.name, k8s.pod.name,  │
   │                   k8s.pod.uid, k8s.container.name    │
   │   json_parser   → unwrap CRI  {"log":…,"stream":…}   │
   │   filter        → drop kube-system, kube-node-lease,  │
   │                   kube-public, aks-istio-system,      │
   │                   aks-istio-ingress                   │
   │   resource      → k8s.node.name                       │
   └──────────┬───────────────────────────────────────────┘
              │ OTLP/gRPC :4317
              ▼
   ┌──────────────────────────────────────────────────────┐
   │  Central collector — logs pipeline                   │
   │   filter/noise            drop GET /metrics, /health │
   │   transform/log_attributes  trace_id/span_id →       │
   │                             native OTel fields       │
   │   transform/log_project_id  regex project_id out of  │
   │                             the JSON body → resource │
   │   transform/severity        level → severity_number  │
   │   resource/k8s_logs         environment, cluster     │
   └──────────┬───────────────────────────────────────────┘
              ▼
        Loki :3100/otlp
```

**OTLP log push from apps is intentionally disabled** — if both paths were on, every line would land in Loki twice. Traces and metrics still use OTLP push.

### 5.2 Why the transforms matter

- `transform/log_attributes` promotes `trace_id` / `span_id` from log *attributes* into native OTel log record fields, so Loki stores them as **structured metadata**. That is what makes the Grafana "logs → trace" jump work without a high-cardinality label. It also deletes noisy keys (`endpoint`, `auth_type`, `duration_ms`, `span_attributes`, `span_name`, `span_kind`, `span_status`, `parent_span_id`, `timestamp`, `service_name`).
- `transform/log_project_id` regex-extracts `project_id` from the JSON body (two patterns — plain JSON and a still-wrapped CRI body) and promotes it to a **resource** attribute. Loki's `otlp_config` then indexes `project_id` as a label:

```yaml
limits_config:
  allow_structured_metadata: true
  otlp_config:
    resource_attributes:
      attributes_config:
        - action: index_label
          attributes: [project_id]
```

Without this, project-scoped log RBAC would have nothing to filter on.

### 5.3 Loki configuration

- `auth_enabled: false` (multi-tenancy is enforced by `observability-proxy`, not Loki).
- TSDB schema v13, filesystem object store, 30 Gi PVC, `replication_factor: 1`.
- `retention_period: 168h`, ingestion `64 MB/s` rate / `128 MB` burst.
- **Compactor with `retention_enabled: true`** — in Loki v3 `limits_config.retention_period` only *marks* streams; the compactor is what actually deletes chunks.

---

## 6. Application-side instrumentation

### 6.1 Shared observability clients

Rather than each service rolling its own SDK setup, there is one client per runtime:

| Runtime | Package |
|---|---|
| Python | `src/common-py/observability/observability-client/` |
| Go | `src/common-go/observability/observability-client/` |
| TypeScript | `src/common/src/observability/observability-client/` |
| Rust | `src/common-rs/observability/observability-client/` |

**Environment contract** (identical across all four):

| Purpose | Primary env var | Fallbacks |
|---|---|---|
| Traces | `AGENT_STUDIO_OBSERVABILITY_OTLP_TRACES_ENDPOINT` | `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Metrics | `AGENT_STUDIO_OBSERVABILITY_METRICS_OTLP_ENDPOINT` | `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |
| Logs | `AGENT_STUDIO_OBSERVABILITY_OTLP_LOGS_ENDPOINT` | `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` |
| Service name | `AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME` | `OTEL_SERVICE_NAME` |
| Prom port | `AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT` | default **8000** |
| Log level | `LOG_LEVEL` | `AGENT_STUDIO_OBSERVABILITY_MIN_LOG_LEVEL` |

In-cluster collector endpoints:

```
HTTP : http://observability-otel-collector.monitoring.svc.cluster.local:4318
gRPC : grpc://observability-otel-collector.monitoring.svc.cluster.local:4317
```

**App code exports OTLP over HTTP everywhere.** The only gRPC OTLP producers are the DaemonSet → central collector hop and the collector → Tempo hop.

### 6.2 Per-service matrix

```
┌──────────────────────┬──────────────────────┬────────────┬───────────────────────────────┐
│ Service              │ OTel init            │ Traces     │ Prometheus                    │
├──────────────────────┼──────────────────────┼────────────┼───────────────────────────────┤
│ agent-service-maf    │ api.py:226           │ OTLP/HTTP  │ run_metrics + RED (:8000)     │
│ agent-service        │ src/tracing.py:109   │ Phoenix    │ RED (:9090 default)           │
│ config-service       │ index.ts:66          │ OTLP/HTTP  │ RED + reference_edges_*        │
│ workflow-engine      │ cmd/server/main.go:27│ OTLP/HTTP  │ RED; /metrics on :8080        │
│ apigateway-service   │ main.go:229          │ OTLP/HTTP  │ RED; /metrics on :8080        │
│ analytics-engine     │ main.go:44           │ OTLP/HTTP  │ RED; /metrics on :5000        │
│ kb-retrieval-service │ main.rs:32           │ OTLP/HTTP  │ pool metrics; dedicated port  │
│ artifact-service     │ src/index.ts:17      │ OTLP/HTTP  │ RED                           │
│ storage-manager      │ src/index.ts:22      │ OTLP/HTTP  │ RED                           │
│ python workers       │ temporal_worker.py   │ OTLP/HTTP  │ RED (when port env set)       │
│ eval-worker          │ src/main.ts:21       │ NONE       │ Temporal SDK :9465            │
│ bifrost              │ Helm OTEL plugin     │ OTLP/HTTP  │ native /metrics + ServiceMon. │
└──────────────────────┴──────────────────────┴────────────┴───────────────────────────────┘
```

`apigateway-service` calls `ConfigureLoggingFromPackagedDefault()` without an explicit service name, so it inherits the packaged default unless `OTEL_SERVICE_NAME` is set in Helm — worth pinning.

### 6.3 Agent / LLM tracing (agent-service-maf)

Four layers stack up to produce a Phoenix trace:

```
1. ASGITraceMiddleware ......... SERVER span for the HTTP request
2. Agent Framework instrumentation ... agent / LLM / tool spans (gen_ai.*)
3. PhoenixProjectSpanProcessor ....... stamps agentstudio.project_id + session.id
                                        on span start; optionally rewrites
                                        openinference.project.name on span end
4. BatchSpanProcessor → OTLP/HTTP .... to the collector (or Phoenix directly)
```

Trace endpoint precedence in `interface_layer/api.py`:

```
PHOENIX_COLLECTOR_ENDPOINT
  → OTEL_EXPORTER_OTLP_TRACES_ENDPOINT_BEFORE_AUTO_INSTRUMENTATION
  → OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
```

The legacy `agent-service` takes a different route: it initialises Phoenix OTLP **first** (`src/tracing.py`), installs `AgnoInstrumentor()`, then calls the shared client with `otlp_traces_endpoint=None, enable_auto_instrumentation=False` so Agno owns tracing outright.

### 6.4 Bifrost telemetry

Bifrost has **no app-side instrumentation in this repo** — it is all Helm configuration (`deployments/helm/llm-gateway/charts/bifrost/values.yaml`):

```yaml
plugins:
  otel:
    enabled: true
    serviceName: bifrost
    collectorUrl: http://observability-otel-collector.monitoring.svc.cluster.local:4318/v1/traces
    protocol: http
    traceType: genai_extension
    capturedRequestHeaders:      # copied onto the root span
      - x-correlation-id
      - x-transaction-id
      - x-project-id
metrics:
  path: /metrics
  serviceMonitor: enabled
```

A plugin span filter excludes noisy internal plugins (logging, governance, otel hooks) from the trace.

### 6.5 Identity and correlation propagation

This is what ties a Phoenix span, a Loki line, and a Bifrost cost record to the same user action.

```
Edge JWT (Keycloak)
      │
      ▼
routes.py  ── correlation_id from _edge_correlation_id claim, else uuid4()
      │
      ├─► structlog.contextvars.bind(user_id, project_id, correlation_id)   → LOGS
      ├─► set_current_identity(IdentityContext)                             → SPANS
      │        └─ PhoenixProjectSpanProcessor reads it on span start
      │
      └─► outbound calls
             ├─ MCP over HTTP : X-User-ID, X-Project-ID, X-User-Email,
             │                  X-User-Name, X-User-Token, X-Correlation-ID
             ├─ MCP over stdio: _meta.identity.correlationId
             └─ W3C traceparent on every HTTP hop
```

`IdentityContext` (`core/identity.py`) deliberately **excludes `user_token` from serialization**. `X-Correlation-ID` and `X-Project-ID` are also what Bifrost captures onto its root span, which is how LLM cost joins back to the invoking agent run (`core/spend_attribution.py` emits a `cost_context` log event linking `correlation_id` + `transaction_id`).

The shared HTTP middleware in every language reads `X-Project-ID`, `X-Entity-ID`, `X-Entity-Type` and puts them on both the span **and** the RED metrics — which is exactly why `project_id` exists as a Prometheus label.

### 6.6 Logging per service

| Service | Library | JSON | Redaction | trace_id injected |
|---|---|---|---|---|
| agent-service-maf | structlog | yes | **`SecretRedactor`** in the chain | yes |
| agent-service | structlog (shared) | yes | shared client | yes |
| config / artifact / storage-manager | log4js | yes | — | yes |
| workflow-engine / apigateway / analytics | zap | yes | — | yes |
| kb-retrieval-service | `tracing` crate | yes | — | yes |
| python workers | structlog | yes | — | yes |
| **eval-worker** | custom `StructuredLogger` | yes | **none** | **no** |

`agent-service-maf` is the only service with an explicit secret redactor spliced into the log processor chain.

---

## 7. Access control — the three proxies

Phoenix OSS, Prometheus, Loki, and Tempo are all **single-tenant**. Multi-tenancy is bolted on entirely at the proxy layer.

### 7.1 grafana-proxy (`:8080`)

OIDC authorization-code proxy in front of Grafana. Keycloak client `agentstudio-grafana-proxy`.

```
Browser → /oauth2/callback  ── Keycloak authcode
                             ── claims → role + project list
                             ── encrypted session cookie (grafana-proxy-session,
                                HMAC + AES, HttpOnly, Secure, SameSite=Lax, 8 h)
                             │
   Director strips client-supplied auth headers, then injects:
        X-WEBAUTH-USER  = Keycloak sub
        X-WEBAUTH-ROLE  = Admin | Viewer
        X-WEBAUTH-EMAIL / X-WEBAUTH-NAME
                             ▼
                         Grafana (auth.proxy enabled, login form disabled)
```

Role resolution: realm role `platform-admin` → **Admin** with an empty project list (bypass everywhere downstream). Otherwise **Viewer** with the project list from `config-service GET /api/v1/projects`. A non-admin with zero projects gets **403**.

Two project endpoints:

| Endpoint | Caller | Auth |
|---|---|---|
| `GET /.auth/projects` | Grafana `$project` template variable | session cookie / `X-Grafana-User` |
| `GET /.internal/projects?sub=…` | **observability-proxy only** | `Authorization: Bearer <INTERNAL_TOKEN>` |

`/.internal/projects` returns `404` if the sub is not in the in-memory cache (e.g. after a proxy restart) — the user has to re-login through Grafana. Cache TTL `PROJECT_CACHE_TTL_SECONDS`, default **300 s**.

Also handles `/oauth2/handoff` (token-based session bootstrap from the AgentStudio UI, which avoids a Safari cross-origin redirect problem), `/oauth2/logout`, and Keycloak `/oauth2/backchannel-logout`.

### 7.2 observability-proxy (`:9091`) — the query rewriter

One deployment fronting all three query backends, with **two identity lanes**:

```
Lane 1 — Grafana datasources          Lane 2 — AgentStudio UI
   header: X-Grafana-User                path:  /prometheus/*
   (Grafana dataproxy.send_user_header)  header: Authorization: Bearer <JWT>
        │                                        │
        └── auth.Client.Lookup(sub) ──┐   ┌── DirectAuthenticator.Authenticate()
            → grafana-proxy           │   │   RS256, iss=KEYCLOAK_TOKEN_ISSUER,
              /.internal/projects     │   │   aud=agent-studio-api
                                      ▼   ▼
                             { sub, isAdmin, projects[] }
                                      │
                    ┌─────────────────┼──────────────────┐
                    ▼                 ▼                  ▼
              PromQL rewrite    LogQL rewrite      TraceQL rewrite
```

Route table (registration order matters — Loki/Tempo before the Prometheus catch-all):

| Prefix | Backend |
|---|---|
| `/prometheus`, `/prometheus/*` | Prometheus (UI lane, bearer auth) |
| `/loki/…` | Loki |
| `/tempo/…` | Tempo |
| `/api/v1/…`, `/api/…`, `/` | Prometheus (Grafana lane) |

**Rewriting rules** — shared primitives in `internal/rewrite/rewrite.go`:

```
Enforcement()  →  project_id=~"^(projA|projB)$"
Selector()     →  {project_id=~"^(projA|projB)$"}
```

| Language | Function | Behaviour |
|---|---|---|
| PromQL | `rewriteQuery` (`prometheus.go:223`) | intersect existing matchers, or append selector to a bare metric; pure scalars pass through; unscopeable queries return an **empty** vector/matrix rather than an error |
| PromQL labels/series | `handleLabel`, `handleSeries` | `project_id` returns the allowed list directly; other labels get a scoped `match[]` |
| LogQL | `rewriteLogQL` (`loki.go:174`) | same injection; fallback stream selector `{__observability_proxy_no_access__}` |
| TraceQL | `scopeTraceQL` (`tempo.go:248`) | wraps as `( {user spanset} && { .project_id =~ "^(allowed)$" } )` |
| Trace by ID | `handleTraceByID` (`tempo.go:157`) | fetches the trace server-side, walks the OTLP JSON for a `project_id` attribute, returns **404** (not 403) when denied so trace existence is not leaked |

Admin (`platform-admin`) bypasses all rewriting in every handler.

**Istio AuthorizationPolicy** (`charts/observability-proxy/templates/authorizationpolicy.yaml`): a **DENY** rule for the gateway service account `cluster.local/ns/agentstudio-edge/sa/agentstudio-gateway-istio` on port 9091 for every path **except** `/prometheus` and `/prometheus/*`. Browser traffic entering through the edge therefore cannot reach the Grafana datasource lane by forging or omitting `X-Grafana-User`.

### 7.3 phoenix-proxy (`:8080`)

Phoenix OSS has no tenancy at all, so the proxy constrains it from outside.

- **No OIDC redirect loop.** Entry is `GET /oauth2/handoff?token=<Keycloak JWT>&redirect=…`, JWKS-verified (RS256, issuer `KEYCLOAK_TOKEN_ISSUER`), then an encrypted `phoenix-proxy-session` cookie. A direct visit without a session gets `401 "Open Agent Traces from AgentStudio to sign in."`
- **Path guards:** `/redirects/projects/{name}` and `/projects/{id}/…` are checked against the allowed set; `authorizeNode()` resolves a Phoenix node ID to a project name via upstream GraphQL.
- **GraphQL allow-list:** viewers may only call read root fields (`projects`, `projectCount`, `node`, `getProjectByName`, nav badge counts). Mutations are refused. Datasets, prompts, settings, and direct trace/span roots are denied.
- **Response filtering:** `filterGraphQLResponse()` strips project edges outside the allowed set and zeroes nav badge counts for denied sections. Aliased `edges` fields are rejected outright as a bypass attempt.
- **REST `/v1/*` is blocked entirely for non-admins.**
- `ensurePhoenixProject()` pre-creates the Phoenix project over REST before redirecting, because a Phoenix project only materialises after its first span.

Crucially: **a Phoenix project name is the AgentStudio project ID.** That equality is the entire mapping between the two systems.

---

## 8. Edge exposure and network policy

### 8.1 Routes

| Host / path | Backend | Port | Edge JWT |
|---|---|---|---|
| `grafana.<endpoint>/` | `grafana-proxy` | 8080 | **no** |
| `phoenix.<endpoint>/` | `phoenix-proxy` | 8080 | **no** |
| `app.<endpoint>/prometheus*` | `observability-proxy` | 9091 | **yes** |

`authz-edge-require-jwt-istio.yaml` carves out the `grafana.*` and `phoenix.*` subdomains from the gateway JWT requirement — the handoff request has to arrive *before* a first-party session exists, and the dedicated proxies validate Keycloak identity themselves. In-app `/prometheus` queries on `app.<endpoint>` do require a validated JWT at the gateway, and are then re-validated as a bearer token inside `observability-proxy`.

A `ReferenceGrant` (`referencegrant-monitoring.yaml`) lets edge HTTPRoutes in `agentstudio-edge` reference Services in `monitoring`.

### 8.2 NetworkPolicy summary

```
Prometheus :9090  ◄── observability-proxy, mcp-stdio-runner, prometheus self, prometheus-adapter
Loki       :3100  ◄── observability-proxy, otel-collector
Tempo      :3200  ◄── observability-proxy          (query)
           :4317  ◄── otel-collector               (ingest)
Phoenix    :6006  ◄── agent-service, otel-collector, phoenix-proxy
Grafana           ◄── grafana-proxy only (+ Prometheus scrape)
```

**Grafana is absent from the Prometheus / Loki / Tempo allow-lists on purpose.** If someone repoints a Grafana datasource straight at a backend to "fix" a dashboard, it fails closed rather than silently bypassing project RBAC.

### 8.3 Mesh and Pod Security posture of the `monitoring` namespace

```yaml
# deployments/helm/observability/templates/namespace.yaml
labels:
  istio-injection: enabled
  pod-security.kubernetes.io/enforce: privileged
  pod-security.kubernetes.io/warn:    privileged
```

Two things follow from this:

1. Prometheus, Phoenix, Loki, Tempo, and the collectors all get Istio sidecars and participate in mesh mTLS.
2. The namespace is pinned to the **`privileged`** Pod Security Standard — not because the backends need it, but because the OTel **DaemonSet** mounts `/var/log/pods` and `/var/log/containers` as hostPath and runs as **UID 0** to read container-runtime-owned log files. Under `baseline` or `restricted`, PSA would reject that pod.

The cost is that the label applies to the whole namespace, so every workload in `monitoring` is exempt from PSA — a reasonable target for future tightening (per-workload exemption, or moving the log collector to its own namespace).

---

## 9. Deployment

### 9.1 Order

Observability is **Phase 0** — it can be installed before the rest of the platform (which is why Phoenix defaults to SQLite rather than depending on `shared-postgresql`).

```
make deploy-observability                 # sync-shared-secrets → helm-observability-upgrade
make deploy-observability-local           # + values-local.yaml
make helm-observability-upgrade-{aks,gke,eks}
```

Cloud pre-hooks:

1. `sync-shared-secrets TARGET_NS=monitoring` — `keycloak-oidc-secrets`, Postgres creds, CA certs.
2. `{cloud}-keycloak-grafana-proxy-secrets` — creates `grafana-proxy-session-secret` and `grafana-proxy-internal-token`.
3. `helm-observability-upgrade` — waits on otel-collector (180 s) and Phoenix (600 s).

Soft dependencies: Keycloak should exist first (grafana-proxy needs the OIDC client secret); config-service must be reachable for project membership; the edge tier needs `observability.enabled=true` to render the Phoenix HTTPRoute and the `/prometheus` route.

Proxy images are built from `OBSERVABILITY_SERVICES := grafana-proxy observability-proxy phoenix-proxy` (`mk/common.mk`).

### 9.2 What commit `b01a2a9ad` (#729) changed

| File | Change |
|---|---|
| `.github/scripts/wait-argocd-apps.sh` | adds `observability` to the default wait list; tolerates sole OutOfSync drift on the shared `Namespace/monitoring` (ownership conflict with tier-namespaces) |
| `charts/phoenix/files/scripts/migration-guard.py` | **new** — Alembic revision guard before Phoenix starts |
| `charts/phoenix/templates/deployment.yaml` | CSI Postgres password via `POSTGRES_PASSWORD_FILE`; migration-guard init container |
| `.github/workflows/*`, `bump-gitops-image-tag.sh` | GitHub App token minting for GitOps pin bumps |

There is no `wait-for-observability` Make target — waiting happens inside `helm-observability-upgrade` (rollout status) and in CI via `wait-argocd-apps.sh`.

### 9.3 Overlay differences

| Overlay | Phoenix DB | Storage class | Notable |
|---|---|---|---|
| `values.yaml` (default) | SQLite on PVC | default | 90 d Prometheus, 7 d Loki/Tempo |
| `values-aks.yaml` | PostgreSQL (created) | `managed-premium` | — |
| `values-eks.yaml` | PostgreSQL (created) | `fsxn-nas` | — |
| `values-gke.yaml` | PostgreSQL (created) | `standard-rwo` | — |
| `values-local.yaml` | SQLite | default | enables grafana-proxy + phoenix-proxy with dev secrets, `*.agentstudio.local` hosts, `tlsSkipVerify: true` |
| `values-resource-constrained.yaml` | SQLite | default | Prometheus 3 d / 2 GB, Loki & Tempo 72 h + smaller PVCs, trimmed CPU/memory |

The chart also documents `otel-collector.daemonset.enabled: false` as the escape hatch for clusters where host log access is unavailable or too expensive (local Kind), though no shipped overlay sets it today.

---

## 10. Dashboards and product UI

### 10.1 Provisioned Grafana dashboards

Three dashboards ship as ConfigMaps from `values.yaml`:

| UID | Title | Datasource | Query shape |
|---|---|---|---|
| `service-overview` | Service Overview | `prometheus-proxy` | RED: rate, error %, P50/P95/P99 from `http_server_request_*` |
| `app-logs` | App Logs | `loki` | `{service_name=~"$service", project_id=~"$project"}` |
| `app-traces` | App Traces | `tempo` | `({resource.service.name=~"$service"} && {.project_id=~"$project"})` |

All three carry `$project` and `$service` template variables. `service-overview` also has an `excluded_endpoint` regex defaulting to `.*(health|ready|metrics).*` so probes do not distort latency panels.

**Datasource layout** — a deliberate split:

- The chart's built-in **raw Prometheus** datasource is the Grafana default, so kube-prometheus-stack infra dashboards (which query cluster metrics that carry no `project_id`) still render.
- App dashboards pin **`prometheus-proxy`** by UID, so their queries stay project-scoped.
- Loki and Tempo point at `observability-proxy:9091` (Tempo via the `/tempo` path prefix, because Grafana's Loki client already prepends `/loki/api/v1`).

This is documented in the values file as a known trade-off: raw Prometheus is reachable as the Grafana default, so project scoping only applies where the proxy is pinned. Revisit when admin/viewer RBAC is formalised.

Cross-signal correlation is wired both ways: Loki `derivedFields` extracts `trace_id` from log JSON into a Tempo link, and the Tempo datasource has `tracesToLogs` + `tracesToMetrics` + `nodeGraph`.

### 10.2 AgentStudio UI

The product UI does **not** iframe Grafana or Phoenix (even though `allow_embedding: true` is set). It opens them in a new tab with a handoff token:

```
{grafanaUrl}/oauth2/handoff?token=<jwt>&redirect=/d/app-logs/app-logs?var-project={projectId}
{phoenixUrl}/oauth2/handoff?token=<jwt>&redirect=/redirects/projects/{projectId}
```

For in-app panels it queries Prometheus directly through the edge:

```
GET app.<endpoint>/prometheus/api/v1/query…
Authorization: Bearer <keycloak token>
        → observability-proxy :9091 (bearer lane) → Prometheus
```

`observability-catalog.ts` defines ~24 PromQL panels for agents, models, and knowledge bases — e.g. `agent-p95-latency`, `agent-run-outcomes` (`agent_run_total` by outcome), `agent-lifecycle-llm-cost` (`agent_cost_usd_total`), `agent-tool-calls`, `knowledge-base-retrieval-count`.

---

## 11. Known gaps and sharp edges

| # | Gap | Impact |
|---|---|---|
| 1 | **Raw Prometheus is the Grafana default datasource** | Project scoping applies only where `prometheus-proxy` is pinned; an ad-hoc Explore query hits unscoped Prometheus |
| 2 | **eval-worker has no OTel tracing and no log redaction** | Eval runs are invisible in Tempo/Phoenix; its `StructuredLogger` injects no `trace_id` |
| 3 | **`/.internal/projects` returns 404 after grafana-proxy restart** | Users must re-login through Grafana before observability-proxy can scope their queries |
| 4 | **Single-replica collector, Loki, Tempo, Phoenix** | Each is a single point of failure; local filesystem storage, `replication_factor: 1` |
| 5 | **`start_at: end` on the DaemonSet filelog receiver** | Logs written before a collector restart are lost — no checkpoint volume |
| 6 | **Phoenix multi-tenancy is proxy-only** | Anything that reaches `phoenix:6006` directly sees all projects; only NetworkPolicy prevents that |
| 7 | **`apigateway-service` does not set an explicit service name** | Falls back to the packaged default unless `OTEL_SERVICE_NAME` is set in Helm |
| 8 | **`alertmanager: enabled: false`** | Metrics exist (`guardrail_block_total`, `agent_cost_usd_total`) but there is no pageable alerting path yet |
| 9 | **Log `project_id` is regex-extracted from the body** | A service that renames the field or logs non-JSON silently loses project scoping on its logs |
| 10 | **Bifrost `project_id` depends on a header copy** | If `capturedRequestHeaders` drops `x-project-id`, all Bifrost traces become invisible to non-admin users |
| 11 | **Whole `monitoring` namespace runs at PSS `privileged`** | Needed only by the hostPath log DaemonSet, but exempts every pod in the namespace from Pod Security Admission |

---

## 12. Quick reference

### Ports

| Component | Port | Protocol |
|---|---|---|
| otel-collector | 4317 / 4318 / 8889 / 13133 | OTLP gRPC / OTLP HTTP / Prometheus / health |
| Phoenix | 6006 | OTLP HTTP ingest + UI |
| Tempo | 4317 / 3200 | OTLP gRPC ingest / query |
| Loki | 3100 (`/otlp`) | OTLP HTTP ingest + query |
| Prometheus | 9090 | query |
| grafana-proxy | 8080 | HTTP |
| phoenix-proxy | 8080 | HTTP |
| observability-proxy | 9091 | HTTP |
| eval-worker metrics | 9465 | Prometheus |

### Debugging a missing signal

```
Trace not in Phoenix?
  → is service.name in otel-collector.tracing.agentServiceNames,
    or does the span carry openinference.span.kind / gen_ai.system / llm.model_name?
  → is it a bifrost span? those go to Tempo by design.

Trace not in Tempo?
  → tail sampling: only errors, >500 ms, and 10 % of the rest survive.

Metric missing project_id label?
  → is X-Project-ID reaching the service? the middleware puts it on the span,
    and resource_to_telemetry_conversion promotes it to a Prometheus label.

Logs missing in Loki?
  → DaemonSet enabled? namespace in the infra drop list?
    filter/noise removes GET /metrics and GET /health.

User sees no data but admin does?
  → observability-proxy rewrote the query to their project set;
    check grafana-proxy /.internal/projects returns a non-empty list.
```

### Key files

| Concern | Path |
|---|---|
| Stack values | `deployments/helm/observability/values.yaml` |
| Collector pipelines | `charts/otel-collector/templates/configmap.yaml` |
| Node log tailer | `charts/otel-collector/templates/configmap-daemonset.yaml` |
| Loki config | `charts/loki/templates/configmap.yaml` |
| Tempo config | `charts/tempo/templates/configmap.yaml` |
| Phoenix migration guard | `charts/phoenix/files/scripts/migration-guard.py` |
| Backend NetworkPolicies | `templates/networkpolicy-{prometheus,loki,tempo,phoenix}-ingress.yaml` |
| Query rewriting | `src/nemo/observability/observability-proxy/internal/{prometheus,loki,tempo,rewrite}/` |
| OIDC + project lists | `src/nemo/observability/grafana-proxy/` |
| Phoenix tenancy | `src/nemo/observability/phoenix-proxy/` |
| Python OTel client | `src/common-py/observability/observability-client/` |
| MAF Phoenix stamping | `src/nemo/agent-service-maf/src/agent_service_maf/core/phoenix_tracing.py` |
| MAF business metrics | `src/nemo/agent-service-maf/src/agent_service_maf/observability/run_metrics.py` |
| Identity propagation | `src/nemo/agent-service-maf/src/agent_service_maf/core/identity.py`, `mcp/_identity_transport.py` |
| UI panel catalog | `src/nemo/agent-studio-ui/src/routes/pages/observability/observability-catalog.ts` |

### Related in-repo docs

- `docs/observability/OBSERVABILITY_PLAN.md` — plan to unify all services on Prometheus-format `/metrics`
- `docs/observability/phoenix-agent-observability-design.md` — Phoenix LLM tracing design
- `docs/observability/phoenix-runbook.md` — deploy/upgrade runbook
- `docs/observability/Observability-SSO-RBAC-Integration.md` — authoritative proxy SSO/RBAC design
- `docs/observability/worker-hpa-runbook.md` — prometheus-adapter HPA runbook
- `docs/observability/KIND_METRICS_SETUP.md` — local Kind setup
- `docs/design/observability-phoenix-mcp.md` — project-scoped Phoenix Observability MCP
