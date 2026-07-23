//! Thin observability shim for kb-retrieval-service.
//!
//! All heavy lifting (logging, OTLP traces, Prometheus RED metrics, Tower
//! middleware) is delegated to `agentstudio-observability-client-runtime`.
//! This module keeps a stable internal API so the rest of the service does
//! not need to import the client crate directly.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use opentelemetry::metrics::Meter;

use crate::pool::ConnectionPool;

// ─── Init / teardown ────────────────────────────────────────────────────────

/// No-op: observability is now initialised by
/// `agentstudio_observability_client::configure_logging_for_service` in
/// `main.rs` before the server starts.
#[allow(dead_code)]
pub fn init_prometheus() {}

// ─── Metric helpers ─────────────────────────────────────────────────────────

/// Returns the long-lived OTel `Meter` for this service.
///
/// Backed by the client's long-lived (Prometheus) meter provider, whose reader
/// feeds the shared registry served by the dedicated `/metrics` port.
pub fn get_meter() -> Meter {
    agentstudio_observability_client::get_long_lived_meter(
        "kb-retrieval-service",
        Some(env!("CARGO_PKG_VERSION")),
    )
}

/// Registers connection-pool metrics ONCE at startup.
///
/// Each instrument's callback holds an `Arc` to the live pool and reads the
/// current value on every metric collection (i.e. every Prometheus scrape), so
/// the series stay fresh without an app-port `/metrics` handler or
/// re-registering instruments per scrape. The metrics surface on the dedicated
/// standalone Prometheus server (`AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT`).
///
/// `connection_pool_size` is a gauge (it goes up and down); the cumulative
/// hits/misses/evictions are observable counters. They are named WITHOUT the
/// `_total` suffix on purpose — the Prometheus exporter appends `_total` to
/// counters, yielding `connection_pool_{hits,misses,evictions}_total` with the
/// correct counter type metadata.
///
/// Call this once after observability is initialised and the pool exists.
pub fn register_pool_metrics(pool: Arc<ConnectionPool>) {
    let meter = get_meter();

    let p = pool.clone();
    meter
        .u64_observable_gauge("connection_pool_size")
        .with_description("Current number of open LanceDB connections in the pool")
        .with_callback(move |obs| obs.observe(p.size(), &[]))
        .build();

    let stats = pool.stats.clone();
    meter
        .u64_observable_counter("connection_pool_hits")
        .with_description("Cumulative pool cache hits")
        .with_callback(move |obs| obs.observe(stats.hits.load(Ordering::Relaxed), &[]))
        .build();

    let stats = pool.stats.clone();
    meter
        .u64_observable_counter("connection_pool_misses")
        .with_description("Cumulative pool cache misses")
        .with_callback(move |obs| obs.observe(stats.misses.load(Ordering::Relaxed), &[]))
        .build();

    let stats = pool.stats.clone();
    meter
        .u64_observable_counter("connection_pool_evictions")
        .with_description("Cumulative pool evictions")
        .with_callback(move |obs| obs.observe(stats.evictions.load(Ordering::Relaxed), &[]))
        .build();
}

/// No-op: HTTP RED metrics (request count, error count, duration) are now
/// recorded automatically by the client's `RedMetricsSpanProcessor` on every
/// SERVER span end.  Individual route handlers no longer need to call this.
#[allow(dead_code)]
pub fn record_http_request(_method: &str, _path: &str, _status: u16, _duration_secs: f64) {}

#[cfg(test)]
#[path = "observability_tests.rs"]
mod tests;
