use super::*;
use crate::errors::AppError;
use crate::models::SearchResult;
use crate::project_gateway::{GatewayLookup, test_project_gateway_auth};
use axum::http::StatusCode;
use axum::response::IntoResponse;

fn make_result(id: &str, score: f64) -> SearchResult {
    SearchResult {
        id: id.to_string(),
        document_id: "doc".to_string(),
        source: "src".to_string(),
        text: "text".to_string(),
        chunk_index: 0,
        score,
        metadata: serde_json::Value::Null,
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    }
}

// -----------------------------------------------------------------------
// merge_multi_kb_results
// -----------------------------------------------------------------------

#[test]
fn test_merge_multi_kb_sorts_by_score_descending() {
    let input = vec![
        (
            "kb_a".to_string(),
            "vector".to_string(),
            vec![make_result("a1", 0.5), make_result("a2", 0.9)],
        ),
        (
            "kb_b".to_string(),
            "vector".to_string(),
            vec![make_result("b1", 0.95)],
        ),
    ];
    let merged = merge_multi_kb_results(input, 10);
    assert_eq!(merged.len(), 3);
    assert_eq!(merged[0].id, "b1");
    assert_eq!(merged[0].knowledge_base_id.as_deref(), Some("kb_b"));
    assert_eq!(merged[1].id, "a2");
    assert_eq!(merged[2].id, "a1");
}

#[test]
fn test_merge_multi_kb_respects_top_k() {
    let input = vec![(
        "kb1".to_string(),
        "vector".to_string(),
        vec![
            make_result("c1", 0.9),
            make_result("c2", 0.8),
            make_result("c3", 0.7),
        ],
    )];
    let merged = merge_multi_kb_results(input, 2);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "c1");
    assert_eq!(merged[1].id, "c2");
}

#[test]
fn test_merge_multi_kb_empty_input() {
    let merged = merge_multi_kb_results(vec![], 10);
    assert!(merged.is_empty());
}

#[test]
fn test_merge_multi_kb_tags_kb_id_on_every_chunk() {
    let input = vec![(
        "kb_xyz".to_string(),
        "hybrid".to_string(),
        vec![make_result("c1", 0.5)],
    )];
    let merged = merge_multi_kb_results(input, 10);
    assert_eq!(merged[0].knowledge_base_id.as_deref(), Some("kb_xyz"));
    assert_eq!(merged[0].knowledge_base_name.as_deref(), Some("kb_xyz"));
}

// -----------------------------------------------------------------------
// classify_search_error
// -----------------------------------------------------------------------

fn status_of(err: AppError) -> StatusCode {
    err.into_response().status()
}

#[test]
fn test_classify_not_found_errors() {
    for msg in [
        "table not found",
        "does not exist",
        "no such file or directory",
    ] {
        let err = classify_search_error("p1", "kb1", anyhow::anyhow!(msg));
        assert_eq!(status_of(err), StatusCode::NOT_FOUND);
    }
}

#[test]
fn test_classify_corrupted_errors() {
    for msg in ["data corrupted", "failed to open table"] {
        let err = classify_search_error("p1", "kb1", anyhow::anyhow!(msg));
        assert_eq!(status_of(err), StatusCode::INTERNAL_SERVER_ERROR);
    }
}

#[test]
fn test_classify_timeout_errors() {
    for msg in ["search timed out", "connection timeout"] {
        let err = classify_search_error("p1", "kb1", anyhow::anyhow!(msg));
        match &err {
            AppError::Internal(body) => assert!(body.contains("timed out")),
            _ => panic!("expected Internal variant"),
        }
        assert_eq!(status_of(err), StatusCode::INTERNAL_SERVER_ERROR);
    }
}

#[test]
fn test_classify_generic_error() {
    let err = classify_search_error("p1", "kb1", anyhow::anyhow!("unexpected failure"));
    assert_eq!(status_of(err), StatusCode::INTERNAL_SERVER_ERROR);
}

// -----------------------------------------------------------------------
// summarize_error
// -----------------------------------------------------------------------

#[test]
fn test_summarize_error_first_line_only() {
    let err = anyhow::anyhow!("line one\nline two\nline three");
    assert_eq!(summarize_error(&err), "line one");
}

#[test]
fn test_summarize_error_truncates_long_message() {
    let long = "x".repeat(250);
    let err = anyhow::anyhow!(long);
    let summary = summarize_error(&err);
    assert!(summary.ends_with("..."));
    assert!(summary.len() <= 203);
}

#[test]
fn test_summarize_error_short_message_unchanged() {
    let err = anyhow::anyhow!("short error");
    assert_eq!(summarize_error(&err), "short error");
}

// -----------------------------------------------------------------------
// require_vk_token
// -----------------------------------------------------------------------

fn ready_lookup(token: &str) -> GatewayLookup {
    GatewayLookup::Ready(test_project_gateway_auth("p1", token))
}

fn vk_status(err: AppError) -> StatusCode {
    err.into_response().status()
}

#[test]
fn test_require_vk_token_returns_bearer_when_ready() {
    let token = require_vk_token(&ready_lookup("my-vk-token"), "p1").unwrap();
    assert_eq!(token, "my-vk-token");
}

#[test]
fn test_require_vk_token_rejects_empty_ready_token() {
    let err = require_vk_token(&ready_lookup(""), "p1").expect_err("empty token in Ready");
    assert_eq!(vk_status(err), StatusCode::SERVICE_UNAVAILABLE);
}

#[test]
fn test_require_vk_token_disabled_returns_503() {
    let err = require_vk_token(&GatewayLookup::Disabled, "p1").expect_err("disabled");
    let body = match &err {
        AppError::ServiceUnavailable(msg) => msg.clone(),
        _ => panic!("expected ServiceUnavailable"),
    };
    assert_eq!(vk_status(err), StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("disabled"));
}

#[test]
fn test_require_vk_token_not_configured_returns_503() {
    let err =
        require_vk_token(&GatewayLookup::NotConfigured, "proj-x").expect_err("not configured");
    let body = match &err {
        AppError::ServiceUnavailable(msg) => msg.clone(),
        _ => panic!("expected ServiceUnavailable"),
    };
    assert_eq!(vk_status(err), StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("as-proj-proj-x-vk"));
}

#[test]
fn test_require_vk_token_forbidden_surfaces_rbac_hint() {
    let err =
        require_vk_token(&GatewayLookup::Forbidden("403".into()), "p1").expect_err("forbidden");
    let body = match err {
        AppError::ServiceUnavailable(msg) => msg,
        _ => panic!("expected ServiceUnavailable"),
    };
    assert!(body.contains("RBAC"));
}

#[test]
fn test_require_vk_token_malformed_secret() {
    let err = require_vk_token(
        &GatewayLookup::MalformedSecret("token key missing".into()),
        "p1",
    )
    .expect_err("malformed");
    let body = match err {
        AppError::ServiceUnavailable(msg) => msg,
        _ => panic!("expected ServiceUnavailable"),
    };
    assert!(body.contains("malformed"));
}
