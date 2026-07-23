use std::time::Duration;

use anyhow::{Context, Result};
use arrow_array::RecordBatch;
use futures::TryStreamExt;
use lancedb::DistanceType;
use lancedb::query::{ExecutableQuery, QueryBase};
use lancedb::table::Table;
use tracing::{debug, info, warn};

use crate::models::SearchResult;

/// Maximum wall-clock time for a single LanceDB query (vector or FTS).
/// Prevents brute-force fallback scans from starving the Tokio runtime.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// Core search engine that executes vector, FTS, and hybrid queries against LanceDB.
pub struct SearchEngine;

impl SearchEngine {
    /// Execute a vector similarity search.
    ///
    /// The query is executed inside a spawned task so that if the
    /// `QUERY_TIMEOUT` deadline expires, the underlying LanceDB work
    /// (in particular, first-time index loading) keeps running in the
    /// background.  Dropping the `JoinHandle` only *detaches* the task —
    /// it does not cancel it — so subsequent queries will find the index
    /// already cached.
    pub async fn vector_search(
        table: &Table,
        query_vector: &[f32],
        top_k: u32,
        distance_metric: &str,
        nprobe: Option<u32>,
        refine_factor: Option<u32>,
    ) -> Result<Vec<SearchResult>> {
        let dist_type = parse_distance_type(distance_metric);
        let distance_metric_owned = distance_metric.to_string();

        debug!(
            "Executing vector search: top_k={}, metric={:?}",
            top_k, dist_type
        );

        let mut vq = table
            .vector_search(query_vector)
            .context("Failed to create vector query")?;

        vq = vq.distance_type(dist_type).limit(top_k as usize);

        if let Some(n) = nprobe {
            vq = vq.nprobes(n as usize);
        }
        if let Some(rf) = refine_factor {
            vq = vq.refine_factor(rf);
        }

        let query_task = tokio::spawn(async move {
            vq.execute()
                .await
                .context("Failed to execute vector search")?
                .try_collect::<Vec<RecordBatch>>()
                .await
                .context("Failed to collect vector search results")
        });

        match tokio::time::timeout(QUERY_TIMEOUT, query_task).await {
            Ok(join_result) => {
                let batches = join_result
                    .map_err(|e| anyhow::anyhow!("Vector search task panicked: {}", e))??;
                let results = extract_vector_results(&batches, &distance_metric_owned);
                debug!("Vector search returned {} results", results.len());
                Ok(results)
            }
            Err(_elapsed) => {
                warn!(
                    "Vector search timed out after {}s — the spawned query will keep running \
                     so the index finishes loading for subsequent queries",
                    QUERY_TIMEOUT.as_secs()
                );
                Err(anyhow::anyhow!(
                    "Vector search timed out after {}s (index may still be loading — \
                     subsequent queries should be faster)",
                    QUERY_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// Execute a full-text search.
    pub async fn fts_search(
        table: &Table,
        query_text: &str,
        top_k: u32,
    ) -> Result<Vec<SearchResult>> {
        debug!("Executing FTS search: top_k={}", top_k);

        let fts_query = lancedb::index::scalar::FullTextSearchQuery::new(query_text.to_string());

        let batches: Vec<RecordBatch> = tokio::time::timeout(QUERY_TIMEOUT, async {
            table
                .query()
                .full_text_search(fts_query)
                .limit(top_k as usize)
                .execute()
                .await
                .context("Failed to execute FTS search")?
                .try_collect()
                .await
                .context("Failed to collect FTS results")
        })
        .await
        .map_err(|_| {
            anyhow::anyhow!("FTS search timed out after {}s", QUERY_TIMEOUT.as_secs())
        })??;

        let results = extract_fts_results(&batches);
        debug!("FTS search returned {} results", results.len());
        Ok(results)
    }

    /// Execute a hybrid search (vector + FTS).
    ///
    /// Runs both vector and FTS queries, then merges results. When
    /// `use_reranking` is `true` the two ranked lists are fused with
    /// Reciprocal Rank Fusion (RRF); when `false` they are combined with a
    /// plain score-based merge (see [`simple_merge`]) so callers who disable
    /// reranking get the un-fused baseline instead of RRF.
    #[allow(clippy::too_many_arguments)]
    pub async fn hybrid_search(
        table: &Table,
        query_text: &str,
        query_vector: &[f32],
        top_k: u32,
        distance_metric: &str,
        nprobe: Option<u32>,
        refine_factor: Option<u32>,
        use_reranking: bool,
    ) -> Result<Vec<SearchResult>> {
        debug!(
            "Executing hybrid search: top_k={}, reranking={}",
            top_k, use_reranking
        );

        // Run both searches, using larger limit for better RRF merging
        let expanded_k = (top_k * 3).min(100);

        let vector_results = Self::vector_search(
            table,
            query_vector,
            expanded_k,
            distance_metric,
            nprobe,
            refine_factor,
        )
        .await;

        let fts_results = Self::fts_search(table, query_text, expanded_k).await;

        match (vector_results, fts_results) {
            (Ok(vr), Ok(fr)) => {
                let merged = if use_reranking {
                    rrf_merge(&vr, &fr, top_k as usize)
                } else {
                    simple_merge(&vr, &fr, top_k as usize)
                };
                info!(
                    "Hybrid search ({}): {} vector + {} FTS → {} merged",
                    if use_reranking { "rrf" } else { "no-rerank" },
                    vr.len(),
                    fr.len(),
                    merged.len()
                );
                Ok(merged)
            }
            (Ok(vr), Err(fts_err)) => {
                // FTS failed (likely no FTS index), fall back to vector-only
                warn!(
                    "FTS search failed, falling back to vector-only: {}",
                    fts_err
                );
                let mut results = vr;
                results.truncate(top_k as usize);
                Ok(results)
            }
            (Err(vec_err), Ok(fr)) => {
                warn!(
                    "Vector search failed, falling back to FTS-only: {}",
                    vec_err
                );
                let mut results = fr;
                results.truncate(top_k as usize);
                Ok(results)
            }
            (Err(vec_err), Err(_fts_err)) => {
                Err(vec_err).context("Both vector and FTS searches failed in hybrid mode")
            }
        }
    }

    /// Execute a search with the specified mode.
    ///
    /// Carries 10 args because each corresponds to a distinct LanceDB tuning
    /// knob (plus the reranker selector) the HTTP layer accepts as-is;
    /// collapsing them into a struct adds an indirection without removing
    /// the underlying complexity.
    #[allow(clippy::too_many_arguments)]
    pub async fn search(
        table: &Table,
        query_text: &str,
        query_vector: &[f32],
        search_mode: &str,
        top_k: u32,
        min_score: f64,
        distance_metric: &str,
        nprobe: Option<u32>,
        refine_factor: Option<u32>,
        reranker_type: Option<&str>,
    ) -> Result<Vec<SearchResult>> {
        // Reranking (RRF) is ON by default for hybrid search and is only
        // skipped when the caller explicitly asks for it via
        // `rerankerType: "none"`. Every other value — including the
        // historical case of an absent field — keeps RRF so existing
        // callers (agents, multi-KB search) are unaffected.
        let use_reranking = !reranker_type
            .map(|r| r.eq_ignore_ascii_case("none"))
            .unwrap_or(false);

        let mut results = match search_mode {
            "fts" => Self::fts_search(table, query_text, top_k).await?,
            "hybrid" => {
                Self::hybrid_search(
                    table,
                    query_text,
                    query_vector,
                    top_k,
                    distance_metric,
                    nprobe,
                    refine_factor,
                    use_reranking,
                )
                .await?
            }
            _ => {
                // Default: vector search
                Self::vector_search(
                    table,
                    query_vector,
                    top_k,
                    distance_metric,
                    nprobe,
                    refine_factor,
                )
                .await?
            }
        };

        // Apply min_score filter
        if min_score > 0.0 {
            results.retain(|r| r.score >= min_score);
        }

        // Ensure we don't exceed top_k
        results.truncate(top_k as usize);

        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// Distance type parsing
// ---------------------------------------------------------------------------

fn parse_distance_type(metric: &str) -> DistanceType {
    match metric.to_lowercase().as_str() {
        "l2" => DistanceType::L2,
        "dot" => DistanceType::Dot,
        _ => DistanceType::Cosine,
    }
}

// ---------------------------------------------------------------------------
// Arrow RecordBatch → SearchResult extraction
// ---------------------------------------------------------------------------

/// Extract results from vector search RecordBatches.
///
/// The `_distance` column contains the raw distance; we convert it to a
/// similarity score in [0, 1] using the appropriate distance metric.
fn extract_vector_results(batches: &[RecordBatch], distance_metric: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();

    for batch in batches {
        let num_rows = batch.num_rows();
        for i in 0..num_rows {
            let distance = extract_f64(batch, "_distance", i).unwrap_or(0.0);
            let score = distance_to_score(distance, distance_metric);

            results.push(build_search_result(batch, i, score));
        }
    }

    // Sort by score descending
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results
}

/// Extract results from FTS search RecordBatches.
///
/// The `_score` column contains the BM25 relevance score. We normalize
/// it to [0, 1] using score / (score + 1).
fn extract_fts_results(batches: &[RecordBatch]) -> Vec<SearchResult> {
    let mut results = Vec::new();

    for batch in batches {
        let num_rows = batch.num_rows();
        for i in 0..num_rows {
            let raw_score = extract_f64(batch, "_score", i)
                .or_else(|| extract_f64(batch, "_relevance_score", i))
                .unwrap_or(0.0);
            let score = raw_score / (raw_score + 1.0);

            results.push(build_search_result(batch, i, score));
        }
    }

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results
}

/// Build a SearchResult from a RecordBatch row.
fn build_search_result(batch: &RecordBatch, row: usize, score: f64) -> SearchResult {
    let metadata_str = extract_string(batch, "metadata", row).unwrap_or_default();
    let metadata: serde_json::Value =
        serde_json::from_str(&metadata_str).unwrap_or(serde_json::Value::Null);

    SearchResult {
        id: extract_string(batch, "id", row).unwrap_or_default(),
        document_id: extract_string(batch, "document_id", row).unwrap_or_default(),
        source: extract_string(batch, "source", row).unwrap_or_default(),
        text: extract_string(batch, "text", row).unwrap_or_default(),
        chunk_index: extract_i64(batch, "chunk_index", row).unwrap_or(0),
        score,
        metadata,
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    }
}

/// Convert a distance value to a similarity score in [0, 1].
///
/// Legacy compatibility scoring:
/// - cosine: 1.0 - (distance / 2.0)  — cosine distance is [0, 2]
/// - l2:     1.0 / (1.0 + distance)   — reciprocal
/// - dot:    clamp distance to [0, 1]
fn distance_to_score(distance: f64, metric: &str) -> f64 {
    let score = match metric.to_lowercase().as_str() {
        "cosine" => 1.0 - (distance / 2.0),
        "l2" => 1.0 / (1.0 + distance),
        "dot" => distance.clamp(0.0, 1.0),
        _ => 1.0 - (distance / 2.0), // default cosine
    };
    score.clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion (RRF) merging
// ---------------------------------------------------------------------------

/// Merge two ranked result lists using Reciprocal Rank Fusion.
///
/// RRF score = Σ (1 / (k + rank_i)) for each list the document appears in.
/// Uses k=60 (standard RRF constant).
fn rrf_merge(
    vector_results: &[SearchResult],
    fts_results: &[SearchResult],
    top_k: usize,
) -> Vec<SearchResult> {
    use std::collections::HashMap;

    const RRF_K: f64 = 60.0;

    // Map: chunk_id -> (rrf_score, best_result)
    let mut scores: HashMap<String, (f64, SearchResult)> = HashMap::new();

    // Score vector results by rank
    for (rank, result) in vector_results.iter().enumerate() {
        let rrf_score = 1.0 / (RRF_K + rank as f64 + 1.0);
        let entry = scores
            .entry(result.id.clone())
            .or_insert_with(|| (0.0, result.clone()));
        entry.0 += rrf_score;
    }

    // Score FTS results by rank
    for (rank, result) in fts_results.iter().enumerate() {
        let rrf_score = 1.0 / (RRF_K + rank as f64 + 1.0);
        let entry = scores
            .entry(result.id.clone())
            .or_insert_with(|| (0.0, result.clone()));
        entry.0 += rrf_score;
    }

    // Collect and sort by RRF score
    let mut merged: Vec<SearchResult> = scores
        .into_values()
        .map(|(rrf_score, mut result)| {
            // Normalize RRF score to [0, 1] — max possible is 2/(k+1)
            let max_rrf = 2.0 / (RRF_K + 1.0);
            result.score = (rrf_score / max_rrf).clamp(0.0, 1.0);
            result
        })
        .collect();

    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(top_k);
    merged
}

/// Merge two ranked result lists WITHOUT reciprocal rank fusion.
///
/// Used when reranking is explicitly disabled for a hybrid query. Both the
/// vector and FTS lists already carry scores normalised to [0, 1]
/// (cosine-similarity and `bm25 / (bm25 + 1)` respectively), so we take the
/// union, keep the higher score when a chunk appears in both lists, and sort
/// by that native score. This is the naive baseline that RRF improves on —
/// exposing it lets playground users compare fused vs. un-fused ranking.
fn simple_merge(
    vector_results: &[SearchResult],
    fts_results: &[SearchResult],
    top_k: usize,
) -> Vec<SearchResult> {
    use std::collections::HashMap;

    let mut best: HashMap<String, SearchResult> = HashMap::new();
    for result in vector_results.iter().chain(fts_results.iter()) {
        best.entry(result.id.clone())
            .and_modify(|existing| {
                if result.score > existing.score {
                    *existing = result.clone();
                }
            })
            .or_insert_with(|| result.clone());
    }

    let mut merged: Vec<SearchResult> = best.into_values().collect();
    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(top_k);
    merged
}

// ---------------------------------------------------------------------------
// Arrow column extraction helpers
// ---------------------------------------------------------------------------

fn extract_string(batch: &RecordBatch, col_name: &str, row: usize) -> Option<String> {
    use arrow_array::Array;

    let col = batch.column_by_name(col_name)?;

    // Try StringArray (Utf8)
    if let Some(arr) = col.as_any().downcast_ref::<arrow_array::StringArray>() {
        if arr.is_null(row) {
            return None;
        }
        return Some(arr.value(row).to_string());
    }

    // Try LargeStringArray (LargeUtf8)
    if let Some(arr) = col.as_any().downcast_ref::<arrow_array::LargeStringArray>() {
        if arr.is_null(row) {
            return None;
        }
        return Some(arr.value(row).to_string());
    }

    None
}

fn extract_i64(batch: &RecordBatch, col_name: &str, row: usize) -> Option<i64> {
    use arrow_array::Array;

    let col = batch.column_by_name(col_name)?;
    let arr = col.as_any().downcast_ref::<arrow_array::Int64Array>()?;
    if arr.is_null(row) {
        return None;
    }
    Some(arr.value(row))
}

fn extract_f64(batch: &RecordBatch, col_name: &str, row: usize) -> Option<f64> {
    use arrow_array::Array;

    let col = batch.column_by_name(col_name)?;

    // Try Float64Array
    if let Some(arr) = col.as_any().downcast_ref::<arrow_array::Float64Array>() {
        if arr.is_null(row) {
            return None;
        }
        return Some(arr.value(row));
    }

    // Try Float32Array (cast to f64)
    if let Some(arr) = col.as_any().downcast_ref::<arrow_array::Float32Array>() {
        if arr.is_null(row) {
            return None;
        }
        return Some(arr.value(row) as f64);
    }

    None
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
