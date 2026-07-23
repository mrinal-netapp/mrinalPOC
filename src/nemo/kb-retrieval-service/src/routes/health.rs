use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;

use crate::models::{HealthResponse, ReadinessResponse};
use crate::state::AppState;

// NOTE: Prometheus metrics are no longer served on the application port.
// The observability client runs a dedicated standalone /metrics server on
// AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT (see main.rs / Helm),
// which keeps the app port free of metrics so it can stay STRICT mTLS.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health_check))
        .route("/ready", get(readiness_check))
}

/// GET /health — Kubernetes liveness probe.
async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy".to_string(),
        service: "kb-retrieval-service".to_string(),
        timestamp: Utc::now().to_rfc3339(),
    })
}

/// GET /ready — Kubernetes readiness probe.
///
/// Returns 200 when the embedding model is loaded; 503 otherwise.
async fn readiness_check(State(state): State<AppState>) -> impl IntoResponse {
    let embedding_ready = state.embedding.is_ready();
    let status = if embedding_ready {
        "ready"
    } else {
        "not_ready"
    };
    let embedding_model = if embedding_ready {
        "loaded"
    } else {
        "not_loaded"
    };

    let data_mount_ok = std::path::Path::new(&state.config.data_root).exists();

    let response = ReadinessResponse {
        status: status.to_string(),
        service: "kb-retrieval-service".to_string(),
        embedding_model: embedding_model.to_string(),
        data_mount: if data_mount_ok {
            "available"
        } else {
            "not_found"
        }
        .to_string(),
        timestamp: Utc::now().to_rfc3339(),
    };

    if embedding_ready {
        (StatusCode::OK, Json(response))
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(response))
    }
}
