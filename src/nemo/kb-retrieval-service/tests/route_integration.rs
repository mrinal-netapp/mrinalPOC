//! Integration tests for HTTP route handlers.
//!
//! These tests spin up the Axum router with a test AppState (no real LanceDB)
//! and verify that health/ready/metrics endpoints behave correctly.
//!
//! Note: the service no longer talks to S3 directly — KB data is read from a
//! shared PVC mount — so this test file does not construct an `aws_sdk_s3`
//! client. The previous helper has been removed.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

use kb_retrieval_service::config::Config;
use kb_retrieval_service::embedding::EmbeddingService;
use kb_retrieval_service::pool::ConnectionPool;
use kb_retrieval_service::project_gateway::ProjectGatewayResolver;
use kb_retrieval_service::routes::build_router;
use kb_retrieval_service::state::{AppRequestMetrics, AppState};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

fn test_config() -> Config {
    Config {
        port: 5000,
        data_root: "/mnt/pvcs/default-nemo".to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    }
}

/// Build a test AppState with embedding unavailable.
async fn test_state() -> AppState {
    let config = Arc::new(test_config());
    let pool = Arc::new(ConnectionPool::new(config.clone()));
    // Empty gateway URL → embedding service is not ready; routes that try
    // to embed will 503/skip, which is exactly what route-integration tests
    // want (they probe path resolution, not the gateway call itself).
    let embedding = Arc::new(EmbeddingService::new(String::new()));

    AppState {
        config: config.clone(),
        pool,
        embedding,
        project_gateway: Arc::new(ProjectGatewayResolver::disabled_for_tests(&config)),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    }
}

/// Send a request and parse the JSON body. Use for endpoints that return JSON.
async fn send_request(
    app: axum::Router,
    request: Request<Body>,
) -> (StatusCode, serde_json::Value) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    (status, json)
}

// ---------------------------------------------------------------------------
// Health endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_health_endpoint_returns_200() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "healthy");
    assert_eq!(body["service"], "kb-retrieval-service");
    assert!(body.get("timestamp").is_some());
}

// ---------------------------------------------------------------------------
// Readiness endpoint tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_ready_endpoint_ready_when_embedding_gateway_and_data_mount_available() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let mut cfg = test_config();
    cfg.data_root = tmp.path().to_string_lossy().to_string();
    let config = Arc::new(cfg);
    let pool = Arc::new(ConnectionPool::new(config.clone()));
    let embedding = Arc::new(EmbeddingService::new(
        "http://bifrost-proxy:8080".to_string(),
    ));
    let state = AppState {
        config: config.clone(),
        pool,
        embedding,
        project_gateway: Arc::new(ProjectGatewayResolver::disabled_for_tests(&config)),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };
    let app = build_router(state);

    let req = Request::builder()
        .uri("/ready")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ready");
    assert_eq!(body["embeddingModel"], "loaded");
    assert_eq!(body["dataMount"], "available");
}

#[tokio::test]
async fn test_ready_endpoint_not_ready_without_model() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .uri("/ready")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    // Without model files, embedding is not ready → 503
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "not_ready");
    assert_eq!(body["embeddingModel"], "not_loaded");
    assert_eq!(body["service"], "kb-retrieval-service");
}

// NOTE: Prometheus metrics are no longer served on the application port.
// The observability client exposes them on a dedicated standalone server
// (AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT), so there is no
// app-router `/metrics` endpoint to integration-test here. The pool-metric
// registration path is smoke-tested (does-not-panic) in `observability_tests.rs`;
// end-to-end scrape output is validated at deploy time, not in unit tests.

// ---------------------------------------------------------------------------
// Search validation tests (no real S3/LanceDB needed)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_search_empty_query_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": ""}"#))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("Query is required")
    );
}

#[tokio::test]
async fn test_search_top_k_too_high_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": "test", "topK": 200}"#))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("topK must be between 1 and 100")
    );
}

#[tokio::test]
async fn test_search_top_k_zero_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": "test", "topK": 0}"#))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("topK must be between 1 and 100")
    );
}

#[tokio::test]
async fn test_search_missing_body_returns_422() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    // Missing required "query" field → axum returns 422
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}

// ---------------------------------------------------------------------------
// Multi-search validation tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_multi_search_empty_query_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": "", "knowledgeBaseIds": ["kb1"]}"#))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("Query is required")
    );
}

