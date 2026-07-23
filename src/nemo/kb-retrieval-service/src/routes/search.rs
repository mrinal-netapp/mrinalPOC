use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use opentelemetry::trace::TraceContextExt;
use opentelemetry::{Context, KeyValue};
use std::time::Instant;
use tracing::{error, info, warn};

use crate::errors::AppError;
use crate::models::{
    MultiSearchMergeResponse, MultiSearchPerKbResponse, MultiSearchRequest, PerKbResult,
    SearchRequest, SearchResponse, SearchResult,
};
use crate::project_gateway::GatewayLookup;
use crate::search::SearchEngine;
use crate::state::AppState;
use crate::store_metadata;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/projects/{projectId}/knowledgebases/{kbId}/search",
            post(search_single_kb),
        )
        .route(
            "/api/v1/projects/{projectId}/knowledgebases/search",
            post(search_multiple_kbs),
        )
}

/// POST /api/v1/projects/{projectId}/knowledgebases/{kbId}/search
///
/// Search a single knowledge base. Supports vector, FTS, and hybrid modes.
async fn search_single_kb(
    State(state): State<AppState>,
    Path((project_id, kb_id)): Path<(String, String)>,
    Json(req): Json<SearchRequest>,
) -> Result<impl IntoResponse, AppError> {
    let start = Instant::now();

    if req.query.is_empty() {
        return Err(AppError::BadRequest("Query is required".to_string()));
    }
    if req.top_k < 1 || req.top_k > 100 {
        return Err(AppError::BadRequest(
            "topK must be between 1 and 100".to_string(),
        ));
    }

    info!(
        "Single KB search: project={}, kb={}, query_len={}, mode={:?}",
        project_id,
        kb_id,
        req.query.len(),
        req.search_mode
    );

    // Resolve the project's Bifrost virtual key — required for the embedding
    // call when search_mode != "fts". For FTS-only requests we don't need a
    // VK; only fail-fast on the vector / hybrid path below after we know
    // the resolved search_mode. We deliberately use the diagnostic-rich
    // lookup so a 403/RBAC failure surfaces with a remediation hint
    // instead of the misleading "VK not configured" message — see
    // [`require_vk_token`] for the full mapping.
    let lookup = state.project_gateway_lookup(&project_id).await;

    let metadata = Some(
        match store_metadata::read_metadata_with_retry(&state.config, &project_id, &kb_id).await {
            store_metadata::MetadataRead::Found(value) => value,
            // A present-but-unreadable metadata.json (corrupt JSON or a non-ENOENT
            // IO error) won't clear on retry, so fail fast with a distinct error
            // instead of a misleading "retry" hint.
            store_metadata::MetadataRead::Unreadable => {
                return Err(AppError::Internal(format!(
                    "Knowledge base '{}' metadata is present but could not be read (corrupted or unreadable); reprocess the knowledge base.",
                    kb_id
                )));
            }
            // Distinguish a genuinely missing KB from the NFS visibility lag we
            // just retried for: dir present -> 503 with a retry hint (never fall
            // through to the fallback embedding model); dir absent -> 404,
            // matching routes/metadata.rs.
            store_metadata::MetadataRead::Missing => {
                if state.config.kb_base_dir(&project_id, &kb_id).exists() {
                    return Err(AppError::ServiceUnavailable(format!(
                        "Knowledge base '{}' metadata is not visible on the data mount yet; retry the search.",
                        kb_id
                    )));
                }
                return Err(AppError::NotFound(format!(
                    "Knowledge base '{}' not found in project '{}'.",
                    kb_id, project_id
                )));
            }
        },
    );

    let indexing_mode = store_metadata::get_indexing_mode(&metadata);
    let lance_table_path = store_metadata::get_lancedb_path(&metadata);
    let lancedb_path =
        state
            .config
            .resolve_lancedb_path(&project_id, &kb_id, lance_table_path.as_deref());

    let resolved = store_metadata::resolve_query_params(
        &req.search_mode,
        &req.distance_metric,
        req.nprobe,
        req.refine_factor,
        &metadata,
    );

    let query_vector = if resolved.search_mode != "fts" {
        // Fail-fast with the diagnostic that matches the actual failure
        // cause (RBAC vs not-yet-configured vs malformed-secret). The
        // previous single-string message hid the 403 case behind a
        // gateway-setup-workflow hint and sent operators chasing the
        // wrong root cause.
        let vk_token = require_vk_token(&lookup, &project_id)?;
        let model_name = store_metadata::get_embedding_model_name(&metadata);
        state
            .embedding
            .encode_query(&model_name, &req.query, &vk_token)
            .await
            .map_err(|e| {
                AppError::ServiceUnavailable(format!(
                    "Embedding gateway unavailable for KB {} (model {}): {}",
                    kb_id, model_name, e
                ))
            })?
    } else {
        vec![]
    };

    let search_mode_clone = resolved.search_mode.clone();
    let query_text = req.query.clone();
    let distance_metric = resolved.distance_metric.clone();
    let top_k = req.top_k;
    let min_score = req.min_score;
    let nprobe = resolved.nprobe;
    let refine_factor = resolved.refine_factor;
    let reranker_type = req.reranker_type.clone();

    let results = state
        .pool
        .execute_with_retry(&project_id, &kb_id, &lancedb_path, |table| {
            let query_vector = query_vector.clone();
            let search_mode = search_mode_clone.clone();
            let query_text = query_text.clone();
            let distance_metric = distance_metric.clone();
            let reranker_type = reranker_type.clone();
            async move {
                SearchEngine::search(
                    &table,
                    &query_text,
                    &query_vector,
                    &search_mode,
                    top_k,
                    min_score,
                    &distance_metric,
                    nprobe,
                    refine_factor,
                    reranker_type.as_deref(),
                )
                .await
            }
        })
        .await
        .map_err(|e| classify_search_error(&project_id, &kb_id, e))?;

    let mut results = results;
    store_metadata::enrich_download_urls(&mut results, &state.config);

    let elapsed = start.elapsed();
    let processing_time_ms = elapsed.as_secs_f64() * 1000.0;

    state
        .request_metrics
        .record_success(elapsed.as_micros() as u64);

    let result_count = results.len();

    // Enrich the active OTel SERVER span with business-level attributes so
    // they appear in Phoenix / Grafana Tempo when inspecting the trace.
    let cx = Context::current();
    let span = cx.span();
    span.set_attribute(KeyValue::new("kb.project_id", project_id.clone()));
    span.set_attribute(KeyValue::new("kb.id", kb_id.clone()));
    span.set_attribute(KeyValue::new("kb.query", req.query.clone()));
    span.set_attribute(KeyValue::new(
        "kb.search_mode",
        resolved.search_mode.clone(),
    ));
    span.set_attribute(KeyValue::new(
        "kb.distance_metric",
        resolved.distance_metric.clone(),
    ));
    span.set_attribute(KeyValue::new("kb.top_k", req.top_k as i64));
    span.set_attribute(KeyValue::new("kb.result_count", result_count as i64));
    span.set_attribute(KeyValue::new("kb.processing_time_ms", processing_time_ms));

    let response = SearchResponse {
        results,
        query: req.query,
        top_k: req.top_k,
        result_count,
        processing_time_ms,
        knowledge_base_id: kb_id,
        search_mode: resolved.search_mode,
        indexing_mode,
        distance_metric: resolved.distance_metric,
        reranker_type: req.reranker_type,
        nprobe: resolved.nprobe,
        refine_factor: resolved.refine_factor,
        warnings: resolved.warnings,
    };

    Ok(Json(response))
}

