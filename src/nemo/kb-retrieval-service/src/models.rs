use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

/// Single knowledge base search request body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub query: String,
    #[serde(default = "default_top_k")]
    pub top_k: u32,
    #[serde(default)]
    pub min_score: f64,
    #[serde(default = "default_distance_metric")]
    pub distance_metric: String,
    pub search_mode: Option<String>,
    pub reranker_type: Option<String>,
    #[allow(dead_code)]
    pub reranker_options: Option<serde_json::Value>,
    pub nprobe: Option<u32>,
    pub refine_factor: Option<u32>,
}

/// Multi-knowledge base search request body.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiSearchRequest {
    pub query: String,
    pub knowledge_base_ids: Vec<String>,
    #[serde(default = "default_top_k")]
    pub top_k: u32,
    #[serde(default)]
    pub min_score: f64,
    #[serde(default = "default_distance_metric")]
    pub distance_metric: String,
    #[serde(default = "default_aggregation_strategy")]
    pub aggregation_strategy: String,
    pub search_mode: Option<String>,
}

fn default_top_k() -> u32 {
    10
}
fn default_distance_metric() -> String {
    "cosine".to_string()
}
fn default_aggregation_strategy() -> String {
    "merge".to_string()
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Single knowledge base search response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub query: String,
    pub top_k: u32,
    pub result_count: usize,
    pub processing_time_ms: f64,
    pub knowledge_base_id: String,
    pub search_mode: String,
    pub indexing_mode: String,
    pub distance_metric: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reranker_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nprobe: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refine_factor: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// A single search result chunk.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub document_id: String,
    pub source: String,
    pub text: String,
    pub chunk_index: i64,
    pub score: f64,
    pub metadata: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge_base_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge_base_name: Option<String>,
}

/// Multi-KB search response with "merge" aggregation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiSearchMergeResponse {
    pub results: Vec<SearchResult>,
    pub aggregation_strategy: String,
    pub query: String,
    pub top_k: u32,
    pub processing_time_ms: f64,
    pub knowledge_bases_queried: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_search_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Multi-KB search response with "per_kb" aggregation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiSearchPerKbResponse {
    pub results: Vec<PerKbResult>,
    pub aggregation_strategy: String,
    pub query: String,
    pub top_k: u32,
    pub processing_time_ms: f64,
    pub knowledge_bases_queried: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_search_mode: Option<String>,
}

/// Per-KB result set for "per_kb" aggregation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerKbResult {
    pub knowledge_base_id: String,
    pub knowledge_base_name: String,
    pub search_mode: String,
    pub chunks: Vec<SearchResult>,
}

// ---------------------------------------------------------------------------
// Health / readiness / metrics responses
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessResponse {
    pub status: String,
    pub service: String,
    pub embedding_model: String,
    pub data_mount: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // JSON metrics shape kept for parity with the old API; bin uses Prometheus.
pub struct MetricsResponse {
    pub connection_pool: PoolMetrics,
    pub requests: RequestMetrics,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // See MetricsResponse — kept for parity with old JSON API.
pub struct PoolMetrics {
    pub size: u64,
    pub max_size: u64,
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub hit_rate: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // See MetricsResponse — kept for parity with old JSON API.
pub struct RequestMetrics {
    pub total: u64,
    pub successful: u64,
    pub failed: u64,
    pub avg_latency_ms: f64,
}

/// Knowledge base metadata response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbMetadataResponse {
    pub knowledge_base_id: String,
    pub project_id: String,
    pub lancedb_path: String,
    pub embedding_model: String,
    pub vector_size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_processed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_processing_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexing_mode: Option<String>,
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;
