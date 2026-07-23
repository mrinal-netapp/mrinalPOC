use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::config::Config;
use crate::embedding::EmbeddingService;
use crate::models::{MetricsResponse, PoolMetrics, RequestMetrics};
use crate::pool::ConnectionPool;
use crate::project_gateway::{GatewayLookup, ProjectGatewayAuth, ProjectGatewayResolver};

/// Shared application state accessible from all request handlers.
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub pool: Arc<ConnectionPool>,
    pub embedding: Arc<EmbeddingService>,
    pub project_gateway: Arc<ProjectGatewayResolver>,
    pub request_metrics: Arc<AppRequestMetrics>,
}

/// Atomic request-level metrics for the /metrics endpoint.
pub struct AppRequestMetrics {
    pub total: AtomicU64,
    pub successful: AtomicU64,
    pub failed: AtomicU64,
    /// Cumulative latency in microseconds (for computing average).
    pub total_latency_us: AtomicU64,
}

impl Default for AppRequestMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl AppRequestMetrics {
    pub fn new() -> Self {
        Self {
            total: AtomicU64::new(0),
            successful: AtomicU64::new(0),
            failed: AtomicU64::new(0),
            total_latency_us: AtomicU64::new(0),
        }
    }

    /// Record a successful request with the given latency in microseconds.
    pub fn record_success(&self, latency_us: u64) {
        self.total.fetch_add(1, Ordering::Relaxed);
        self.successful.fetch_add(1, Ordering::Relaxed);
        self.total_latency_us
            .fetch_add(latency_us, Ordering::Relaxed);
    }

    /// Record a failed request with the given latency in microseconds.
    #[allow(dead_code)]
    pub fn record_failure(&self, latency_us: u64) {
        self.total.fetch_add(1, Ordering::Relaxed);
        self.failed.fetch_add(1, Ordering::Relaxed);
        self.total_latency_us
            .fetch_add(latency_us, Ordering::Relaxed);
    }
}

impl AppState {
    /// Bifrost virtual-key + gateway URL for a project (from K8s Secret `as-proj-{id}-vk`).
    /// Collapses every failure mode to `None` — only safe to use from routes
    /// that don't surface a tailored error to the user (e.g. metadata, which
    /// happily renders the basic fields without a VK).
    pub async fn project_gateway_auth(&self, project_id: &str) -> Option<Arc<ProjectGatewayAuth>> {
        self.project_gateway.resolve_optional(project_id).await
    }

    /// Variant of [`project_gateway_auth`] that preserves the lookup
    /// outcome. The search route uses this so 403/RBAC failures don't
    /// silently masquerade as "no VK configured".
    pub async fn project_gateway_lookup(&self, project_id: &str) -> GatewayLookup {
        self.project_gateway.resolve(project_id).await
    }

    /// Build the aggregated metrics response.
    ///
    /// Kept for parity with the prior JSON-metrics API. Prometheus metrics are
    /// now served by the observability client's dedicated `/metrics` server
    /// (pool gauges registered via `observability::register_pool_metrics`), so
    /// this helper is only used by callers that explicitly want the structured
    /// shape (e.g. tests).
    #[allow(dead_code)]
    pub fn get_metrics(&self) -> MetricsResponse {
        let pool_stats = &self.pool.stats;
        let req = &self.request_metrics;

        let total = req.total.load(Ordering::Relaxed);
        let total_latency_us = req.total_latency_us.load(Ordering::Relaxed);
        let avg_latency_ms = if total > 0 {
            (total_latency_us as f64) / (total as f64) / 1000.0
        } else {
            0.0
        };

        MetricsResponse {
            connection_pool: PoolMetrics {
                size: self.pool.size(),
                max_size: self.pool.max_size(),
                hits: pool_stats.hits.load(Ordering::Relaxed),
                misses: pool_stats.misses.load(Ordering::Relaxed),
                evictions: pool_stats.evictions.load(Ordering::Relaxed),
                hit_rate: pool_stats.hit_rate(),
            },
            requests: RequestMetrics {
                total,
                successful: req.successful.load(Ordering::Relaxed),
                failed: req.failed.load(Ordering::Relaxed),
                avg_latency_ms,
            },
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;
