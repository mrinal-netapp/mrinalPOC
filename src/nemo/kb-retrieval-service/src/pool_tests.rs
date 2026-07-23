use super::*;
use std::sync::atomic::Ordering;

// -----------------------------------------------------------------------
// PoolStats tests
// -----------------------------------------------------------------------

#[test]
fn test_pool_stats_new() {
    let stats = PoolStats::new();
    assert_eq!(stats.hits.load(Ordering::Relaxed), 0);
    assert_eq!(stats.misses.load(Ordering::Relaxed), 0);
    assert_eq!(stats.evictions.load(Ordering::Relaxed), 0);
}

#[test]
fn test_pool_stats_hit_rate_no_requests() {
    let stats = PoolStats::new();
    assert_eq!(stats.hit_rate(), 0.0);
}

#[test]
fn test_pool_stats_hit_rate_all_hits() {
    let stats = PoolStats::new();
    stats.hits.store(100, Ordering::Relaxed);
    stats.misses.store(0, Ordering::Relaxed);
    assert!((stats.hit_rate() - 100.0).abs() < 1e-9);
}

#[test]
fn test_pool_stats_hit_rate_all_misses() {
    let stats = PoolStats::new();
    stats.hits.store(0, Ordering::Relaxed);
    stats.misses.store(100, Ordering::Relaxed);
    assert_eq!(stats.hit_rate(), 0.0);
}

#[test]
fn test_pool_stats_hit_rate_mixed() {
    let stats = PoolStats::new();
    stats.hits.store(75, Ordering::Relaxed);
    stats.misses.store(25, Ordering::Relaxed);
    assert!((stats.hit_rate() - 75.0).abs() < 1e-9);
}

#[test]
fn test_pool_stats_hit_rate_50_50() {
    let stats = PoolStats::new();
    stats.hits.store(50, Ordering::Relaxed);
    stats.misses.store(50, Ordering::Relaxed);
    assert!((stats.hit_rate() - 50.0).abs() < 1e-9);
}

// -----------------------------------------------------------------------
// is_stale_connection_error tests
// -----------------------------------------------------------------------

#[test]
fn test_is_stale_error_nosuchkey() {
    let err = anyhow::anyhow!("AWS error: NoSuchKey");
    assert!(ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_stale_error_not_found() {
    let err = anyhow::anyhow!("Table not found in LanceDB");
    assert!(ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_stale_error_does_not_exist() {
    let err = anyhow::anyhow!("The specified key does not exist");
    assert!(ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_stale_error_no_such_file() {
    let err = anyhow::anyhow!("No such file or directory");
    assert!(ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_stale_error_object_not_found() {
    let err = anyhow::anyhow!("Object not found: s3://bucket/path");
    assert!(ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_not_stale_error_timeout() {
    let err = anyhow::anyhow!("Connection timeout after 30s");
    assert!(!ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_not_stale_error_auth() {
    let err = anyhow::anyhow!("Access denied: invalid credentials");
    assert!(!ConnectionPool::is_stale_connection_error(&err));
}

#[test]
fn test_is_not_stale_error_generic() {
    let err = anyhow::anyhow!("Something went wrong");
    assert!(!ConnectionPool::is_stale_connection_error(&err));
}

// -----------------------------------------------------------------------
// ConnectionPool basic tests (no filesystem dependency)
// -----------------------------------------------------------------------

fn test_config() -> Arc<Config> {
    Arc::new(Config {
        port: 5000,
        data_root: "/mnt/pvcs/test-bucket".to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    })
}

#[test]
fn test_pool_new() {
    let config = test_config();
    let pool = ConnectionPool::new(config.clone());
    assert_eq!(pool.size(), 0);
    assert_eq!(pool.max_size(), 10);
}

#[test]
fn test_pool_stats_initial() {
    let config = test_config();
    let pool = ConnectionPool::new(config);
    assert_eq!(pool.stats.hits.load(Ordering::Relaxed), 0);
    assert_eq!(pool.stats.misses.load(Ordering::Relaxed), 0);
    assert_eq!(pool.stats.evictions.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn test_get_table_errors_when_kb_directory_missing() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config = Arc::new(Config {
        data_root: tmp.path().to_string_lossy().to_string(),
        default_bucket_name: "test-bucket".to_string(),
        pool_max_size: 5,
        pool_ttl_seconds: 60,
        ..test_config().as_ref().clone()
    });
    let pool = ConnectionPool::new(config);
    let err = pool
        .get_table("proj1", "kb-missing", "/no/lancedb/path")
        .await
        .expect_err("expected missing KB dir");
    let msg = err.to_string();
    assert!(
        msg.contains("does not exist") || msg.contains("Verify the project"),
        "unexpected error: {msg}"
    );
    assert_eq!(pool.stats.misses.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn test_get_table_errors_when_lancedb_path_missing_but_kb_exists() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let data_root = tmp.path().to_string_lossy().to_string();
    let config = Arc::new(Config {
        data_root: data_root.clone(),
        default_bucket_name: "test-bucket".to_string(),
        pool_max_size: 5,
        pool_ttl_seconds: 60,
        ..test_config().as_ref().clone()
    });
    let kb_dir = config.kb_base_dir("proj1", "kb1");
    std::fs::create_dir_all(&kb_dir).expect("create kb dir");

    let pool = ConnectionPool::new(config);
    let missing_lance = tmp
        .path()
        .join("no-lancedb-run")
        .to_string_lossy()
        .to_string();
    let err = pool
        .get_table("proj1", "kb1", &missing_lance)
        .await
        .expect_err("expected missing LanceDB path");
    let msg = err.to_string();
    assert!(
        msg.contains("LanceDB directory") || msg.contains("not found"),
        "unexpected error: {msg}"
    );
}
