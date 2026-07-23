mod config;
mod embedding;
mod errors;
mod models;
mod observability;
mod pool;
mod project_gateway;
mod routes;
mod search;
mod state;
mod store_metadata;

use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{error, info};

use crate::config::Config;
use crate::embedding::EmbeddingService;
use crate::pool::ConnectionPool;
use crate::project_gateway::ProjectGatewayResolver;
use crate::state::{AppRequestMetrics, AppState};
use crate::store_metadata::validate_data_mount;

#[tokio::main]
async fn main() {
    // Load configuration first so service name / log level are available.
    let config = Config::from_env();

    // Bootstrap structured logging, OTel traces, and Prometheus/OTLP metrics
    // via the AgentStudio observability client.  This replaces the manual
    // tracing-subscriber + init_prometheus() calls that were here before.
    if let Err(e) =
        agentstudio_observability_client::configure_logging_for_service("kb-retrieval-service")
    {
        eprintln!("observability init failed (continuing): {e}");
    }

    if config.debug {
        info!("Debug mode enabled (DEBUG=true); set RUST_LOG=debug for verbose output");
    }

    info!(
        "Starting kb-retrieval-service v{}",
        env!("CARGO_PKG_VERSION")
    );
    info!(
        "Configuration: port={}, data_root={}",
        config.port, config.data_root,
    );

    // Validate data mount exists and is accessible
    match validate_data_mount(&config) {
        Ok(()) => info!("Data mount validated: {}", config.data_root),
        Err(msg) => {
            error!("{}", msg);
            std::process::exit(1);
        }
    }

    // Initialize the gateway-backed embedding client. No model files —
    // queries hit Bifrost at `${LLM_GATEWAY_URL}/litellm/v1/embeddings`
    // with the per-project virtual-key bearer threaded in by route handlers.
    let embedding = Arc::new(EmbeddingService::new(config.llm_gateway_url.clone()));
    if embedding.is_ready() {
        info!(
            "Embedding gateway client ready (url={})",
            config.llm_gateway_url
        );
    } else {
        error!(
            "Embedding gateway URL is empty — vector search will return 503 until LLM_GATEWAY_URL is set."
        );
    }

    // Initialize connection pool
    let config = Arc::new(config);
    let pool = Arc::new(ConnectionPool::new(config.clone()));

    let project_gateway = Arc::new(ProjectGatewayResolver::from_config(&config).await);

    // Build application state
    let state = AppState {
        config: config.clone(),
        pool,
        embedding,
        project_gateway,
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };

    // Register connection-pool gauges on the long-lived meter so they surface
    // on the dedicated standalone Prometheus server. Must come after
    // observability init (above) and use the same pool Arc the handlers hold.
    observability::register_pool_metrics(state.pool.clone());

    // Build router
    let app = routes::build_router(state);

    // Start server
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind to address");

    axum::serve(listener, app).await.expect("Server error");

    // Flush and shut down OTel pipelines cleanly on exit.
    if let Err(e) = agentstudio_observability_client::shutdown_observability() {
        eprintln!("observability shutdown error: {e}");
    }
}
