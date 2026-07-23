use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, info, warn};

use crate::config::Config;

const METADATA_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const METADATA_RETRY_ATTEMPTS: usize = 80;

/// Outcome of a single metadata.json read.
///
/// Lets the retry loop and search handlers tell a not-yet-visible file (a
/// retryable NFS visibility lag) apart from a hard failure — corrupt JSON or a
/// non-ENOENT IO error — that no amount of retrying will fix.
pub(crate) enum MetadataRead {
    Found(serde_json::Value),
    Missing,
    Unreadable,
}

/// Read and parse metadata.json once, classifying the outcome.
///
/// `Missing` is reserved for ENOENT (the file isn't visible yet); parse errors
/// and other IO errors map to `Unreadable` so callers don't mistake them for a
/// transient not-found.
pub(crate) fn read_metadata_once(config: &Config, project_id: &str, kb_id: &str) -> MetadataRead {
    let meta_path = config.metadata_path(project_id, kb_id);

    match std::fs::read_to_string(&meta_path) {
        Ok(content) => match serde_json::from_str(&content) {
            Ok(value) => {
                debug!(
                    project_id = project_id,
                    kb_id = kb_id,
                    "Loaded metadata.json from {}",
                    meta_path.display()
                );
                MetadataRead::Found(value)
            }
            Err(e) => {
                warn!(
                    project_id = project_id,
                    kb_id = kb_id,
                    path = %meta_path.display(),
                    error = %e,
                    "Failed to parse metadata.json — file may be corrupted"
                );
                MetadataRead::Unreadable
            }
        },
        Err(e) if e.kind() == ErrorKind::NotFound => {
            debug!(
                project_id = project_id,
                kb_id = kb_id,
                path = %meta_path.display(),
                "metadata.json is not visible on the data mount yet"
            );
            MetadataRead::Missing
        }
        Err(e) => {
            warn!(
                project_id = project_id,
                kb_id = kb_id,
                path = %meta_path.display(),
                error = %e,
                "Failed to read metadata.json"
            );
            MetadataRead::Unreadable
        }
    }
}

/// Read and parse metadata.json for a knowledge base from the local data mount.
///
/// Returns the parsed JSON value, or None if the file is missing, corrupted, or
/// otherwise unreadable. Callers that need to tell those cases apart (to avoid
/// retrying or 503-ing on a hard error) should use [`read_metadata_once`].
pub fn read_metadata(config: &Config, project_id: &str, kb_id: &str) -> Option<serde_json::Value> {
    match read_metadata_once(config, project_id, kb_id) {
        MetadataRead::Found(value) => Some(value),
        MetadataRead::Missing | MetadataRead::Unreadable => None,
    }
}

/// Wait for metadata written through another NFS mount to become visible.
///
/// The AKS services and workers PVCs reference the same NFSv3 export through
/// separate mounts. Rapid stale-file deletion followed by a worker write can
/// leave the retrieval mount with a negative lookup until its attribute cache
/// refreshes.
pub(crate) async fn read_metadata_with_retry(
    config: &Config,
    project_id: &str,
    kb_id: &str,
) -> MetadataRead {
    for attempt in 0..=METADATA_RETRY_ATTEMPTS {
        match read_metadata_once(config, project_id, kb_id) {
            MetadataRead::Found(metadata) => {
                if attempt > 0 {
                    info!(
                        project_id = project_id,
                        kb_id = kb_id,
                        attempt,
                        "metadata.json became visible after retry"
                    );
                }
                return MetadataRead::Found(metadata);
            }
            // A corrupt/unreadable file won't become valid by waiting, so fail
            // fast instead of spinning the whole retry window on a hard error.
            MetadataRead::Unreadable => return MetadataRead::Unreadable,
            MetadataRead::Missing => {}
        }
        if attempt < METADATA_RETRY_ATTEMPTS {
            sleep(METADATA_RETRY_INTERVAL).await;
        }
    }

    // ponytail: bounded 20s wait covers the observed NFSv3 cache delay;
    // make it configurable only if a slower storage backend requires it.
    warn!(
        project_id = project_id,
        kb_id = kb_id,
        retry_seconds = METADATA_RETRY_INTERVAL.as_secs_f64() * METADATA_RETRY_ATTEMPTS as f64,
        "metadata.json is still not visible after retries"
    );
    MetadataRead::Missing
}

