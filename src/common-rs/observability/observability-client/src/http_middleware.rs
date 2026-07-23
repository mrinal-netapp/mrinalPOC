//! Tower middleware for HTTP servers (axum / hyper / tonic).
//!
//! Provides four layers in dependency order:
//!
//! 1. [`RequestIdLayer`] — propagates `X-Request-Id` (generated as UUID v4 when
//!    missing), echoes it on the response, and stuffs it into request extensions.
//! 2. [`HttpTraceLayer`] — extracts W3C trace context from incoming headers
//!    and opens one SERVER span per request named `"{METHOD} {path}"`.
//! 3. [`LoggingLayer`] — emits a structured JSON access log when the request
//!    completes (with `trace_id` / `span_id` / `request_id` injected).
//! 4. [`inject_trace_headers`] — utility to inject the current W3C trace
//!    context + request-id into an outbound `HeaderMap` for proxying.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::{HeaderMap, HeaderName, HeaderValue, Request, Response};
use opentelemetry::propagation::Extractor;
use opentelemetry::trace::{FutureExt, SpanKind, Status, TraceContextExt, Tracer};
use opentelemetry::{global, Context, InstrumentationScope, KeyValue};
use serde_json::{Map, Value};
use tower::{Layer, Service};

use crate::logger_handler::{log_debug, log_info, TRACER_NAME_CLIENT_LIBRARY};
use crate::red_metrics::{
    ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_PROJECT_ID, ATTR_URL_PATH,
};

const REQUEST_ID_HEADER: &str = "x-request-id";

/// Request extension key holding the per-request ID.
#[derive(Debug, Clone)]
pub struct RequestId(pub String);

/// Inject current OTel context + X-Request-Id into an outbound `HeaderMap`.
pub fn inject_trace_headers(out_headers: &mut HeaderMap, in_headers: &HeaderMap) {
    let cx = Context::current();
    let mut injector = HeaderMapInjector(out_headers);
    global::get_text_map_propagator(|prop| prop.inject_context(&cx, &mut injector));
    if let Some(v) = in_headers.get(REQUEST_ID_HEADER) {
        out_headers.insert(REQUEST_ID_HEADER, v.clone());
    }
}

// ─── Layers ──────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Copy)]
pub struct RequestIdLayer;

impl<S> Layer<S> for RequestIdLayer {
    type Service = RequestIdService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        RequestIdService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct RequestIdService<S> {
    inner: S,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for RequestIdService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<ReqBody>) -> Self::Future {
        let id = req
            .headers()
            .get(REQUEST_ID_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        req.extensions_mut().insert(RequestId(id.clone()));
        let mut inner = self.inner.clone();
        Box::pin(async move {
            let mut resp = inner.call(req).await?;
            if let Ok(hv) = HeaderValue::from_str(&id) {
                if let Ok(hn) = HeaderName::try_from(REQUEST_ID_HEADER) {
                    resp.headers_mut().insert(hn, hv);
                }
            }
            Ok(resp)
        })
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct HttpTraceLayer;

impl<S> Layer<S> for HttpTraceLayer {
    type Service = HttpTraceService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        HttpTraceService { inner }
    }
}

#[derive(Debug, Clone)]
pub struct HttpTraceService<S> {
    inner: S,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for HttpTraceService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let method = req.method().as_str().to_string();
        let path = req.uri().path().to_string();
        let span_name = format!("{method} {path}");

        // Gateway-injected project scope (parity with Go/Python/Node runtimes).
        let project_id = req
            .headers()
            .get("x-project-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .filter(|s| !s.is_empty());

        // Extract trace context from inbound headers.
        let parent_cx = global::get_text_map_propagator(|prop| {
            prop.extract(&HeaderMapExtractor(req.headers()))
        });

        let scope = InstrumentationScope::builder(TRACER_NAME_CLIENT_LIBRARY.to_string()).build();
        let tracer = global::tracer_with_scope(scope);
        let mut builder = tracer.span_builder(span_name);
        builder.span_kind = Some(SpanKind::Server);
        let mut span_attrs = vec![
            KeyValue::new(ATTR_HTTP_REQUEST_METHOD, method),
            KeyValue::new(ATTR_URL_PATH, path),
        ];
        if let Some(pid) = project_id {
            span_attrs.push(KeyValue::new(ATTR_PROJECT_ID, pid));
        }
        builder.attributes = Some(span_attrs);
        let span = tracer.build_with_context(builder, &parent_cx);
        let cx = parent_cx.with_span(span);

        let mut inner = self.inner.clone();
        let attached_cx = cx.clone();
        Box::pin(async move {
            let result = inner.call(req).with_context(attached_cx.clone()).await;
            let span = attached_cx.span();
            if let Ok(resp) = &result {
                let status = resp.status().as_u16();
                span.set_attribute(KeyValue::new(ATTR_HTTP_RESPONSE_STATUS_CODE, status as i64));
                if status >= 500 {
                    span.set_status(Status::error(format!("HTTP {status}")));
                }
            }
            span.end();
            result
        })
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LoggingLayer {
    /// Demote `/health` and `/ready` to debug-level access logs.
    pub quiet_health_paths: bool,
}

impl LoggingLayer {
    /// Create a default LoggingLayer (with `quiet_health_paths = true`).
    pub fn new() -> Self {
        Self {
            quiet_health_paths: true,
        }
    }
}

impl<S> Layer<S> for LoggingLayer {
    type Service = LoggingService<S>;
    fn layer(&self, inner: S) -> Self::Service {
        LoggingService {
            inner,
            quiet_health_paths: self.quiet_health_paths,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoggingService<S> {
    inner: S,
    quiet_health_paths: bool,
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for LoggingService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>> + Clone + Send + 'static,
    S::Future: Send + 'static,
    S::Error: Send + 'static,
    ReqBody: Send + 'static,
    ResBody: Send + 'static,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let start = Instant::now();
        let method = req.method().as_str().to_string();
        let path = req.uri().path().to_string();
        let request_id = req
            .extensions()
            .get::<RequestId>()
            .map(|r| r.0.clone())
            .unwrap_or_default();
        let project_id = req
            .headers()
            .get("x-project-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .unwrap_or_default();
        let mut inner = self.inner.clone();
        let quiet = self.quiet_health_paths;
        Box::pin(async move {
            let result = inner.call(req).await;
            let duration = start.elapsed();
            let mut fields = Map::new();
            fields.insert("method".to_string(), Value::String(method));
            fields.insert("path".to_string(), Value::String(path.clone()));
            fields.insert(
                "duration".to_string(),
                Value::String(format!("{:?}", duration)),
            );
            if let Ok(resp) = &result {
                fields.insert("status".to_string(), Value::from(resp.status().as_u16()));
            }
            if !request_id.is_empty() {
                fields.insert("request_id".to_string(), Value::String(request_id));
            }
            if !project_id.is_empty() {
                fields.insert("project_id".to_string(), Value::String(project_id));
            }
            if quiet && matches!(path.as_str(), "/health" | "/ready") {
                log_debug("request", fields);
            } else {
                log_info("request", fields);
            }
            result
        })
    }
}

// ─── Header carriers ─────────────────────────────────────────────────────────

struct HeaderMapExtractor<'a>(&'a HeaderMap);

impl<'a> Extractor for HeaderMapExtractor<'a> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}

struct HeaderMapInjector<'a>(&'a mut HeaderMap);

impl<'a> opentelemetry::propagation::Injector for HeaderMapInjector<'a> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(val)) = (HeaderName::try_from(key), HeaderValue::from_str(&value)) {
            self.0.insert(name, val);
        }
    }
}