/// POST /api/v1/projects/{projectId}/knowledgebases/search
///
/// Search across multiple knowledge bases with aggregation.
async fn search_multiple_kbs(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(req): Json<MultiSearchRequest>,
) -> Result<impl IntoResponse, AppError> {
    let start = Instant::now();

    if req.query.is_empty() {
        return Err(AppError::BadRequest("Query is required".to_string()));
    }
    if req.knowledge_base_ids.is_empty() {
        return Err(AppError::BadRequest(
            "knowledgeBaseIds is required and must not be empty".to_string(),
        ));
    }
    if req.knowledge_base_ids.len() > 10 {
        return Err(AppError::BadRequest(
            "Maximum 10 knowledge bases per query".to_string(),
        ));
    }

    info!(
        "Multi KB search: project={}, kbs={}, aggregation={}",
        project_id,
        req.knowledge_base_ids.len(),
        req.aggregation_strategy
    );

    let lookup = state.project_gateway_lookup(&project_id).await;
    let requested_mode = req.search_mode.as_deref().map(|s| s.to_lowercase());

    // Fail-fast on missing project gateway auth UNLESS this is a pure-FTS
    // request (no embedding needed). Symmetric with single-KB above; without
    // this, every KB-iteration would warn-then-skip and the caller would
    // see a 200 with zero results — easy to confuse with "no docs match".
    // Uses the same diagnostic-aware helper so RBAC failures don't get
    // mis-attributed to a missing gateway-setup workflow.
    let vk_token = if requested_mode.as_deref() == Some("fts") {
        String::new()
    } else {
        require_vk_token(&lookup, &project_id)?
    };

    let mut all_results: Vec<(String, String, Vec<SearchResult>)> = Vec::new();
    let mut all_warnings: Vec<String> = Vec::new();

    // Cache embeddings by model name — when several KBs in the request share
    // an embedding model (the common case for built-in MiniLM), we only call
    // Bifrost once. Different models necessarily produce different vectors,
    // so they get distinct keys.
    let mut embedding_cache: std::collections::HashMap<String, Vec<f32>> =
        std::collections::HashMap::new();

    for kb_id in &req.knowledge_base_ids {
        // Single read (no retry): multi-KB search skips a KB on a miss rather
        // than failing, so a per-KB 20s poll would compound to ~200s across the
        // 10-KB limit. Classify the miss so the warning reflects the real cause.
        let metadata = match store_metadata::read_metadata_once(&state.config, &project_id, kb_id) {
            store_metadata::MetadataRead::Found(value) => Some(value),
            store_metadata::MetadataRead::Missing => {
                let reason = if state.config.kb_base_dir(&project_id, kb_id).exists() {
                    "metadata is not visible on the data mount yet"
                } else {
                    "not found"
                };
                all_warnings.push(format!("KB '{}': {}; skipping", kb_id, reason));
                continue;
            }
            store_metadata::MetadataRead::Unreadable => {
                all_warnings.push(format!(
                    "KB '{}': metadata is present but unreadable (corrupted); skipping",
                    kb_id
                ));
                continue;
            }
        };
        let lance_table_path = store_metadata::get_lancedb_path(&metadata);
        let lancedb_path =
            state
                .config
                .resolve_lancedb_path(&project_id, kb_id, lance_table_path.as_deref());

        let resolved = store_metadata::resolve_query_params(
            &req.search_mode,
            &req.distance_metric,
            None,
            None,
            &metadata,
        );

        for w in &resolved.warnings {
            all_warnings.push(format!("KB '{}': {}", kb_id, w));
        }

        // Per-KB embedding — fetch from cache if another KB in this request
        // already used the same model. Skip entirely on FTS-only queries.
        let query_vector =
            if requested_mode.as_deref() == Some("fts") || resolved.search_mode == "fts" {
                Vec::new()
            } else {
                let model_name = store_metadata::get_embedding_model_name(&metadata);
                match embedding_cache.get(&model_name) {
                    Some(v) => v.clone(),
                    None => match state
                        .embedding
                        .encode_query(&model_name, &req.query, &vk_token)
                        .await
                    {
                        Ok(v) => {
                            embedding_cache.insert(model_name.clone(), v.clone());
                            v
                        }
                        Err(e) => {
                            warn!(
                                "Embedding failed for KB {} (model {}): {}",
                                kb_id, model_name, e
                            );
                            all_warnings.push(format!(
                                "KB '{}': embedding gateway unavailable ({}); skipping",
                                kb_id, model_name
                            ));
                            continue;
                        }
                    },
                }
            };

        let query_vector_clone = query_vector;
        let query_text = req.query.clone();
        let distance_metric = resolved.distance_metric.clone();
        let top_k = req.top_k;
        let min_score = req.min_score;
        let search_mode_clone = resolved.search_mode.clone();
        let nprobe = resolved.nprobe;
        let refine_factor = resolved.refine_factor;

        match state
            .pool
            .execute_with_retry(&project_id, kb_id, &lancedb_path, |table| {
                let qv = query_vector_clone.clone();
                let qt = query_text.clone();
                let dm = distance_metric.clone();
                let sm = search_mode_clone.clone();
                async move {
                    // Multi-KB search does not expose a reranker toggle; keep
                    // the historical default (RRF for hybrid) by passing None.
                    SearchEngine::search(
                        &table,
                        &qt,
                        &qv,
                        &sm,
                        top_k,
                        min_score,
                        &dm,
                        nprobe,
                        refine_factor,
                        None,
                    )
                    .await
                }
            })
            .await
        {
            Ok(mut results) => {
                store_metadata::enrich_download_urls(&mut results, &state.config);
                all_results.push((kb_id.clone(), resolved.search_mode.clone(), results));
            }
            Err(e) => {
                warn!("Search failed for KB {}: {}", kb_id, e);
                all_warnings.push(format!(
                    "KB '{}': search failed — {}",
                    kb_id,
                    summarize_error(&e)
                ));
            }
        }
    }

    let elapsed = start.elapsed();
    let processing_time_ms = elapsed.as_secs_f64() * 1000.0;
    let kb_count = all_results.len();

    state
        .request_metrics
        .record_success(elapsed.as_micros() as u64);

    // Enrich the active OTel SERVER span with business-level attributes.
    let cx = Context::current();
    let span = cx.span();
    span.set_attribute(KeyValue::new("kb.project_id", project_id.clone()));
    span.set_attribute(KeyValue::new("kb.ids", req.knowledge_base_ids.join(",")));
    span.set_attribute(KeyValue::new("kb.query", req.query.clone()));
    span.set_attribute(KeyValue::new("kb.top_k", req.top_k as i64));
    span.set_attribute(KeyValue::new("kb.kb_count", kb_count as i64));
    span.set_attribute(KeyValue::new("kb.processing_time_ms", processing_time_ms));

    all_warnings.truncate(20);

    match req.aggregation_strategy.as_str() {
        "per_kb" => {
            let per_kb: Vec<PerKbResult> = all_results
                .into_iter()
                .map(|(kb_id, search_mode, chunks)| PerKbResult {
                    knowledge_base_id: kb_id.clone(),
                    knowledge_base_name: kb_id,
                    search_mode,
                    chunks,
                })
                .collect();

            let response = serde_json::to_value(MultiSearchPerKbResponse {
                results: per_kb,
                aggregation_strategy: "per_kb".to_string(),
                query: req.query,
                top_k: req.top_k,
                processing_time_ms,
                knowledge_bases_queried: kb_count,
                requested_search_mode: req.search_mode,
            })
            .map_err(|e| AppError::Internal(format!("Serialization error: {}", e)))?;

            Ok(Json(response))
        }
        _ => {
            let merged = merge_multi_kb_results(all_results, req.top_k);

            let response = serde_json::to_value(MultiSearchMergeResponse {
                results: merged,
                aggregation_strategy: "merge".to_string(),
                query: req.query,
                top_k: req.top_k,
                processing_time_ms,
                knowledge_bases_queried: kb_count,
                requested_search_mode: req.search_mode,
                warnings: all_warnings,
            })
            .map_err(|e| AppError::Internal(format!("Serialization error: {}", e)))?;

            Ok(Json(response))
        }
    }
}

