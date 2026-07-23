use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use tracing::info;

use crate::errors::AppError;
use crate::models::KbMetadataResponse;
use crate::state::AppState;
use crate::store_metadata;

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/api/v1/projects/{projectId}/knowledgebases/{kbId}/metadata",
        get(get_metadata),
    )
}

/// GET /api/v1/projects/{projectId}/knowledgebases/{kbId}/metadata
///
/// Returns KB metadata from the local data mount.
async fn get_metadata(
    State(state): State<AppState>,
    Path((project_id, kb_id)): Path<(String, String)>,
) -> Result<Json<KbMetadataResponse>, AppError> {
    info!("Metadata request: project={}, kb={}", project_id, kb_id);

    if let Some(auth) = state.project_gateway_auth(&project_id).await {
        tracing::debug!(
            project_id = %auth.project_id(),
            llm_gateway = %auth.llm_gateway_url(),
            has_vk_token = !auth.virtual_key_token().is_empty(),
            "project Bifrost credentials resolved"
        );
    }

    let metadata = store_metadata::read_metadata(&state.config, &project_id, &kb_id);

    let lance_table_path = store_metadata::get_lancedb_path(&metadata);
    let lancedb_path =
        state
            .config
            .resolve_lancedb_path(&project_id, &kb_id, lance_table_path.as_deref());

    if metadata.is_none() {
        let kb_dir = state.config.kb_base_dir(&project_id, &kb_id);
        if !kb_dir.exists() {
            return Err(AppError::NotFound(format!(
                "Knowledge base '{}' not found in project '{}'.",
                kb_id, project_id
            )));
        }
    }

    // Resolve embedding model + dim from metadata; fall back to MiniLM
    // defaults when the KB lacks model identity (legacy pre-port KBs).
    let resolved_model = store_metadata::get_embedding_model_name(&metadata);
    // Checked cast: KB metadata is read from S3 / shared FS and could be
    // corrupted, so silently truncating an out-of-range u64 dimension to u32
    // would produce a bad LanceDB schema downstream. Fall back to the MiniLM
    // default on overflow.
    let resolved_dim = metadata
        .as_ref()
        .and_then(|m| m.get("vectorSize"))
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(384);

    let response = KbMetadataResponse {
        knowledge_base_id: kb_id.clone(),
        project_id,
        lancedb_path,
        // `get_embedding_model_name` filters empty values and falls back to
        // DEFAULT_MODEL_NAME, so `resolved_model` is always non-empty here.
        embedding_model: resolved_model,
        vector_size: resolved_dim,
        chunk_count: metadata
            .as_ref()
            .and_then(|m| m.get("chunkCount"))
            .and_then(|v| v.as_u64()),
        document_count: metadata
            .as_ref()
            .and_then(|m| m.get("documentCount"))
            .and_then(|v| v.as_u64()),
        // storageMB + lastProcessedAt moved into the nested `stats` block
        // when the unified-metadata shape landed (KBStats now holds
        // storage-only info). Read from `stats.*` first; fall back to the
        // top-level legacy location so pre-unification KBs still render
        // their stats in the GUI until the next reprocess.
        storage_mb: metadata
            .as_ref()
            .and_then(|m| {
                m.get("stats")
                    .and_then(|s| s.get("storageMB"))
                    .or_else(|| m.get("storageMB"))
            })
            .and_then(|v| v.as_f64()),
        last_processed_at: metadata
            .as_ref()
            .and_then(|m| {
                m.get("stats")
                    .and_then(|s| s.get("lastProcessedAt"))
                    .or_else(|| m.get("lastProcessedAt"))
                    .or_else(|| m.get("updatedAt"))
            })
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        last_processing_mode: metadata
            .as_ref()
            .and_then(|m| m.get("lastProcessingMode"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        indexing_mode: metadata
            .as_ref()
            .and_then(|m| m.get("indexingMode"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    };

    Ok(Json(response))
}
