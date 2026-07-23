use super::*;

fn test_config() -> Config {
    Config {
        port: 5000,
        data_root: "/mnt/pvcs/default-nemo".to_string(),
        default_bucket_name: "default-nemo".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 50,
        pool_ttl_seconds: 3600,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    }
}

#[test]
fn test_kb_base_dir() {
    let cfg = test_config();
    let p = cfg.kb_base_dir("proj1", "kb99");
    assert_eq!(
        p.to_str().unwrap(),
        "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb99"
    );
}

#[test]
fn test_metadata_path() {
    let cfg = test_config();
    let p = cfg.metadata_path("proj1", "kb99");
    assert_eq!(
        p.to_str().unwrap(),
        "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb99/metadata.json"
    );
}

#[test]
fn test_resolve_lancedb_path_with_override_posix() {
    let cfg = test_config();
    let p = cfg.resolve_lancedb_path(
        "proj1",
        "kb1",
        Some("/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb1/lancedb-run-abc"),
    );
    assert_eq!(
        p,
        "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb1/lancedb-run-abc"
    );
}

#[test]
fn test_resolve_lancedb_path_with_override_s3_uri() {
    let cfg = test_config();
    let p = cfg.resolve_lancedb_path(
        "proj1",
        "kb1",
        Some("s3://default-nemo/projects/proj1/knowledgebases/kb1/lancedb-run-abc"),
    );
    assert_eq!(
        p,
        "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb1/lancedb-run-abc"
    );
}

#[test]
fn test_resolve_lancedb_path_fallback_legacy() {
    let cfg = test_config();
    let p = cfg.resolve_lancedb_path("proj1", "kb1", None);
    assert_eq!(
        p,
        "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb1/lancedb"
    );
}

#[test]
fn test_normalize_path_posix_passthrough() {
    let cfg = test_config();
    assert_eq!(
        cfg.normalize_path("/mnt/pvcs/default-nemo/projects/p1/x"),
        "/mnt/pvcs/default-nemo/projects/p1/x"
    );
}

#[test]
fn test_normalize_path_s3_to_posix() {
    let cfg = test_config();
    assert_eq!(
        cfg.normalize_path("s3://default-nemo/projects/p1/knowledgebases/kb1/lancedb-run-abc"),
        "/mnt/pvcs/default-nemo/projects/p1/knowledgebases/kb1/lancedb-run-abc"
    );
}

#[test]
fn test_normalize_path_other_bucket_unchanged() {
    let cfg = test_config();
    assert_eq!(
        cfg.normalize_path("s3://other-bucket/projects/p1/k/x"),
        "s3://other-bucket/projects/p1/k/x"
    );
}

#[test]
fn test_normalize_path_trims_whitespace() {
    let cfg = test_config();
    assert_eq!(
        cfg.normalize_path("  /mnt/pvcs/default-nemo/projects/p1/x  "),
        "/mnt/pvcs/default-nemo/projects/p1/x"
    );
}

// Serialise env mutation — `Config::from_env` reads process environment.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn test_from_env_port_and_debug() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var("PORT", "9090");
        std::env::set_var("DEBUG", "true");
    }
    let cfg = Config::from_env();
    assert_eq!(cfg.port, 9090);
    assert!(cfg.debug);
    unsafe {
        std::env::remove_var("PORT");
        std::env::remove_var("DEBUG");
    }
}

#[test]
fn test_from_env_data_root_nemo_default_store_root() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var("NEMO_DEFAULT_STORE_ROOT", "/custom/mount");
        std::env::remove_var("DATA_ROOT");
    }
    let cfg = Config::from_env();
    assert_eq!(cfg.data_root, "/custom/mount");
    unsafe {
        std::env::remove_var("NEMO_DEFAULT_STORE_ROOT");
    }
}

#[test]
fn test_from_env_pool_settings() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var("POOL_MAX_SIZE", "99");
        std::env::set_var("POOL_TTL_SECONDS", "120");
    }
    let cfg = Config::from_env();
    assert_eq!(cfg.pool_max_size, 99);
    assert_eq!(cfg.pool_ttl_seconds, 120);
    unsafe {
        std::env::remove_var("POOL_MAX_SIZE");
        std::env::remove_var("POOL_TTL_SECONDS");
    }
}