/// Merge per-KB result lists into one score-sorted list, tagged with KB id/name.
pub(crate) fn merge_multi_kb_results(
    all_results: Vec<(String, String, Vec<SearchResult>)>,
    top_k: u32,
) -> Vec<SearchResult> {
    let mut merged: Vec<SearchResult> = all_results
        .into_iter()
        .flat_map(|(kb_id, _search_mode, results)| {
            results.into_iter().map(move |mut r| {
                r.knowledge_base_id = Some(kb_id.clone());
                r.knowledge_base_name = Some(kb_id.clone());
                r
            })
        })
        .collect();

    merged.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(top_k as usize);
    merged
}

/// Classify a search error into an appropriate HTTP error with a user-friendly message.
pub(crate) fn classify_search_error(project_id: &str, kb_id: &str, err: anyhow::Error) -> AppError {
    let msg = err.to_string();
    let msg_lower = msg.to_lowercase();

    if msg_lower.contains("not found")
        || msg_lower.contains("does not exist")
        || msg_lower.contains("no such file")
    {
        error!(
            project_id = project_id,
            kb_id = kb_id,
            error = %msg,
            "Knowledge base data not found"
        );
        AppError::NotFound(format!(
            "Knowledge base '{}' data not found. It may not have been processed yet, \
             or the data may have been moved. Try reprocessing the knowledge base.",
            kb_id
        ))
    } else if msg_lower.contains("corrupted") || msg_lower.contains("failed to open table") {
        error!(
            project_id = project_id,
            kb_id = kb_id,
            error = %msg,
            "Knowledge base data appears corrupted"
        );
        AppError::Internal(format!(
            "Knowledge base '{}' data appears corrupted or incomplete. \
             Try reprocessing the knowledge base.",
            kb_id
        ))
    } else if msg_lower.contains("timed out") || msg_lower.contains("timeout") {
        error!(
            project_id = project_id,
            kb_id = kb_id,
            error = %msg,
            "Search timed out"
        );
        AppError::Internal(format!(
            "Search timed out for knowledge base '{}'. The knowledge base may be very large \
             or missing a vector index. Try reprocessing with indexing enabled.",
            kb_id
        ))
    } else {
        error!(
            project_id = project_id,
            kb_id = kb_id,
            error = %msg,
            "Search failed"
        );
        AppError::Internal(format!(
            "Search failed for knowledge base '{}': {}",
            kb_id,
            summarize_error(&err)
        ))
    }
}

