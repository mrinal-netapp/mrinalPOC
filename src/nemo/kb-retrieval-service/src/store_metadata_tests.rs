use super::*;
use crate::models::SearchResult;
use serde_json::json;

fn test_config_with_public_endpoint() -> Config {
    Config {
        port: 5000,
        data_root: "/mnt/pvcs/default-nemo".to_string(),
        default_bucket_name: "my-bucket".to_string(),
        s3_public_endpoint: Some("https://cdn.example.com".to_string()),
        pool_max_size: 50,
        pool_ttl_seconds: 3600,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    }
}

fn test_config_no_public_endpoint() -> Config {
    let mut c = test_config_with_public_endpoint();
    c.s3_public_endpoint = None;
    c
}

fn make_search_result(metadata: serde_json::Value) -> SearchResult {
    SearchResult {
        id: "chunk-1".to_string(),
        document_id: "doc-1".to_string(),
        source: "file.pdf".to_string(),
        text: "some text".to_string(),
        chunk_index: 0,
        score: 0.9,
        metadata,
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    }
}

// -----------------------------------------------------------------------
// read_metadata (filesystem)
// -----------------------------------------------------------------------

#[test]
fn test_read_metadata_missing_dir() {
    let cfg = Config {
        data_root: "/nonexistent-test-path".to_string(),
        ..test_config_with_public_endpoint()
    };
    let result = read_metadata(&cfg, "proj1", "kb1");
    assert!(result.is_none());
}

// -----------------------------------------------------------------------
// get_lancedb_path
// -----------------------------------------------------------------------

#[test]
fn test_get_lancedb_path_canonical_field() {
    let meta = Some(
        json!({"lanceTablePath": "/mnt/pvcs/default-nemo/projects/p1/knowledgebases/kb1/lancedb-run-abc"}),
    );
    assert_eq!(
        get_lancedb_path(&meta),
        Some("/mnt/pvcs/default-nemo/projects/p1/knowledgebases/kb1/lancedb-run-abc".to_string())
    );
}

#[test]
fn test_get_lancedb_path_s3_uri() {
    let meta = Some(
        json!({"lanceTablePath": "s3://bucket/projects/p1/knowledgebases/kb1/lancedb-20260217-204654"}),
    );
    assert_eq!(
        get_lancedb_path(&meta),
        Some("s3://bucket/projects/p1/knowledgebases/kb1/lancedb-20260217-204654".to_string())
    );
}

#[test]
fn test_get_lancedb_path_uses_only_lance_table_path() {
    let meta = Some(json!({
        "lanceTablePath": "/mnt/pvcs/default-nemo/new-versioned-path",
        "lancedbPath": "/mnt/pvcs/default-nemo/old-legacy-path"
    }));
    assert_eq!(
        get_lancedb_path(&meta),
        Some("/mnt/pvcs/default-nemo/new-versioned-path".to_string())
    );
}

#[test]
fn test_get_lancedb_path_lancedb_path_ignored() {
    let meta = Some(json!({"lancedbPath": "/mnt/pvcs/default-nemo/legacy-path"}));
    assert_eq!(get_lancedb_path(&meta), None);
}

#[test]
fn test_get_lancedb_path_empty_string() {
    let meta = Some(json!({"lanceTablePath": ""}));
    assert_eq!(get_lancedb_path(&meta), None);
}

#[test]
fn test_get_lancedb_path_missing_key() {
    let meta = Some(json!({"indexingMode": "hybrid"}));
    assert_eq!(get_lancedb_path(&meta), None);
}

#[test]
fn test_get_lancedb_path_none_metadata() {
    assert_eq!(get_lancedb_path(&None), None);
}

#[test]
fn test_get_lancedb_path_null_value() {
    let meta = Some(json!({"lanceTablePath": null}));
    assert_eq!(get_lancedb_path(&meta), None);
}

