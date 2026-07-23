pub mod health;
pub mod metadata;
pub mod search;

use std::time::Duration;

use axum::Router;
use tower_http::timeout::TimeoutLayer;

use agentstudio_observability_client::http::{HttpTraceLayer, LoggingLayer, RequestIdLayer};

use crate::state::AppState;

/// Hard upper bound for any HTTP request. Keeps the readiness probe responsive
/// even when a query falls back to brute-force scan.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Build the complete application router.
pub fn build_router(state: AppState) -> Router {
    // TimeoutLayer::new returns 408 Request Timeout by default. The newer
    // tower-http API (`with_status_code`) requires picking a status code
    // explicitly; sticking with the default for now matches the prior
    // behaviour. Tracked for follow-up alongside other tower-http deprecations.
    #[allow(deprecated)]
    Router::new()
        // Health and monitoring
        .merge(health::routes())
        // API routes
        .merge(search::routes())
        .merge(metadata::routes())
        .with_state(state)
        .layer(TimeoutLayer::new(REQUEST_TIMEOUT))
        // Observability: OTel SERVER spans + RED metrics + request-id + access logs
        // Layer order (outermost → innermost): RequestId → HttpTrace → Logging
        .layer(LoggingLayer::default())
        .layer(HttpTraceLayer)
        .layer(RequestIdLayer)
}
