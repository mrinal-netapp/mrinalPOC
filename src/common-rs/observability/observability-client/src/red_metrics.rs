//! RED span processor + meter accessors + Prometheus / OTLP meter provider
//! wiring. Mirrors the Go client's `otel_red_and_business_metrics.go`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::OnceCell;
use opentelemetry::metrics::{Counter, Histogram, Meter, MeterProvider as _};
use opentelemetry::trace::{SpanKind, Status};
use opentelemetry::{global, InstrumentationScope, KeyValue};
use opentelemetry_otlp::{MetricExporter, Protocol, WithExportConfig};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::metrics::{PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{SpanData, SpanProcessor};
use opentelemetry_sdk::Resource;
use parking_lot::RwLock;
use prometheus::Registry;
use thiserror::Error;
#[cfg(feature = "http")]
use tokio::sync::oneshot;

use crate::config::ObservabilityLoggingConfig;
use crate::otlp_endpoint_utils::normalize_otlp_http_metrics_endpoint;

/// HTTP semantic attribute keys.
pub const ATTR_HTTP_REQUEST_METHOD: &str = "http.request.method";
pub const ATTR_URL_PATH: &str = "url.path";
pub const ATTR_HTTP_ROUTE: &str = "http.route";
pub const ATTR_HTTP_RESPONSE_STATUS_CODE: &str = "http.response.status_code";
/// Gateway-injected project scope label (parity with Go/Python/Node runtimes).
pub const ATTR_PROJECT_ID: &str = "project_id";

pub(crate) const METER_NAME_RED: &str = "agent_studio.observability.red";
pub(crate) const METER_VERSION_RED: &str = "1.0.0";

#[derive(Debug, Error)]
pub enum MetricsError {
    #[error("short-lived OTLP metrics are not configured: set metrics_otlp_endpoint while using prometheus_metrics_port, or use OTLP-only mode")]
    NoShortLived,
    #[error("OTLP metric exporter build failed: {0}")]
    OtlpExporterBuild(String),
    #[error("Prometheus exporter build failed: {0}")]
    PrometheusBuild(String),
}

#[derive(Default)]
pub(crate) struct MeterState {
    /// Backed by the Prometheus reader (long-lived series).
    pub(crate) long_lived: Option<SdkMeterProvider>,
    /// Backed by the OTLP PeriodicReader (short-lived high-churn series).
    pub(crate) short_lived: Option<SdkMeterProvider>,
    /// Shared Prometheus registry (for /metrics scrape).
    pub(crate) registry: Option<Arc<Registry>>,
    /// Shutdown signal for the Prometheus HTTP server task.
    #[cfg(feature = "http")]
    pub(crate) prom_shutdown: Option<oneshot::Sender<()>>,
}

pub(crate) static METER_STATE: OnceCell<RwLock<MeterState>> = OnceCell::new();

fn meter_state() -> &'static RwLock<MeterState> {
    METER_STATE.get_or_init(|| RwLock::new(MeterState::default()))
}