// -----------------------------------------------------------------------
// get_indexing_mode
// -----------------------------------------------------------------------

#[test]
fn test_get_indexing_mode_present() {
    let meta = Some(json!({"indexingMode": "hybrid"}));
    assert_eq!(get_indexing_mode(&meta), "hybrid");
}

#[test]
fn test_get_indexing_mode_semantic() {
    let meta = Some(json!({"indexingMode": "semantic"}));
    assert_eq!(get_indexing_mode(&meta), "semantic");
}

#[test]
fn test_get_indexing_mode_fts() {
    let meta = Some(json!({"indexingMode": "fts"}));
    assert_eq!(get_indexing_mode(&meta), "fts");
}

#[test]
fn test_get_indexing_mode_missing_key() {
    let meta = Some(json!({"otherField": "value"}));
    assert_eq!(get_indexing_mode(&meta), "vector");
}

#[test]
fn test_get_indexing_mode_none_metadata() {
    assert_eq!(get_indexing_mode(&None), "vector");
}

#[test]
fn test_get_indexing_mode_null_value() {
    let meta = Some(json!({"indexingMode": null}));
    assert_eq!(get_indexing_mode(&meta), "vector");
}

// -----------------------------------------------------------------------
// resolve_search_mode
// -----------------------------------------------------------------------

#[test]
fn test_resolve_search_mode_explicit_vector() {
    assert_eq!(
        resolve_search_mode(&Some("vector".to_string()), "hybrid"),
        "vector"
    );
}

#[test]
fn test_resolve_search_mode_explicit_fts() {
    assert_eq!(
        resolve_search_mode(&Some("fts".to_string()), "vector"),
        "fts"
    );
}

#[test]
fn test_resolve_search_mode_explicit_hybrid() {
    assert_eq!(
        resolve_search_mode(&Some("hybrid".to_string()), "vector"),
        "hybrid"
    );
}

#[test]
fn test_resolve_search_mode_explicit_case_insensitive() {
    assert_eq!(
        resolve_search_mode(&Some("VECTOR".to_string()), "fts"),
        "vector"
    );
    assert_eq!(
        resolve_search_mode(&Some("FTS".to_string()), "vector"),
        "fts"
    );
    assert_eq!(
        resolve_search_mode(&Some("Hybrid".to_string()), "vector"),
        "hybrid"
    );
}

#[test]
fn test_resolve_search_mode_invalid_explicit_falls_through() {
    assert_eq!(
        resolve_search_mode(&Some("invalid".to_string()), "hybrid"),
        "hybrid"
    );
    assert_eq!(
        resolve_search_mode(&Some("random".to_string()), "fts"),
        "fts"
    );
}

#[test]
fn test_resolve_search_mode_none_uses_indexing_mode() {
    assert_eq!(resolve_search_mode(&None, "hybrid"), "hybrid");
    assert_eq!(resolve_search_mode(&None, "semantic"), "vector");
    assert_eq!(resolve_search_mode(&None, "fts"), "fts");
    assert_eq!(resolve_search_mode(&None, "vector"), "vector");
}

#[test]
fn test_resolve_search_mode_unknown_indexing_defaults_vector() {
    assert_eq!(resolve_search_mode(&None, "unknown"), "vector");
    assert_eq!(resolve_search_mode(&None, ""), "vector");
}

// -----------------------------------------------------------------------
// enrich_download_urls
// -----------------------------------------------------------------------

#[test]
fn test_enrich_download_urls_with_public_endpoint() {
    let config = test_config_with_public_endpoint();
    let mut results = vec![make_search_result(
        json!({"file_path": "projects/p1/files/doc.pdf"}),
    )];
    enrich_download_urls(&mut results, &config);
    assert_eq!(
        results[0].download_url.as_deref(),
        Some("https://cdn.example.com/my-bucket/projects/p1/files/doc.pdf")
    );
}

