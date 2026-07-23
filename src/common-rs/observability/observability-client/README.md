# agentstudio-observability-client-runtime

Rust parity client for the AgentStudio observability stack. Fourth language-parallel
client (Go, Python, TypeScript being the other three). Same env-var contract
(`AGENT_STUDIO_OBSERVABILITY_*`), same packaged `log_config.json`, same data
shape on the wire.

## What it does

- **Structured JSON logs** to `App_Logs/app.jsonl` with `trace_id` / `span_id`
  injected from the active OpenTelemetry context.
- **OpenTelemetry traces** (OTel Rust 0.32) exported over OTLP HTTP to the
  cluster-side OTel Collector, plus a local JSONL trace dump
  (`Trace_Logs/trace.jsonl`) with an `openllmetry` / `all` filter.
- **Prometheus metrics** served on a dedicated `/metrics` port plus optional
  OTLP push for high-churn series.
- **RED metrics** (`http.server.request.count` / `.error.count` / `.duration_ms`)
  auto-derived from SERVER spans.
- **Tower middleware** (axum / hyper / tonic compatible) for request-id, W3C
  trace-context extraction, and structured access logs.

## Quick start

```toml
[dependencies]
agentstudio-observability-client-runtime = { path = "../../common-rs/observability/observability-client" }
tokio = { version = "1", features = ["full"] }
```

```rust
use agentstudio_observability_client::{
    configure_logging_for_service, log_info, shutdown_observability,
};
use serde_json::Map;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    configure_logging_for_service("my-service")?;
    log_info("service_started", Map::new());

    // ... your service code ...

    shutdown_observability()?;
    Ok(())
}
```

axum HTTP middleware:

```rust
use axum::{routing::get, Router};
use agentstudio_observability_client::http::{
    HttpTraceLayer, LoggingLayer, RequestIdLayer,
};

let app = Router::new()
    .route("/things", get(|| async { "ok" }))
    .layer(LoggingLayer::new())
    .layer(HttpTraceLayer::default())
    .layer(RequestIdLayer::default());
```

## Configuration

All knobs are documented in `.specs/observability/01-config-and-env.spec.md`.
The Rust client honors the same `AGENT_STUDIO_OBSERVABILITY_*` env vars and
the same packaged `log_config.json` schema as the other clients.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_STUDIO_OBSERVABILITY_OTLP_TRACES_ENDPOINT` | `http://localhost:4318` | OTLP HTTP base URL (we append `/v1/traces`). |
| `AGENT_STUDIO_OBSERVABILITY_METRICS_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP base URL for metrics push. |
| `AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT` | `8000` | Dedicated `/metrics` port. `null` to disable. |
| `AGENT_STUDIO_OBSERVABILITY_METRICS_SERVICE_NAME` | `null` | Sets OTel `service.name` resource attribute. |
| `AGENT_STUDIO_OBSERVABILITY_MIN_LOG_LEVEL` | `info` | Floor for log emission. |
| `AGENT_STUDIO_OBSERVABILITY_TRACE_JSONL_FILTER` | `openllmetry` | `all` or `openllmetry`. |
| `AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH` | `App_Logs` | Dir or full path for `app.jsonl`. |
| `AGENT_STUDIO_OBSERVABILITY_TRACE_FILE_PATH` | `Trace_Logs` | Dir or full path for `trace.jsonl`. |

## OpenLLMetry note

Like the Go client, the Rust client **rejects `enable_openllmetry = true`** at
validation time — there's no Traceloop/OpenLLMetry Rust SDK. Services that
want LLM tracing should emit OTel spans with `gen_ai.*` / `traceloop.*`
semantic-convention attributes manually; the JSONL filter then routes those
spans into `Trace_Logs/trace.jsonl`.

## Crate features

- `default = ["http"]`
- `http` — enables the Tower middleware (axum / hyper / tonic).

## MSRV

Rust **1.81** (driven by `opentelemetry-prometheus = "0.32"`).

## Tests

```bash
cargo test
```

The smoke tests exercise the public surface without standing up real OTel
collectors. Tests that mutate global subscriber/sink state are serialized
via a static mutex, so they can run under the default multi-threaded runner.

## See also

- `.specs/observability/11-client-rust.spec.md` — full Rust client spec.
- `.specs/observability/00-overview.spec.md` — cross-client overview.
- `src/common-go/observability/` — Go reference implementation.
- `src/common-py/observability/` — Python reference implementation.
- `src/common/src/observability/` — TypeScript reference implementation.
