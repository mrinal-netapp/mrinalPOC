//! HTTP route integration tests with real LanceDB + mock embedding gateway.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use common::{
    KbFixture, rust_query_embedding, seed_lancedb_table, spawn_embedding_mock_counting,
    write_metadata,
};
use kb_retrieval_service::config::Config;
use kb_retrieval_service::embedding::EmbeddingService;
use kb_retrieval_service::pool::ConnectionPool;
use kb_retrieval_service::project_gateway::ProjectGatewayResolver;
use kb_retrieval_service::routes::build_router;
use kb_retrieval_service::state::{AppRequestMetrics, AppState};

async fn app_for_fixture(fixture: &KbFixture, with_vk: bool) -> axum::Router {
    let config = Arc::new(Config {
        port: 5000,
        data_root: fixture.data_root.to_string_lossy().to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: Some("https://cdn.example.com".to_string()),
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: fixture.embedding_gateway_url.clone(),
        project_gateway_cache_ttl_secs: 300,
    });

    let gateway = if with_vk {
        Arc::new(ProjectGatewayResolver::with_fixed_auth_for_tests(
            &config,
            "test-vk-token",
        ))
    } else {
        Arc::new(ProjectGatewayResolver::disabled_for_tests(&config))
    };

    let state = AppState {
        config: config.clone(),
        pool: Arc::new(ConnectionPool::new(config)),
        embedding: Arc::new(EmbeddingService::new(fixture.embedding_gateway_url.clone())),
        project_gateway: gateway,
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };
    build_router(state)
}

async fn post_json(app: axum::Router, uri: &str, body: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.oneshot(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({}));
    (status, json)
}

#[tokio::test]
async fn single_kb_vector_search_returns_results() {
    let fixture = KbFixture::vector_kb().await;
    let app = app_for_fixture(&fixture, true).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/{}/search",
        fixture.project_id, fixture.kb_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "rust programming", "topK": 3, "searchMode": "vector"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["resultCount"].as_u64().unwrap_or(0) > 0);
    assert_eq!(body["results"][0]["id"], "chunk-0");
    assert!(
        body["results"][0]["downloadUrl"]
            .as_str()
            .unwrap_or("")
            .contains("cdn.example.com")
    );
    let processing_time_ms = body["processingTimeMs"]
        .as_f64()
        .expect("processingTimeMs must be present and numeric");
    assert!(processing_time_ms >= 0.0);
}

#[tokio::test]
async fn single_kb_search_without_vk_returns_503() {
    let fixture = KbFixture::vector_kb().await;
    let app = app_for_fixture(&fixture, false).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/{}/search",
        fixture.project_id, fixture.kb_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "rust", "topK": 3, "searchMode": "vector"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap_or("").contains("disabled"));
}

#[tokio::test]
async fn single_kb_fts_search_works_without_vk() {
    let fixture = KbFixture::hybrid_kb().await;
    let app = app_for_fixture(&fixture, false).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/{}/search",
        fixture.project_id, fixture.kb_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "Rust ownership", "topK": 2, "searchMode": "fts"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(body["resultCount"].as_u64().unwrap_or(0) > 0);
    assert_eq!(body["searchMode"], "fts");
}

