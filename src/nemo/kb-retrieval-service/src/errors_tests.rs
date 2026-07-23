use super::*;
use axum::http::StatusCode;
use http_body_util::BodyExt;

async fn response_status_and_body(err: AppError) -> (StatusCode, serde_json::Value) {
    let response = err.into_response();
    let status = response.status();
    let body = response.into_body();
    let bytes = body.collect().await.unwrap().to_bytes();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (status, value)
}

#[tokio::test]
async fn test_bad_request_error() {
    let (status, body) =
        response_status_and_body(AppError::BadRequest("missing query".to_string())).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "missing query");
}

#[tokio::test]
async fn test_not_found_error() {
    let (status, body) =
        response_status_and_body(AppError::NotFound("KB not found".to_string())).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "KB not found");
}

#[tokio::test]
async fn test_service_unavailable_error() {
    let (status, body) =
        response_status_and_body(AppError::ServiceUnavailable("model not loaded".to_string()))
            .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"], "model not loaded");
}

#[tokio::test]
async fn test_internal_error() {
    let (status, body) =
        response_status_and_body(AppError::Internal("unexpected failure".to_string())).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"], "unexpected failure");
}

#[tokio::test]
async fn test_anyhow_error() {
    let anyhow_err = anyhow::anyhow!("something went wrong");
    let (status, body) = response_status_and_body(AppError::Anyhow(anyhow_err)).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body["error"], "something went wrong");
}

#[test]
fn test_error_display() {
    let err = AppError::BadRequest("test".to_string());
    assert_eq!(err.to_string(), "Bad request: test");

    let err = AppError::NotFound("test".to_string());
    assert_eq!(err.to_string(), "Not found: test");

    let err = AppError::Internal("test".to_string());
    assert_eq!(err.to_string(), "Internal error: test");
}

#[test]
fn test_from_anyhow() {
    let anyhow_err = anyhow::anyhow!("wrapped error");
    let app_err: AppError = anyhow_err.into();
    assert!(matches!(app_err, AppError::Anyhow(_)));
}
