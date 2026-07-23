use std::env;
use std::path::PathBuf;

/// Application configuration loaded from environment variables.
#[derive(Clone, Debug)]
pub struct Config {
    /// Server port (default: 5000)
    pub port: u16,
    /// Root of the shared data mount where KB data lives.
    /// Layout mirrors `s3://{bucket}/` — e.g. `{data_root}/projects/{pid}/knowledgebases/{kbid}/`.
    pub data_root: String,
    /// Public S3 endpoint for download URLs (optional, enables `downloadUrl` enrichment on results)
    pub s3_public_endpoint: Option<String>,
    /// S3 bucket name used only for constructing public download URLs
    pub default_bucket_name: String,
    /// Max connection pool size (default: 50)
    pub pool_max_size: u64,
    /// Connection pool TTL in seconds (default: 3600)
    pub pool_ttl_seconds: u64,
    /// Enable debug logging
    pub debug: bool,
    /// K8s namespace for project virtual-key Secrets (default: `nemo` / `agentstudio`).
    pub k8s_namespace: String,
    /// Bifrost base URL (no path suffix), for future gateway-backed embeddings.
    pub llm_gateway_url: String,
    /// Cache TTL for resolved project virtual keys (seconds).
    pub project_gateway_cache_ttl_secs: u64,
}

impl Config {
    /// Load configuration from environment variables with sensible defaults.
    pub fn from_env() -> Self {
        let data_root = env::var("NEMO_DEFAULT_STORE_ROOT")
            .or_else(|_| env::var("DATA_ROOT"))
            .unwrap_or_else(|_| {
                let bucket =
                    env::var("DEFAULT_BUCKET_NAME").unwrap_or_else(|_| "default-nemo".to_string());
                format!("/mnt/pvcs/{}", bucket)
            });

        Self {
            port: env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(5000),
            data_root,
            s3_public_endpoint: env::var("S3_PUBLIC_ENDPOINT").ok(),
            default_bucket_name: env::var("DEFAULT_BUCKET_NAME")
                .unwrap_or_else(|_| "default-nemo".to_string()),
            pool_max_size: env::var("POOL_MAX_SIZE")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(50),
            pool_ttl_seconds: env::var("POOL_TTL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3600),
            debug: env::var("DEBUG")
                .map(|v| v == "true" || v == "1")
                .unwrap_or(false),
            k8s_namespace: env::var("K8S_NAMESPACE")
                .or_else(|_| env::var("NAMESPACE"))
                .or_else(|_| env::var("SERVICES_NAMESPACE"))
                .unwrap_or_else(|_| "nemo".to_string()),
            llm_gateway_url: env::var("LLM_GATEWAY_URL")
                .unwrap_or_else(|_| "http://bifrost-proxy:8080".to_string())
                .trim_end_matches('/')
                .to_string(),
            project_gateway_cache_ttl_secs: env::var("PROJECT_GATEWAY_CACHE_TTL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(300),
        }
    }

    /// Base directory for a knowledge base's data on the shared mount.
    pub fn kb_base_dir(&self, project_id: &str, kb_id: &str) -> PathBuf {
        PathBuf::from(&self.data_root)
            .join("projects")
            .join(project_id)
            .join("knowledgebases")
            .join(kb_id)
    }

    /// Path to the metadata.json file for a knowledge base.
    pub fn metadata_path(&self, project_id: &str, kb_id: &str) -> PathBuf {
        self.kb_base_dir(project_id, kb_id).join("metadata.json")
    }

    /// Resolve the LanceDB directory for a knowledge base.
    ///
    /// Reads `lanceTablePath` from metadata.json if available (versioned blue-green path).
    /// Falls back to the legacy `lancedb/` convention directory.
    ///
    /// If `lanceTablePath` is an `s3://` URI referencing the default bucket,
    /// it is mapped to the local mount path.
    pub fn resolve_lancedb_path(
        &self,
        project_id: &str,
        kb_id: &str,
        lance_table_path: Option<&str>,
    ) -> String {
        if let Some(raw) = lance_table_path {
            return self.normalize_path(raw);
        }
        self.kb_base_dir(project_id, kb_id)
            .join("lancedb")
            .to_string_lossy()
            .to_string()
    }

    /// Normalize a path that may be an s3:// URI into a POSIX path on the data mount.
    /// POSIX paths are returned as-is.
    pub fn normalize_path(&self, raw: &str) -> String {
        let raw = raw.trim();
        if raw.starts_with('/') {
            return raw.to_string();
        }
        let prefix = format!("s3://{}/", self.default_bucket_name);
        if raw.starts_with(&prefix) {
            let rest = raw.strip_prefix(&prefix).unwrap_or("");
            PathBuf::from(&self.data_root)
                .join(rest)
                .to_string_lossy()
                .to_string()
        } else {
            raw.to_string()
        }
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