fn loopback(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

pub(crate) fn effective_prometheus_bind(host: &str) -> String {
    let stripped = host.trim();
    if stripped.is_empty() {
        return "0.0.0.0".to_string();
    }
    if loopback(stripped) {
        eprintln!(
            "prometheus_metrics_host={stripped:?} is loopback; using 0.0.0.0 for remote scrape access"
        );
        return "0.0.0.0".to_string();
    }
    stripped.to_string()
}

fn build_scope(name: &str, version: Option<&str>) -> InstrumentationScope {
    let mut b = InstrumentationScope::builder(name.to_string());
    if let Some(v) = version {
        b = b.with_version(v.to_string());
    }
    b.build()
}

/// Long-lived meter (Prometheus when configured, else falls through to global).
pub fn get_long_lived_meter(name: &str, version: Option<&str>) -> Meter {
    let scope = build_scope(name, Some(version.unwrap_or(METER_VERSION_RED)));
    let state = meter_state().read();
    if let Some(mp) = state.long_lived.as_ref() {
        return mp.meter_with_scope(scope);
    }
    if let Some(mp) = state.short_lived.as_ref() {
        return mp.meter_with_scope(scope);
    }
    global::meter_with_scope(scope)
}

/// OTLP-push meter for high-churn series. Errors if no short-lived provider was set up.
pub fn get_short_lived_meter(name: &str, version: Option<&str>) -> Result<Meter, MetricsError> {
    let scope = build_scope(name, Some(version.unwrap_or(METER_VERSION_RED)));
    let state = meter_state().read();
    if let Some(mp) = state.short_lived.as_ref() {
        return Ok(mp.meter_with_scope(scope));
    }
    if state.long_lived.is_some() {
        return Err(MetricsError::NoShortLived);
    }
    Ok(global::meter_with_scope(scope))
}

/// Convenience alias for `get_long_lived_meter`.
pub fn get_business_meter(name: &str, version: Option<&str>) -> Meter {
    get_long_lived_meter(name, version)
}

/// Force a flush on configured meter providers.
pub fn flush_meter_providers() -> OTelSdkResult {
    let state = meter_state().read();
    if let Some(mp) = state.long_lived.as_ref() {
        let _ = mp.force_flush();
    }
    if let Some(mp) = state.short_lived.as_ref() {
        let _ = mp.force_flush();
    }
    Ok(())
}

pub(crate) fn shutdown_meter_providers() {
    if let Some(state) = METER_STATE.get() {
        let mut state = state.write();
        #[cfg(feature = "http")]
        if let Some(tx) = state.prom_shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mp) = state.long_lived.take() {
            let _ = mp.shutdown();
        }
        if let Some(mp) = state.short_lived.take() {
            let _ = mp.shutdown();
        }
        state.registry = None;
    }
}

pub(crate) fn configure_meter_providers(
    cfg: &ObservabilityLoggingConfig,
    resource: Resource,
) -> Result<Option<Arc<Registry>>, MetricsError> {
    shutdown_meter_providers();
    let mut state = meter_state().write();
    let mut prom_registry: Option<Arc<Registry>> = None;

    if let Some(port) = cfg.prometheus_metrics_port {
        if port > 0 {
            let registry = Arc::new(Registry::new());
            let exporter = opentelemetry_prometheus::exporter()
                .with_registry((*registry).clone())
                .build()
                .map_err(|e| MetricsError::PrometheusBuild(e.to_string()))?;
            let mp = SdkMeterProvider::builder()
                .with_resource(resource.clone())
                .with_reader(exporter)
                .build();
            global::set_meter_provider(mp.clone());
            state.long_lived = Some(mp);
            state.registry = Some(registry.clone());
            prom_registry = Some(registry.clone());

            #[cfg(feature = "http")]
            {
                let bind_host = effective_prometheus_bind(&cfg.prometheus_metrics_host);
                if let Ok(addr) = format!("{bind_host}:{port}").parse::<SocketAddr>() {
                    let (tx, rx) = oneshot::channel::<()>();
                    spawn_prometheus_server(addr, registry, rx);
                    state.prom_shutdown = Some(tx);
                } else {
                    eprintln!(
                        "prometheus_metrics_host {:?}:{port} did not parse as a SocketAddr",
                        bind_host
                    );
                }
            }
        }
    }

    let metrics_endpoint = resolve_metrics_endpoint(cfg.metrics_otlp_endpoint.as_deref());
    if let Some(endpoint) = metrics_endpoint {
        let normalized = normalize_otlp_http_metrics_endpoint(&endpoint);
        let exporter = MetricExporter::builder()
            .with_http()
            .with_endpoint(normalized)
            .with_protocol(Protocol::HttpBinary)
            .build()
            .map_err(|e| MetricsError::OtlpExporterBuild(e.to_string()))?;
        let reader = PeriodicReader::builder(exporter)
            .with_interval(Duration::from_millis(cfg.metrics_export_interval_ms))
            .build();
        let mp = SdkMeterProvider::builder()
            .with_resource(resource)
            .with_reader(reader)
            .build();
        if state.long_lived.is_none() {
            global::set_meter_provider(mp.clone());
        }
        state.short_lived = Some(mp);
    }

    Ok(prom_registry)
}