/// Extract the LanceDB table path from metadata.
///
/// Reads `lanceTablePath` from metadata.json (written by the KB processor after merge).
/// Returns `None` if not present or empty.
pub fn get_lancedb_path(metadata: &Option<serde_json::Value>) -> Option<String> {
    metadata
        .as_ref()
        .and_then(|m| m.get("lanceTablePath"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Resolve the embedding model name used at indexing time.
///
/// Preference order — Bifrost wire identifier first so the project VK's
/// `allowed_models[]` enforcement matches:
///   1. `embeddingGatewayModelId` (`<provider>/<gatewayBindingName>` — current)
///   2. `providerModelId`         (raw upstream model id — current)
///   3. `embeddingProviderModelId` (interim alias, same meaning as 2)
///   4. `embeddingModel`          (legacy string field; pre-port KBs only)
///
/// Falls back to [`crate::embedding::DEFAULT_MODEL_NAME`] (MiniLM) when
/// metadata is absent or carries no model identity — Bifrost will route
/// the default to the in-cluster TEI Service for pre-port KBs that were
/// indexed with MiniLM in-process.
pub fn get_embedding_model_name(metadata: &Option<serde_json::Value>) -> String {
    // Prefer the Bifrost wire identifier (`<provider>/<gatewayBindingName>`)
    // because the project virtual-key's allowed_models[] matches against the
    // binding name, not the raw provider model id. Without this we 403 with
    // "model_blocked / not allowed for this virtual key" — exactly the failure
    // mode the indexing path hit before kb-processor was taught to send
    // gatewayModelId. Fall back to providerModelId / embeddingProviderModelId
    // / embeddingModel for legacy KBs whose metadata.json pre-dates the
    // embeddingGatewayModelId field.
    for field in [
        "embeddingGatewayModelId",
        "providerModelId",
        "embeddingProviderModelId",
        "embeddingModel",
    ] {
        if let Some(v) = metadata
            .as_ref()
            .and_then(|m| m.get(field))
            .and_then(|v| v.as_str())
            && !v.is_empty()
        {
            return v.to_string();
        }
    }
    crate::embedding::DEFAULT_MODEL_NAME.to_string()
}

/// Extract the indexing mode from metadata, defaulting to "vector" if not present.
pub fn get_indexing_mode(metadata: &Option<serde_json::Value>) -> String {
    metadata
        .as_ref()
        .and_then(|m| m.get("indexingMode"))
        .and_then(|v| v.as_str())
        .unwrap_or("vector")
        .to_string()
}

/// Resolve the effective search mode based on request and metadata.
///
/// 1. If explicitly provided in the request, use it (if valid).
/// 2. Otherwise derive from the KB's indexingMode.
/// 3. Fallback: "vector".
pub fn resolve_search_mode(requested: &Option<String>, indexing_mode: &str) -> String {
    if let Some(mode) = requested {
        let m = mode.to_lowercase();
        if m == "vector" || m == "fts" || m == "hybrid" {
            return m;
        }
    }

    match indexing_mode {
        "hybrid" => "hybrid".to_string(),
        "semantic" => "vector".to_string(),
        "fts" => "fts".to_string(),
        _ => "vector".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Query parameter reconciliation
// ---------------------------------------------------------------------------

/// Resolved query parameters after reconciling the caller's request against
/// the KB's actual capabilities (from metadata.json).
#[derive(Debug, Clone)]
pub struct ResolvedQuery {
    pub search_mode: String,
    pub distance_metric: String,
    pub nprobe: Option<u32>,
    pub refine_factor: Option<u32>,
    /// Caller-visible warnings when fallbacks are applied.
    pub warnings: Vec<String>,
}

/// Reconcile requested search parameters against KB capabilities recorded in
/// metadata.json. Returns resolved parameters with warnings for any fallbacks.
///
/// Capability fields in metadata are optional. When absent (legacy KBs), the
/// resolver passes parameters through unchanged (no warnings, no regression).
pub fn resolve_query_params(
    requested_search_mode: &Option<String>,
    requested_distance_metric: &str,
    requested_nprobe: Option<u32>,
    requested_refine_factor: Option<u32>,
    metadata: &Option<serde_json::Value>,
) -> ResolvedQuery {
    let mut warnings: Vec<String> = Vec::new();

    let indexing_mode = get_indexing_mode(metadata);

    // --- search mode ---
    let mut search_mode = resolve_search_mode(requested_search_mode, &indexing_mode);

    let has_fts_index = get_opt_bool(metadata, "hasFtsIndex")
        .unwrap_or(matches!(indexing_mode.as_str(), "hybrid" | "fts"));

    if (search_mode == "hybrid" || search_mode == "fts") && !has_fts_index {
        warnings.push(format!(
            "Requested search mode '{}' requires an FTS index, but this KB does not have one. Falling back to 'vector'.",
            search_mode,
        ));
        search_mode = "vector".to_string();
    }

    // --- distance metric ---
    let has_vector_index = get_opt_bool(metadata, "hasVectorIndex");
    let vector_index_metric = get_opt_string(metadata, "vectorIndexMetric");

    let distance_metric;
    if let (Some(true), Some(idx_metric)) = (has_vector_index, &vector_index_metric) {
        if !requested_distance_metric.eq_ignore_ascii_case(idx_metric) {
            warnings.push(format!(
                "Requested distance metric '{}' is incompatible with this KB's vector index (built with '{}'). \
                 Using '{}' to avoid brute-force fallback. Rebuild the KB with a '{}' index if you need it.",
                requested_distance_metric, idx_metric, idx_metric, requested_distance_metric,
            ));
            distance_metric = idx_metric.clone();
        } else {
            distance_metric = requested_distance_metric.to_string();
        }
    } else {
        distance_metric = requested_distance_metric.to_string();
    }

    // --- nprobe / refine_factor ---
    let nprobe;
    let refine_factor;
    if has_vector_index == Some(false) {
        nprobe = None;
        refine_factor = None;
        if requested_nprobe.is_some() || requested_refine_factor.is_some() {
            debug!("Dropping nprobe/refine_factor: KB has no vector index (brute-force scan)");
        }
    } else {
        nprobe = requested_nprobe;
        refine_factor = requested_refine_factor;
    }

    ResolvedQuery {
        search_mode,
        distance_metric,
        nprobe,
        refine_factor,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Download URL enrichment
// ---------------------------------------------------------------------------

/// Enrich search results with download URLs when S3_PUBLIC_ENDPOINT is configured.
pub fn enrich_download_urls(results: &mut [crate::models::SearchResult], config: &Config) {
    let public_endpoint = match &config.s3_public_endpoint {
        Some(ep) => ep,
        None => return,
    };

    for result in results.iter_mut() {
        // Nested if rather than an `if let` chain — see note in
        // observability.rs for why we keep the nested form.
        #[allow(clippy::collapsible_if)]
        if let Some(file_path) = result.metadata.get("file_path").and_then(|v| v.as_str()) {
            if !file_path.is_empty() {
                result.download_url = Some(format!(
                    "{}/{}/{}",
                    public_endpoint.trim_end_matches('/'),
                    config.default_bucket_name,
                    file_path
                ));
            }
        }
    }
}

/// Validate that the data mount directory exists and is accessible.
/// Called at startup to fail fast with a clear message.
pub fn validate_data_mount(config: &Config) -> Result<(), String> {
    let root = Path::new(&config.data_root);
    if !root.exists() {
        return Err(format!(
            "Data mount '{}' does not exist. Set NEMO_DEFAULT_STORE_ROOT to the default PVC mount path.",
            config.data_root
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "Data mount '{}' exists but is not a directory.",
            config.data_root
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Metadata field helpers
// ---------------------------------------------------------------------------

fn get_opt_bool(metadata: &Option<serde_json::Value>, field: &str) -> Option<bool> {
    metadata
        .as_ref()
        .and_then(|m| m.get(field))
        .and_then(|v| v.as_bool())
}

fn get_opt_string(metadata: &Option<serde_json::Value>, field: &str) -> Option<String> {
    metadata
        .as_ref()
        .and_then(|m| m.get(field))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

#[cfg(test)]
#[path = "store_metadata_tests.rs"]
mod tests;