#[tokio::test]
async fn single_kb_corrupt_metadata_returns_500() {
    let fixture = KbFixture::vector_kb().await;
    std::fs::write(fixture.kb_dir().join("metadata.json"), "not-json").unwrap();

    let app = app_for_fixture(&fixture, true).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/{}/search",
        fixture.project_id, fixture.kb_id
    );

    let (status, _) = post_json(app, &uri, r#"{"query": "rust", "topK": 3}"#).await;

    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn single_kb_missing_metadata_with_kb_dir_returns_503() {
    let fixture = KbFixture::vector_kb().await;
    std::fs::remove_file(fixture.kb_dir().join("metadata.json")).unwrap();

    let app = app_for_fixture(&fixture, true).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/{}/search",
        fixture.project_id, fixture.kb_id
    );

    let (status, body) = post_json(app, &uri, r#"{"query": "rust", "topK": 3}"#).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body["error"].as_str().unwrap_or("").contains("not visible"));
}

#[tokio::test]
async fn multi_kb_merge_search_aggregates_results() {
    let kb1 = KbFixture::vector_kb().await;
    let kb2_dir = kb1
        .data_root
        .join("projects")
        .join(&kb1.project_id)
        .join("knowledgebases")
        .join("kb2");
    let lance2 = kb2_dir.join("lancedb-run-test");
    seed_lancedb_table(&lance2, false).await;
    write_metadata(&kb2_dir, &lance2.to_string_lossy(), "semantic", false);

    let config = Arc::new(Config {
        port: 5000,
        data_root: kb1.data_root.to_string_lossy().to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: kb1.embedding_gateway_url.clone(),
        project_gateway_cache_ttl_secs: 300,
    });
    let state = AppState {
        config: config.clone(),
        pool: Arc::new(ConnectionPool::new(config.clone())),
        embedding: Arc::new(EmbeddingService::new(kb1.embedding_gateway_url.clone())),
        project_gateway: Arc::new(ProjectGatewayResolver::with_fixed_auth_for_tests(
            &config, "vk",
        )),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };
    let app = build_router(state);

    let uri = format!("/api/v1/projects/{}/knowledgebases/search", kb1.project_id);
    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "rust", "topK": 5, "knowledgeBaseIds": ["kb1", "kb2"], "aggregationStrategy": "merge"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["aggregationStrategy"], "merge");
    assert!(!body["results"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn multi_kb_per_kb_strategy_returns_grouped_results() {
    let fixture = KbFixture::vector_kb().await;
    let app = app_for_fixture(&fixture, true).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/search",
        fixture.project_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "rust", "topK": 3, "knowledgeBaseIds": ["kb1"], "aggregationStrategy": "per_kb"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["aggregationStrategy"], "per_kb");
    assert_eq!(body["results"][0]["knowledgeBaseId"], "kb1");
    assert!(!body["results"][0]["chunks"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn multi_kb_fts_skips_vk_requirement() {
    let fixture = KbFixture::hybrid_kb().await;
    let app = app_for_fixture(&fixture, false).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/search",
        fixture.project_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "Rust", "topK": 2, "knowledgeBaseIds": ["kb1"], "searchMode": "fts"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert!(!body["results"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn multi_kb_embedding_cache_calls_gateway_once() {
    let fixture = KbFixture::vector_kb().await;
    let (gateway_url, hits) = spawn_embedding_mock_counting(rust_query_embedding()).await;

    let kb2_dir = fixture
        .data_root
        .join("projects")
        .join(&fixture.project_id)
        .join("knowledgebases")
        .join("kb2");
    let lance2 = kb2_dir.join("lancedb-run-test");
    seed_lancedb_table(&lance2, false).await;
    write_metadata(&kb2_dir, &lance2.to_string_lossy(), "semantic", false);

    let config = Arc::new(Config {
        port: 5000,
        data_root: fixture.data_root.to_string_lossy().to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: gateway_url.clone(),
        project_gateway_cache_ttl_secs: 300,
    });
    let state = AppState {
        config: config.clone(),
        pool: Arc::new(ConnectionPool::new(config.clone())),
        embedding: Arc::new(EmbeddingService::new(gateway_url)),
        project_gateway: Arc::new(ProjectGatewayResolver::with_fixed_auth_for_tests(
            &config, "vk",
        )),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };
    let app = build_router(state);

    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/search",
        fixture.project_id
    );
    let (status, _) = post_json(
        app,
        &uri,
        r#"{"query": "rust", "topK": 3, "knowledgeBaseIds": ["kb1", "kb2"], "aggregationStrategy": "merge"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn multi_kb_skips_missing_kb_with_warning() {
    let fixture = KbFixture::vector_kb().await;
    let app = app_for_fixture(&fixture, true).await;
    let uri = format!(
        "/api/v1/projects/{}/knowledgebases/search",
        fixture.project_id
    );

    let (status, body) = post_json(
        app,
        &uri,
        r#"{"query": "rust", "topK": 3, "knowledgeBaseIds": ["kb1", "kb-missing"], "aggregationStrategy": "merge"}"#,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let warnings = body["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap_or("").contains("kb-missing"))
    );
}

#[tokio::test]
async fn pool_cache_hit_on_second_get_table() {
    use std::sync::atomic::Ordering;

    let fixture = KbFixture::vector_kb().await;
    let config = Arc::new(Config {
        data_root: fixture.data_root.to_string_lossy().to_string(),
        default_bucket_name: "test-bucket".to_string(),
        pool_max_size: 5,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: fixture.embedding_gateway_url.clone(),
        project_gateway_cache_ttl_secs: 300,
        s3_public_endpoint: None,
        port: 5000,
    });
    let pool = ConnectionPool::new(config);
    let lance = fixture.lance_path.to_string_lossy().to_string();

    pool.get_table("proj1", "kb1", &lance)
        .await
        .expect("first open");
    pool.get_table("proj1", "kb1", &lance)
        .await
        .expect("cache hit");
    assert_eq!(pool.stats.misses.load(Ordering::Relaxed), 1);
    assert_eq!(pool.stats.hits.load(Ordering::Relaxed), 1);
}