fn resolve_metrics_endpoint(cfg_endpoint: Option<&str>) -> Option<String> {
    if let Some(e) = cfg_endpoint {
        let t = e.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Ok(v) = std::env::var("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
        .ok()
        .filter(|v| !v.is_empty())
}

// ─── RED instruments ──────────────────────────────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct RedInstruments {
    request: Option<Counter<u64>>,
    errors: Option<Counter<u64>>,
    duration_ms: Option<Histogram<f64>>,
}

static RED: OnceCell<RwLock<RedInstruments>> = OnceCell::new();

fn red() -> &'static RwLock<RedInstruments> {
    RED.get_or_init(|| RwLock::new(RedInstruments::default()))
}

fn ensure_red_instruments() {
    {
        let r = red().read();
        if r.request.is_some() {
            return;
        }
    }
    let m = get_long_lived_meter(METER_NAME_RED, Some(METER_VERSION_RED));
    let request = m
        .u64_counter("http.server.request.count")
        .with_description("Total HTTP server requests (RED: rate)")
        .with_unit("1")
        .build();
    let errors = m
        .u64_counter("http.server.request.error.count")
        .with_description("HTTP server requests that ended with ERROR status (RED: errors)")
        .with_unit("1")
        .build();
    let duration_ms = m
        .f64_histogram("http.server.request.duration_ms")
        .with_description("HTTP server request duration in milliseconds (RED: duration)")
        .with_unit("1")
        .build();
    let mut w = red().write();
    *w = RedInstruments {
        request: Some(request),
        errors: Some(errors),
        duration_ms: Some(duration_ms),
    };
}

/// SpanProcessor that increments the three RED instruments on SERVER span end.
#[derive(Debug, Default)]
pub(crate) struct RedMetricsSpanProcessor;

impl SpanProcessor for RedMetricsSpanProcessor {
    fn on_start(&self, _span: &mut opentelemetry_sdk::trace::Span, _cx: &opentelemetry::Context) {}

    fn on_end(&self, span: SpanData) {
        if !matches!(span.span_kind, SpanKind::Server) {
            return;
        }
        ensure_red_instruments();
        let r = red().read();
        let Some(request) = r.request.as_ref() else {
            return;
        };
        let attrs = metric_attrs_from_span(&span);
        request.add(1, &attrs);
        if matches!(span.status, Status::Error { .. }) {
            if let Some(c) = r.errors.as_ref() {
                c.add(1, &attrs);
            }
        }
        if let Some(h) = r.duration_ms.as_ref() {
            if let (Ok(start), Ok(end)) = (
                span.start_time.duration_since(std::time::UNIX_EPOCH),
                span.end_time.duration_since(std::time::UNIX_EPOCH),
            ) {
                let ms = (end.as_micros().saturating_sub(start.as_micros())) as f64 / 1000.0;
                h.record(ms, &attrs);
            }
        }
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }

    fn set_resource(&mut self, _resource: &Resource) {}
}