#[test]
fn test_enrich_download_urls_trailing_slash_in_endpoint() {
    let mut config = test_config_with_public_endpoint();
    config.s3_public_endpoint = Some("https://cdn.example.com/".to_string());
    let mut results = vec![make_search_result(json!({"file_path": "path/to/file.txt"}))];
    enrich_download_urls(&mut results, &config);
    assert_eq!(
        results[0].download_url.as_deref(),
        Some("https://cdn.example.com/my-bucket/path/to/file.txt")
    );
}

#[test]
fn test_enrich_download_urls_no_public_endpoint() {
    let config = test_config_no_public_endpoint();
    let mut results = vec![make_search_result(json!({"file_path": "path/to/file.txt"}))];
    enrich_download_urls(&mut results, &config);
    assert!(results[0].download_url.is_none());
}

#[test]
fn test_enrich_download_urls_empty_file_path() {
    let config = test_config_with_public_endpoint();
    let mut results = vec![make_search_result(json!({"file_path": ""}))];
    enrich_download_urls(&mut results, &config);
    assert!(results[0].download_url.is_none());
}

#[test]
fn test_enrich_download_urls_no_file_path_key() {
    let config = test_config_with_public_endpoint();
    let mut results = vec![make_search_result(json!({"other_key": "value"}))];
    enrich_download_urls(&mut results, &config);
    assert!(results[0].download_url.is_none());
}

#[test]
fn test_enrich_download_urls_multiple_results() {
    let config = test_config_with_public_endpoint();
    let mut results = vec![
        make_search_result(json!({"file_path": "file1.pdf"})),
        make_search_result(json!({"file_path": "file2.txt"})),
        make_search_result(json!({})),
    ];
    enrich_download_urls(&mut results, &config);
    assert!(results[0].download_url.is_some());
    assert!(results[1].download_url.is_some());
    assert!(results[2].download_url.is_none());
}

#[test]
fn test_enrich_download_urls_file_path_not_string() {
    let config = test_config_with_public_endpoint();
    let mut results = vec![make_search_result(json!({"file_path": 12345}))];
    enrich_download_urls(&mut results, &config);
    assert!(results[0].download_url.is_none());
}

// -----------------------------------------------------------------------
// resolve_query_params
// -----------------------------------------------------------------------

