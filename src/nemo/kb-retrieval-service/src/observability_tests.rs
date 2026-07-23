use super::*;
use axum::Router;
use axum::body::Body;
use axum::http::Request;
use axum::routing::get;
use tower::ServiceExt;

use agentstudio_observability_client::http::RequestIdLayer;

#[test]
fn test_register_pool_metrics_does_not_panic() {
    use std::sync::Arc;

    use crate::config::Config;
    use crate::pool::ConnectionPool;

    // Registering the pool gauges must not panic even before the meter
    // provider is up (callbacks just won't be collected until a reader exists).
    let config = Arc::new(Config {
        port: 5000,
        data_root: "/tmp".to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    });
    let pool = Arc::new(ConnectionPool::new(config));
    register_pool_metrics(pool);
}

#[test]
fn test_record_http_request_is_noop() {
    // Must not panic; RED metrics are handled by the client span processor.
    record_http_request("GET", "/health", 200, 0.01);
}

#[tokio::test]
async fn test_request_id_layer_adds_header() {
    // Verify that the client's RequestIdLayer (used in build_router) injects
    // X-Request-Id on responses that don't already have one.
    let app = Router::new()
        .route("/", get(|| async { "ok" }))
        .layer(RequestIdLayer);

    let req = Request::builder().uri("/").body(Body::empty()).unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert!(
        res.headers().get("x-request-id").is_some(),
        "RequestIdLayer must inject x-request-id"
    );
}

#[tokio::test]
async fn test_request_id_layer_preserves_existing_id() {
    let app = Router::new()
        .route("/", get(|| async { "ok" }))
        .layer(RequestIdLayer);

    let req = Request::builder()
        .uri("/")
        .header("x-request-id", "fixed-id-123")
        .body(Body::empty())
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(
        res.headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok()),
        Some("fixed-id-123"),
        "RequestIdLayer must preserve caller-supplied x-request-id"
    );
}
