//! End-to-end smoke tests for `agentstudio-observability-client-runtime`.
//!
//! These exercise the public surface without standing up a real OTLP collector
//! or Prometheus scrape target.
//!
//! Tests that mutate global subscriber/sink state are serialized via a static
//! mutex so they can run with the default multi-threaded test runner.

use std::fs;
use std::sync::{Mutex, MutexGuard};

use once_cell::sync::Lazy;

static GLOBAL_TEST_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn lock_global<'a>() -> MutexGuard<'a, ()> {
    // Recover from a poisoned lock — a panicking test still releases state
    // on Drop, and we don't want one bad test to wedge the whole suite.
    GLOBAL_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

use agentstudio_observability_client::{
    apply_env_defaults, configure_observability_logging, log_info, normalize_level_name,
    normalize_otlp_http_metrics_endpoint, normalize_otlp_http_traces_endpoint,
    observability_env_overrides, observability_static_defaults, shutdown_observability,
    ObservabilityLoggingConfig,
};
use serde_json::{Map, Value};

/// Build a config that writes everything to a temp dir and does NOT export
/// anything off-host.
fn local_only_config(tmp: &tempfile::TempDir) -> ObservabilityLoggingConfig {
    let mut cfg = observability_static_defaults();
    cfg.log_file_path = tmp.path().join("app.jsonl").to_string_lossy().into_owned();
    cfg.trace_file_path = Some(
        tmp.path()
            .join("trace.jsonl")
            .to_string_lossy()
            .into_owned(),
    );
    cfg.otlp_traces_endpoint = None;
    cfg.metrics_otlp_endpoint = None;
    cfg.prometheus_metrics_port = None;
    cfg.metrics_service_name = Some("smoke-test-service".to_string());
    cfg.min_log_level = Some("debug".to_string());
    cfg
}

#[test]
fn normalize_otlp_endpoints() {
    assert_eq!(
        normalize_otlp_http_traces_endpoint("http://collector:4318"),
        "http://collector:4318/v1/traces"
    );
    assert_eq!(
        normalize_otlp_http_traces_endpoint("http://collector:4318/v1/traces"),
        "http://collector:4318/v1/traces"
    );
    assert_eq!(
        normalize_otlp_http_metrics_endpoint("https://otel/v1/metrics/"),
        "https://otel/v1/metrics"
    );
}

#[test]
fn level_normalization_aligned_with_other_clients() {
    assert_eq!(normalize_level_name("WARN"), "warning");
    assert_eq!(normalize_level_name("warn"), "warning");
    assert_eq!(normalize_level_name(" INFO "), "info");
    assert_eq!(normalize_level_name("fatal"), "critical");
}

#[test]
fn env_overrides_round_trip() {
    let _g = lock_global();
    std::env::set_var(
        "AGENT_STUDIO_OBSERVABILITY_METRICS_EXPORT_INTERVAL_MS",
        "12345",
    );
    let parsed = observability_env_overrides().expect("env parse");
    assert_eq!(
        parsed.get("metrics_export_interval_ms"),
        Some(&Value::from(12345u64))
    );
    std::env::remove_var("AGENT_STUDIO_OBSERVABILITY_METRICS_EXPORT_INTERVAL_MS");

    let mut cfg = observability_static_defaults();
    apply_env_defaults(&mut cfg).expect("apply env");
    // Original default restored.
    assert_eq!(cfg.metrics_export_interval_ms, 60_000);
}

#[test]
fn openllmetry_rejected_at_validation() {
    let mut cfg = observability_static_defaults();
    cfg.enable_openllmetry = true;
    let err = cfg.validate().expect_err("must reject");
    let msg = format!("{err}");
    assert!(
        msg.contains("enable_openllmetry is not supported"),
        "unexpected error: {msg}"
    );
}

#[test]
fn invalid_trace_filter_rejected() {
    let mut cfg = observability_static_defaults();
    cfg.trace_jsonl_filter = "bogus".to_string();
    assert!(cfg.validate().is_err());
}

#[test]
fn configure_and_emit_log_line() {
    let _g = lock_global();
    let tmp = tempfile::tempdir().expect("temp");
    let cfg = local_only_config(&tmp);
    let log_path = std::path::PathBuf::from(&cfg.log_file_path);
    configure_observability_logging(cfg).expect("configure");

    let mut fields = Map::new();
    fields.insert("user_id".to_string(), Value::String("alice".to_string()));
    log_info("login_succeeded", fields);

    // Tear down to flush.
    shutdown_observability().expect("shutdown");

    let body = fs::read_to_string(&log_path).expect("read log");
    // The OTel SDK may emit internal initialization lines before our first app log.
    // Search all lines for the one we emitted rather than assuming it is line 0.
    let parsed: Value = body
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v.get("event").and_then(|e| e.as_str()) == Some("login_succeeded"))
        .expect("login_succeeded log line not found");
    assert_eq!(parsed["level"], Value::String("info".to_string()));
    assert_eq!(parsed["record_type"], Value::String("app_log".to_string()));
    assert!(parsed.get("timestamp").and_then(|v| v.as_str()).is_some());
    assert_eq!(parsed["user_id"], Value::String("alice".to_string()));
}

#[test]
fn min_log_level_filter_drops_below_floor() {
    let _g = lock_global();
    let tmp = tempfile::tempdir().expect("temp");
    let mut cfg = local_only_config(&tmp);
    cfg.min_log_level = Some("warning".to_string());
    let log_path = std::path::PathBuf::from(&cfg.log_file_path);
    configure_observability_logging(cfg).expect("configure");

    log_info("should_be_dropped", Map::new());
    agentstudio_observability_client::log_error("kept", Map::new());
    shutdown_observability().expect("shutdown");

    let body = fs::read_to_string(&log_path).expect("read log");
    assert!(
        !body.contains("should_be_dropped"),
        "info line leaked: {body}"
    );
    assert!(body.contains("kept"));
}