#[test]
fn test_resolve_params_no_metadata_passes_through() {
    let r = resolve_query_params(&None, "l2", Some(10), Some(5), &None);
    assert_eq!(r.search_mode, "vector");
    assert_eq!(r.distance_metric, "l2");
    assert_eq!(r.nprobe, Some(10));
    assert_eq!(r.refine_factor, Some(5));
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_legacy_metadata_passes_through() {
    let meta = Some(json!({"indexingMode": "hybrid"}));
    let r = resolve_query_params(&None, "dot", None, None, &meta);
    assert_eq!(r.search_mode, "hybrid");
    assert_eq!(r.distance_metric, "dot");
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_metric_mismatch_overrides() {
    let meta = Some(json!({
        "indexingMode": "hybrid",
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
        "hasFtsIndex": true,
    }));
    let r = resolve_query_params(&None, "l2", None, None, &meta);
    assert_eq!(r.distance_metric, "cosine");
    assert_eq!(r.warnings.len(), 1);
    assert!(r.warnings[0].contains("l2"));
    assert!(r.warnings[0].contains("cosine"));
}

#[test]
fn test_resolve_params_metric_match_no_warning() {
    let meta = Some(json!({
        "indexingMode": "semantic",
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
    }));
    let r = resolve_query_params(&None, "cosine", None, None, &meta);
    assert_eq!(r.distance_metric, "cosine");
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_metric_case_insensitive() {
    let meta = Some(json!({
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
    }));
    let r = resolve_query_params(&None, "Cosine", None, None, &meta);
    assert_eq!(r.distance_metric, "Cosine");
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_has_vector_index_false_drops_nprobe() {
    let meta = Some(json!({
        "indexingMode": "semantic",
        "hasVectorIndex": false,
    }));
    let r = resolve_query_params(&None, "cosine", Some(20), Some(10), &meta);
    assert_eq!(r.nprobe, None);
    assert_eq!(r.refine_factor, None);
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_no_fts_index_downgrades_hybrid() {
    let meta = Some(json!({
        "indexingMode": "hybrid",
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
        "hasFtsIndex": false,
    }));
    let r = resolve_query_params(&Some("hybrid".to_string()), "cosine", None, None, &meta);
    assert_eq!(r.search_mode, "vector");
    assert_eq!(r.warnings.len(), 1);
    assert!(r.warnings[0].contains("FTS index"));
}

#[test]
fn test_resolve_params_no_fts_index_downgrades_fts() {
    let meta = Some(json!({
        "indexingMode": "semantic",
        "hasFtsIndex": false,
    }));
    let r = resolve_query_params(&Some("fts".to_string()), "cosine", None, None, &meta);
    assert_eq!(r.search_mode, "vector");
    assert_eq!(r.warnings.len(), 1);
}

#[test]
fn test_resolve_params_has_vector_index_true_metric_none_passes_through() {
    let meta = Some(json!({
        "hasVectorIndex": true,
    }));
    let r = resolve_query_params(&None, "l2", Some(8), None, &meta);
    assert_eq!(r.distance_metric, "l2");
    assert_eq!(r.nprobe, Some(8));
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_no_vector_index_no_warning_for_vector_search() {
    let meta = Some(json!({
        "indexingMode": "semantic",
        "hasVectorIndex": false,
    }));
    let r = resolve_query_params(&Some("vector".to_string()), "cosine", None, None, &meta);
    assert_eq!(r.search_mode, "vector");
    assert!(r.warnings.is_empty());
}

#[test]
fn test_resolve_params_multiple_warnings() {
    let meta = Some(json!({
        "indexingMode": "hybrid",
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
        "hasFtsIndex": false,
    }));
    let r = resolve_query_params(&Some("hybrid".to_string()), "l2", None, None, &meta);
    assert_eq!(r.search_mode, "vector");
    assert_eq!(r.distance_metric, "cosine");
    assert_eq!(r.warnings.len(), 2);
}

#[test]
fn test_resolve_params_explicit_search_mode_honored() {
    let meta = Some(json!({
        "indexingMode": "hybrid",
        "hasFtsIndex": true,
    }));
    let r = resolve_query_params(&Some("fts".to_string()), "cosine", None, None, &meta);
    assert_eq!(r.search_mode, "fts");
    assert!(r.warnings.is_empty());
}

// -----------------------------------------------------------------------
// read_metadata (filesystem with temp dir)
// -----------------------------------------------------------------------

#[test]
fn test_read_metadata_parses_valid_file() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_root: dir.path().to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    let meta_path = cfg.metadata_path("proj1", "kb1");
    std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
    std::fs::write(
        &meta_path,
        r#"{"lanceTablePath":"/data/lancedb-run-1","indexingMode":"hybrid","chunkCount":42}"#,
    )
    .unwrap();

    let meta = read_metadata(&cfg, "proj1", "kb1").expect("metadata should parse");
    assert_eq!(
        get_lancedb_path(&Some(meta.clone())),
        Some("/data/lancedb-run-1".to_string())
    );
    assert_eq!(get_indexing_mode(&Some(meta)), "hybrid");
}

#[tokio::test]
async fn test_read_metadata_with_retry_waits_for_delayed_file() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_root: dir.path().to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    let meta_path = cfg.metadata_path("proj1", "kb1");
    let writer = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
        std::fs::write(
            meta_path,
            r#"{"embeddingGatewayModelId":"as-tei-minilm/sentence-transformers__all-MiniLM-L6-v2"}"#,
        )
        .unwrap();
    });

    let MetadataRead::Found(metadata) = read_metadata_with_retry(&cfg, "proj1", "kb1").await else {
        panic!("delayed metadata should become visible");
    };
    writer.await.unwrap();
    assert_eq!(
        get_embedding_model_name(&Some(metadata)),
        "as-tei-minilm/sentence-transformers__all-MiniLM-L6-v2"
    );
}

#[tokio::test]
async fn test_read_metadata_with_retry_fails_fast_on_corrupt() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_root: dir.path().to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    let meta_path = cfg.metadata_path("proj1", "kb1");
    std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
    std::fs::write(&meta_path, "not-json").unwrap();

    // A corrupt file is Unreadable, not Missing: it must return immediately
    // instead of spinning the full ~20s retry window.
    let start = std::time::Instant::now();
    let result = read_metadata_with_retry(&cfg, "proj1", "kb1").await;
    assert!(start.elapsed() < METADATA_RETRY_INTERVAL);
    assert!(matches!(result, MetadataRead::Unreadable));
}

#[test]
fn test_validate_data_mount_ok() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_root: dir.path().to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    assert!(validate_data_mount(&cfg).is_ok());
}

