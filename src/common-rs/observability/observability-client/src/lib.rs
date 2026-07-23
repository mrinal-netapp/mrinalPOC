//! `agentstudio-observability-client-runtime` — Rust parity client for the
//! AgentStudio observability stack.
//!
//! This crate is the fourth language-parallel observability client (Go, Python,
//! TypeScript being the other three). It combines:
//!
//! - **Structured JSON logs** via [`tracing`] + a custom [`Layer`] that writes
//!   to a per-process JSONL file with `trace_id` / `span_id` automatically
//!   injected from the active OpenTelemetry context.
//! - **OpenTelemetry traces** (OTel Rust 0.32) over **OTLP HTTP** to the
//!   cluster-side OTel Collector, plus a local JSONL trace dump (configurable
//!   `all` / `openllmetry` filter — same semantics as the other clients).
//! - **Prometheus metrics** on a dedicated `/metrics` port served by a small
//!   `hyper` server, plus optional OTLP push for short-lived series.
//! - **RED metrics** (rate, errors, duration) auto-derived from SERVER spans
//!   via a custom [`SpanProcessor`].
//! - **Tower middleware** for axum / hyper / tonic services
//!   ([`http::HttpTraceLayer`], [`http::RequestIdLayer`], [`http::LoggingLayer`]).
//!
//! # Quick start
//!
//! Add to `Cargo.toml`:
//!
//! ```toml
//! [dependencies]
//! agentstudio-observability-client-runtime = { path = "../../common-rs/observability/observability-client" }
//! tokio = { version = "1", features = ["full"] }
//! ```
//!
//! In `main.rs`:
//!
//! ```no_run
//! use agentstudio_observability_client::{
//!     configure_logging_for_service, log_info, shutdown_observability,
//! };
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     configure_logging_for_service("my-service")?;
//!     log_info("service_started", serde_json::Map::new());
//!     // ... your service code ...
//!     shutdown_observability()?;
//!     Ok(())
//! }
//! ```
//!
//! See [`.specs/observability/11-client-rust.spec.md`](https://example.invalid)
//! for the full public surface.

pub mod config;
pub mod enums;
pub mod logger_handler;
pub mod logging_config;
pub mod observability_env;
pub mod otlp_endpoint_utils;
pub mod otlp_export_tolerance;
pub mod red_metrics;
pub mod trace_jsonl;

#[cfg(feature = "http")]
pub mod http_middleware;

// ─── Public re-exports — flat surface for service code ──────────────────────

pub use config::{
    ConfigError, ObservabilityLoggingConfig, APP_LOG_RECORD_TYPE, TRACE_SPAN_RECORD_TYPE,
};
pub use enums::{normalize_level_name, validate_min_log_level, LogLevel, LEVEL_RANK};
pub use logger_handler::{
    configure_observability_logging, configure_observability_minimal, get_logger, log_critical,
    log_debug, log_error, log_event, log_info, log_warn, otel_fields, shutdown_observability,
    with_otel_span, with_otel_span_async, Logger, MinimalConfig, ObservabilityError,
    TRACER_NAME_CLIENT_LIBRARY, TRACER_NAME_HANDLER,
};
pub use logging_config::{
    configure_logging_for_service, configure_logging_from_env, configure_logging_from_json_file,
    configure_logging_from_packaged_default, load_logging_config_dict, CONFIG_VERSION,
};
pub use observability_env::{
    apply_env_defaults, is_truthy, observability_env_overrides, observability_static_defaults,
    OBSERVABILITY_ENV_PREFIX,
};
pub use otlp_endpoint_utils::{
    normalize_otlp_http_metrics_endpoint, normalize_otlp_http_traces_endpoint,
};
pub use otlp_export_tolerance::apply_otlp_unreachable_export_silencing;
pub use red_metrics::{
    flush_meter_providers, get_business_meter, get_long_lived_meter, get_short_lived_meter,
    render_prometheus_metrics, MetricsError, ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_ROUTE,
    ATTR_URL_PATH,
};

#[cfg(feature = "http")]
pub mod http {
    //! HTTP middleware (Tower-compatible). Enabled with the `http` feature
    //! (on by default).
    pub use crate::http_middleware::{
        inject_trace_headers, HttpTraceLayer, HttpTraceService, LoggingLayer, LoggingService,
        RequestId, RequestIdLayer, RequestIdService,
    };
}