#[tokio::test]
async fn test_multi_search_empty_kb_ids_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": "test", "knowledgeBaseIds": []}"#))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("knowledgeBaseIds"));
}

#[tokio::test]
async fn test_multi_search_too_many_kbs_returns_400() {
    let state = test_state().await;
    let app = build_router(state);

    let kb_ids: Vec<String> = (0..11).map(|i| format!("kb{}", i)).collect();
    let body_str = serde_json::json!({
        "query": "test",
        "knowledgeBaseIds": kb_ids
    })
    .to_string();

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/search")
        .header("content-type", "application/json")
        .body(Body::from(body_str))
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("Maximum 10 knowledge bases")
    );
}

// ---------------------------------------------------------------------------
// Nonexistent route tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_unknown_route_returns_404() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .uri("/nonexistent")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_wrong_method_returns_405() {
    let state = test_state().await;
    let app = build_router(state);

    // GET on a POST-only route
    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .body(Body::empty())
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

// ---------------------------------------------------------------------------
// Health endpoint idempotency
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_metadata_kb_not_found_returns_404() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/projects/proj1/knowledgebases/kbnotfound/metadata")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].as_str().unwrap().contains("not found"));
}

#[tokio::test]
async fn test_metadata_returns_fields_from_metadata_json() {
    let dir = tempfile::tempdir().unwrap();
    let kb_dir = dir.path().join("projects/proj1/knowledgebases/kb1");
    std::fs::create_dir_all(&kb_dir).unwrap();
    std::fs::write(
        kb_dir.join("metadata.json"),
        r#"{
            "lanceTablePath": "/mnt/data/lancedb-run-xyz",
            "indexingMode": "hybrid",
            "chunkCount": 100,
            "documentCount": 10,
            "storageMB": 5.5,
            "lastProcessedAt": "2026-05-27T00:00:00Z"
        }"#,
    )
    .unwrap();

    let config = Arc::new({
        let mut c = test_config();
        c.data_root = dir.path().to_string_lossy().to_string();
        c
    });
    let state = AppState {
        config: config.clone(),
        pool: Arc::new(ConnectionPool::new(config.clone())),
        embedding: Arc::new(EmbeddingService::new(String::new())),
        project_gateway: Arc::new(ProjectGatewayResolver::disabled_for_tests(&config)),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };

    let app = build_router(state);
    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/metadata")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["chunkCount"], 100);
    assert_eq!(body["documentCount"], 10);
    assert_eq!(body["storageMb"], 5.5);
    assert_eq!(body["indexingMode"], "hybrid");
    assert!(
        body["lancedbPath"]
            .as_str()
            .unwrap()
            .contains("lancedb-run-xyz")
    );
}

#[tokio::test]
async fn test_search_top_k_one_is_valid() {
    let state = test_state().await;
    let app = build_router(state);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/search")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"query": "test", "topK": 1}"#))
        .unwrap();

    let response = app.oneshot(req).await.unwrap();
    // Not 400 validation error — may be 404/503 without real KB data
    assert_ne!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_metadata_returns_200_when_kb_dir_exists_without_metadata_file() {
    let dir = tempfile::tempdir().unwrap();
    let kb_dir = dir.path().join("projects/proj1/knowledgebases/kb1");
    std::fs::create_dir_all(&kb_dir).unwrap();

    let config = Arc::new({
        let mut c = test_config();
        c.data_root = dir.path().to_string_lossy().to_string();
        c
    });
    let state = AppState {
        config: config.clone(),
        pool: Arc::new(ConnectionPool::new(config.clone())),
        embedding: Arc::new(EmbeddingService::new(String::new())),
        project_gateway: Arc::new(ProjectGatewayResolver::disabled_for_tests(&config)),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };

    let app = build_router(state);

    let req = Request::builder()
        .method("GET")
        .uri("/api/v1/projects/proj1/knowledgebases/kb1/metadata")
        .body(Body::empty())
        .unwrap();

    let (status, body) = send_request(app, req).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["knowledgeBaseId"], "kb1");
    assert_eq!(body["projectId"], "proj1");
    assert!(body["lancedbPath"].as_str().unwrap().contains("lancedb"));
}

#[tokio::test]
async fn test_health_endpoint_multiple_calls() {
    let state = test_state().await;

    // Call health 3 times to verify idempotency
    for _ in 0..3 {
        let app = build_router(state.clone());
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();

        let (status, body) = send_request(app, req).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "healthy");
    }
}