#[test]
fn test_validate_data_mount_missing() {
    let cfg = Config {
        data_root: "/nonexistent-mount-path-for-test".to_string(),
        ..test_config_with_public_endpoint()
    };
    let err = validate_data_mount(&cfg).unwrap_err();
    assert!(err.contains("does not exist"));
}

#[test]
fn test_read_metadata_invalid_json_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Config {
        data_root: dir.path().to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    let meta_path = cfg.metadata_path("proj1", "kb1");
    std::fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
    std::fs::write(&meta_path, "not-json").unwrap();

    assert!(read_metadata(&cfg, "proj1", "kb1").is_none());
}

// -----------------------------------------------------------------------
// get_embedding_model_name
// -----------------------------------------------------------------------

#[test]
fn test_get_embedding_model_name_prefers_gateway_model_id() {
    let meta = Some(json!({
        "embeddingGatewayModelId": "as-tei-minilm/model-a",
        "providerModelId": "model-b",
        "embeddingModel": "legacy-model"
    }));
    assert_eq!(get_embedding_model_name(&meta), "as-tei-minilm/model-a");
}

#[test]
fn test_get_embedding_model_name_falls_back_to_provider_model_id() {
    let meta = Some(json!({
        "providerModelId": "openai/text-embedding-3-small",
        "embeddingModel": "legacy-model"
    }));
    assert_eq!(
        get_embedding_model_name(&meta),
        "openai/text-embedding-3-small"
    );
}

#[test]
fn test_get_embedding_model_name_falls_back_to_embedding_provider_model_id() {
    let meta = Some(json!({
        "embeddingProviderModelId": "provider/model-c",
    }));
    assert_eq!(get_embedding_model_name(&meta), "provider/model-c");
}

#[test]
fn test_get_embedding_model_name_falls_back_to_legacy_embedding_model() {
    let meta = Some(json!({"embeddingModel": "old-model-name"}));
    assert_eq!(get_embedding_model_name(&meta), "old-model-name");
}

#[test]
fn test_get_embedding_model_name_defaults_when_missing() {
    assert_eq!(
        get_embedding_model_name(&None),
        crate::embedding::DEFAULT_MODEL_NAME
    );
    let meta = Some(json!({"embeddingModel": ""}));
    assert_eq!(
        get_embedding_model_name(&meta),
        crate::embedding::DEFAULT_MODEL_NAME
    );
}

#[test]
fn test_validate_data_mount_not_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let file_path = dir.path().join("not-a-dir");
    std::fs::write(&file_path, "x").unwrap();
    let cfg = Config {
        data_root: file_path.to_string_lossy().to_string(),
        ..test_config_with_public_endpoint()
    };
    let err = validate_data_mount(&cfg).unwrap_err();
    assert!(err.contains("not a directory"));
}