fn metric_attrs_from_span(span: &SpanData) -> Vec<KeyValue> {
    let mut method = String::new();
    let mut path = String::new();
    let mut status_code = String::new();
    let mut project_id = String::new();
    for kv in span.attributes.iter() {
        let key = kv.key.as_str();
        if key == ATTR_HTTP_REQUEST_METHOD {
            method = kv.value.as_str().to_string();
        } else if (key == ATTR_URL_PATH || key == ATTR_HTTP_ROUTE) && path.is_empty() {
            path = kv.value.as_str().to_string();
        } else if key == ATTR_HTTP_RESPONSE_STATUS_CODE {
            status_code = kv.value.as_str().to_string();
        } else if key == ATTR_PROJECT_ID {
            project_id = kv.value.as_str().to_string();
        }
    }
    if method.is_empty() || path.is_empty() {
        let parts: Vec<&str> = span.name.splitn(2, ' ').collect();
        if parts.len() == 2 {
            if method.is_empty() {
                method = parts[0].to_string();
            }
            if path.is_empty() {
                path = parts[1].to_string();
            }
        } else if !parts.is_empty() && path.is_empty() {
            path = parts[0].to_string();
        }
    }
    if method.is_empty() {
        method = "GET".to_string();
    }
    if path.is_empty() {
        path = "/".to_string();
    }
    let mut attrs = vec![
        KeyValue::new(ATTR_HTTP_REQUEST_METHOD, method),
        KeyValue::new(ATTR_URL_PATH, path),
    ];
    if !status_code.is_empty() {
        attrs.push(KeyValue::new(ATTR_HTTP_RESPONSE_STATUS_CODE, status_code));
    }
    // Only emit the label when present, so non-project traffic doesn't create
    // an empty-valued series (matches the Go/Python guard).
    if !project_id.is_empty() {
        attrs.push(KeyValue::new(ATTR_PROJECT_ID, project_id));
    }
    attrs
}

// ─── Prometheus HTTP server (feature = "http") ──────────────────────────────

#[cfg(feature = "http")]
fn spawn_prometheus_server(
    addr: SocketAddr,
    registry: Arc<Registry>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let server = async move {
        use bytes::Bytes;
        use http::{Response, StatusCode};
        use http_body_util::Full;
        use hyper::service::service_fn;
        use hyper_util::rt::TokioIo;
        use prometheus::{Encoder, TextEncoder};
        use tokio::net::TcpListener;

        let listener = match TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("prometheus /metrics server bind {addr} failed: {e}");
                return;
            }
        };
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                accept = listener.accept() => {
                    let (stream, _peer) = match accept {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let reg = registry.clone();
                    tokio::spawn(async move {
                        let io = TokioIo::new(stream);
                        let svc = service_fn(move |req: http::Request<hyper::body::Incoming>| {
                            let reg = reg.clone();
                            async move {
                                if req.uri().path() != "/metrics" {
                                    let resp = Response::builder()
                                        .status(StatusCode::NOT_FOUND)
                                        .body(Full::new(Bytes::new()))
                                        .unwrap();
                                    return Ok::<_, std::convert::Infallible>(resp);
                                }
                                let encoder = TextEncoder::new();
                                let metric_families = reg.gather();
                                let mut buf = Vec::with_capacity(4096);
                                let _ = encoder.encode(&metric_families, &mut buf);
                                let resp = Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", encoder.format_type())
                                    .body(Full::new(Bytes::from(buf)))
                                    .unwrap();
                                Ok::<_, std::convert::Infallible>(resp)
                            }
                        });
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(io, svc)
                            .await;
                    });
                }
            }
        }
    };

    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(server);
        }
        Err(_) => {
            std::thread::Builder::new()
                .name("agentstudio-observability-prom".into())
                .spawn(move || {
                    match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt.block_on(server),
                        Err(e) => eprintln!("prometheus /metrics rt build failed: {e}"),
                    }
                })
                .expect("spawn prom server thread");
        }
    }
}

/// Renders the current Prometheus metrics in text exposition format.
///
/// Services that expose their own `/metrics` HTTP endpoint can call this
/// instead of (or in addition to) the built-in standalone Prometheus server.
/// Returns an empty string if the meter providers have not yet been configured.
pub fn render_prometheus_metrics() -> String {
    let state = meter_state().read();
    let Some(registry) = state.registry.as_ref() else {
        return String::new();
    };
    use prometheus::{Encoder, TextEncoder};
    let encoder = TextEncoder::new();
    let mut buf = Vec::with_capacity(4096);
    let _ = encoder.encode(&registry.gather(), &mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}
