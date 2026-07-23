use anyhow::{Context, Result};
use lancedb::table::Table;
use moka::future::Cache;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::config::Config;

/// LanceDB connection pool — LRU+TTL cache of Table handles keyed by kb_id.
///
/// Each table handle is a connection to a specific KB's LanceDB data on the
/// shared data mount. Stale connections (e.g. table not found after reprocess)
/// are evicted and retried once.
pub struct ConnectionPool {
    cache: Cache<String, Table>,
    config: Arc<Config>,
    pub stats: Arc<PoolStats>,
}

/// Atomic counters for pool statistics.
pub struct PoolStats {
    pub hits: AtomicU64,
    pub misses: AtomicU64,
    pub evictions: AtomicU64,
}

impl Default for PoolStats {
    fn default() -> Self {
        Self::new()
    }
}

impl PoolStats {
    pub fn new() -> Self {
        Self {
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            evictions: AtomicU64::new(0),
        }
    }

    /// Hit-rate percentage. Used by the legacy JSON metrics path
    /// (`AppState::get_metrics`) and exercised in unit tests.
    #[allow(dead_code)]
    pub fn hit_rate(&self) -> f64 {
        let hits = self.hits.load(Ordering::Relaxed);
        let misses = self.misses.load(Ordering::Relaxed);
        let total = hits + misses;
        if total == 0 {
            0.0
        } else {
            (hits as f64 / total as f64) * 100.0
        }
    }
}

impl ConnectionPool {
    /// Create a new connection pool with the given configuration.
    pub fn new(config: Arc<Config>) -> Self {
        let stats = Arc::new(PoolStats::new());
        let eviction_stats = stats.clone();

        let cache = Cache::builder()
            .max_capacity(config.pool_max_size)
            .time_to_live(Duration::from_secs(config.pool_ttl_seconds))
            .eviction_listener(move |_key, _value, _cause| {
                eviction_stats.evictions.fetch_add(1, Ordering::Relaxed);
            })
            .build();

        Self {
            cache,
            config,
            stats,
        }
    }

    /// Get a LanceDB Table for the given project/KB, with caching and retry.
    ///
    /// On cache miss, opens the `kb_vectors` table from the data mount.
    /// On "stale connection" errors (table not found, etc.), evicts the
    /// cached entry and retries once.
    ///
    /// `lancedb_path`: Resolved LanceDB directory path (from metadata or fallback).
    pub async fn get_table(
        &self,
        project_id: &str,
        kb_id: &str,
        lancedb_path: &str,
    ) -> Result<Table> {
        let cache_key = format!("{}:{}:{}", project_id, kb_id, lancedb_path);

        if let Some(table) = self.cache.get(&cache_key).await {
            self.stats.hits.fetch_add(1, Ordering::Relaxed);
            debug!("Pool cache hit for {}", cache_key);
            return Ok(table);
        }

        self.stats.misses.fetch_add(1, Ordering::Relaxed);
        debug!("Pool cache miss for {}", cache_key);

        let table = self.connect_table(project_id, kb_id, lancedb_path).await?;
        self.cache.insert(cache_key, table.clone()).await;
        Ok(table)
    }

    /// Execute an operation with retry on stale connection errors.
    ///
    /// If the operation fails with a stale-connection error, evicts the cache
    /// entry, reconnects, and retries once.
    pub async fn execute_with_retry<F, Fut, T>(
        &self,
        project_id: &str,
        kb_id: &str,
        lancedb_path: &str,
        operation: F,
    ) -> Result<T>
    where
        F: Fn(Table) -> Fut + Send,
        Fut: std::future::Future<Output = Result<T>> + Send,
    {
        let table = self.get_table(project_id, kb_id, lancedb_path).await?;

        match operation(table).await {
            Ok(result) => Ok(result),
            Err(err) => {
                if Self::is_stale_connection_error(&err) {
                    warn!(
                        "Stale connection for {}:{}, evicting and retrying: {}",
                        project_id, kb_id, err
                    );
                    let cache_key = format!("{}:{}:{}", project_id, kb_id, lancedb_path);
                    self.cache.invalidate(&cache_key).await;

                    tokio::time::sleep(Duration::from_millis(500)).await;

                    let table = self.connect_table(project_id, kb_id, lancedb_path).await?;
                    self.cache.insert(cache_key, table.clone()).await;
                    operation(table).await
                } else {
                    Err(err)
                }
            }
        }
    }

    /// Connect to LanceDB at the resolved path and open the kb_vectors table.
    async fn connect_table(
        &self,
        project_id: &str,
        kb_id: &str,
        lancedb_path: &str,
    ) -> Result<Table> {
        let path = std::path::Path::new(lancedb_path);
        if !path.exists() {
            let kb_dir = self.config.kb_base_dir(project_id, kb_id);
            if kb_dir.exists() {
                let entries: Vec<String> = std::fs::read_dir(&kb_dir)
                    .map(|rd| {
                        rd.filter_map(|e| e.ok())
                            .map(|e| e.file_name().to_string_lossy().to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                anyhow::bail!(
                    "LanceDB directory '{}' not found. KB directory exists with: [{}]. \
                     The knowledge base may need to be reprocessed.",
                    lancedb_path,
                    entries.join(", ")
                );
            } else {
                anyhow::bail!(
                    "Knowledge base directory '{}' does not exist. \
                     Verify the project and KB IDs are correct.",
                    kb_dir.display()
                );
            }
        }

        info!("Connecting to LanceDB at: {}", lancedb_path);

        let db = lancedb::connect(lancedb_path)
            .execute()
            .await
            .with_context(|| format!("Failed to connect to LanceDB at {}", lancedb_path))?;

        let table = db
            .open_table("kb_vectors")
            .execute()
            .await
            .with_context(|| {
                format!(
                    "Failed to open table 'kb_vectors' at {}. \
                     The LanceDB data may be corrupted or incomplete — try reprocessing the knowledge base.",
                    lancedb_path
                )
            })?;

        info!(
            "Successfully opened LanceDB table for {}:{} at {}",
            project_id, kb_id, lancedb_path
        );
        Ok(table)
    }

    /// Check if an error indicates a stale connection that should be retried.
    fn is_stale_connection_error(err: &anyhow::Error) -> bool {
        let msg = err.to_string().to_lowercase();
        msg.contains("nosuchkey")
            || msg.contains("not found")
            || msg.contains("does not exist")
            || msg.contains("table not found")
            || msg.contains("no such file")
            || msg.contains("object not found")
    }

    /// Evict a specific cache entry.
    #[allow(dead_code)]
    pub async fn evict(&self, project_id: &str, kb_id: &str) {
        let cache_key = format!("{}:{}", project_id, kb_id);
        self.cache.invalidate(&cache_key).await;
    }

    /// Get the current number of cached entries.
    pub fn size(&self) -> u64 {
        self.cache.entry_count()
    }

    /// Get the max pool size. Used by the legacy JSON metrics path
    /// (`AppState::get_metrics`).
    #[allow(dead_code)]
    pub fn max_size(&self) -> u64 {
        self.config.pool_max_size
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