/// Create a user-friendly error summary (strips internal paths and stack traces).
pub(crate) fn summarize_error(err: &anyhow::Error) -> String {
    let full = err.to_string();
    // Take only the first meaningful line/sentence
    let summary = full.lines().next().unwrap_or(&full).trim();
    if summary.len() > 200 {
        format!("{}...", &summary[..200])
    } else {
        summary.to_string()
    }
}

/// Map a [`GatewayLookup`] to either the resolved virtual-key token or a
/// per-cause `AppError::ServiceUnavailable`.
///
/// Centralised so the single-KB and multi-KB search handlers emit the same
/// remediation language for the same failure mode. Each branch passes
/// through [`GatewayLookup::diagnostic`] which owns the canonical wording —
/// changing the user-facing string is a one-place edit, not a hunt-across-
/// handlers chore. Returns Ok with the bearer token only when the resolver
/// produced a non-empty `Ready` value; everything else short-circuits the
/// request with a 503.
fn require_vk_token(lookup: &GatewayLookup, project_id: &str) -> Result<String, AppError> {
    match lookup {
        GatewayLookup::Ready(auth) if !auth.virtual_key_token().is_empty() => {
            Ok(auth.virtual_key_token().to_string())
        }
        // Ready with an empty token shouldn't happen — fetch_from_k8s rejects
        // it as EmptyToken before constructing Ready — but if it ever does,
        // treat it as a malformed secret so the surface reflects reality.
        GatewayLookup::Ready(_) => Err(AppError::ServiceUnavailable(
            GatewayLookup::MalformedSecret(
                "Ready variant unexpectedly carries empty virtual_key_token".to_string(),
            )
            .diagnostic(project_id),
        )),
        other => Err(AppError::ServiceUnavailable(other.diagnostic(project_id))),
    }
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
