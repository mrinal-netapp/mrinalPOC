use super::*;
use serde_json::json;

// -----------------------------------------------------------------------
// SearchRequest deserialization
// -----------------------------------------------------------------------

#[test]
fn test_search_request_defaults() {
    let json_str = r#"{"query": "hello world"}"#;
    let req: SearchRequest = serde_json::from_str(json_str).unwrap();
    assert_eq!(req.query, "hello world");
    assert_eq!(req.top_k, 10); // default
    assert_eq!(req.min_score, 0.0); // default
    assert_eq!(req.distance_metric, "cosine"); // default
    assert!(req.search_mode.is_none());
    assert!(req.reranker_type.is_none());
    assert!(req.nprobe.is_none());
    assert!(req.refine_factor.is_none());
}

#[test]
fn test_search_request_all_fields() {
    let json_str = r#"{
    "query": "test query",
    "topK": 5,
    "minScore": 0.75,
    "distanceMetric": "l2",
    "searchMode": "hybrid",
    "rerankerType": "cross-encoder",
    "rerankerOptions": {"model": "some-model"},
    "nprobe": 10,
    "refineFactor": 5
}"#;
    let req: SearchRequest = serde_json::from_str(json_str).unwrap();
    assert_eq!(req.query, "test query");
    assert_eq!(req.top_k, 5);
    assert_eq!(req.min_score, 0.75);
    assert_eq!(req.distance_metric, "l2");
    assert_eq!(req.search_mode.as_deref(), Some("hybrid"));
    assert_eq!(req.reranker_type.as_deref(), Some("cross-encoder"));
    assert_eq!(req.nprobe, Some(10));
    assert_eq!(req.refine_factor, Some(5));
}

#[test]
fn test_search_request_camel_case() {
    // Verify camelCase field mapping
    let json_str = r#"{"query": "test", "topK": 20, "distanceMetric": "dot"}"#;
    let req: SearchRequest = serde_json::from_str(json_str).unwrap();
    assert_eq!(req.top_k, 20);
    assert_eq!(req.distance_metric, "dot");
}

#[test]
fn test_search_request_missing_query_fails() {
    let json_str = r#"{"topK": 5}"#;
    let result: Result<SearchRequest, _> = serde_json::from_str(json_str);
    assert!(result.is_err());
}

// -----------------------------------------------------------------------
// MultiSearchRequest deserialization
// -----------------------------------------------------------------------

#[test]
fn test_multi_search_request_defaults() {
    let json_str = r#"{
    "query": "hello",
    "knowledgeBaseIds": ["kb1", "kb2"]
}"#;
    let req: MultiSearchRequest = serde_json::from_str(json_str).unwrap();
    assert_eq!(req.query, "hello");
    assert_eq!(req.knowledge_base_ids, vec!["kb1", "kb2"]);
    assert_eq!(req.top_k, 10);
    assert_eq!(req.aggregation_strategy, "merge");
    assert!(req.search_mode.is_none());
}

#[test]
fn test_multi_search_request_per_kb_aggregation() {
    let json_str = r#"{
    "query": "search text",
    "knowledgeBaseIds": ["kb-a"],
    "topK": 3,
    "aggregationStrategy": "per_kb",
    "searchMode": "fts"
}"#;
    let req: MultiSearchRequest = serde_json::from_str(json_str).unwrap();
    assert_eq!(req.aggregation_strategy, "per_kb");
    assert_eq!(req.search_mode.as_deref(), Some("fts"));
    assert_eq!(req.top_k, 3);
}

// -----------------------------------------------------------------------
// SearchResponse serialization
// -----------------------------------------------------------------------

#[test]
fn test_search_response_serialization() {
    let resp = SearchResponse {
        results: vec![],
        query: "test".to_string(),
        top_k: 10,
        result_count: 0,
        processing_time_ms: 42.5,
        knowledge_base_id: "kb1".to_string(),
        search_mode: "vector".to_string(),
        indexing_mode: "semantic".to_string(),
        distance_metric: "cosine".to_string(),
        reranker_type: None,
        nprobe: None,
        refine_factor: None,
        warnings: vec![],
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["query"], "test");
    assert_eq!(json["topK"], 10);
    assert_eq!(json["resultCount"], 0);
    assert_eq!(json["processingTimeMs"], 42.5);
    assert_eq!(json["knowledgeBaseId"], "kb1");
    assert_eq!(json["searchMode"], "vector");
    assert_eq!(json["indexingMode"], "semantic");
    // Optional fields should be absent
    assert!(json.get("rerankerType").is_none());
    assert!(json.get("nprobe").is_none());
    assert!(json.get("refineFactor").is_none());
    assert!(json.get("warnings").is_none());
}

#[test]
fn test_search_response_with_optional_fields() {
    let resp = SearchResponse {
        results: vec![],
        query: "test".to_string(),
        top_k: 5,
        result_count: 0,
        processing_time_ms: 10.0,
        knowledge_base_id: "kb2".to_string(),
        search_mode: "hybrid".to_string(),
        indexing_mode: "hybrid".to_string(),
        distance_metric: "l2".to_string(),
        reranker_type: Some("rrf".to_string()),
        nprobe: Some(20),
        refine_factor: Some(10),
        warnings: vec![],
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["rerankerType"], "rrf");
    assert_eq!(json["nprobe"], 20);
    assert_eq!(json["refineFactor"], 10);
}

// -----------------------------------------------------------------------
// SearchResult serialization
// -----------------------------------------------------------------------

#[test]
fn test_search_result_serialization_minimal() {
    let result = SearchResult {
        id: "chunk-1".to_string(),
        document_id: "doc-1".to_string(),
        source: "file.pdf".to_string(),
        text: "Hello world".to_string(),
        chunk_index: 0,
        score: 0.95,
        metadata: json!({"file_path": "projects/p/file.pdf"}),
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json["id"], "chunk-1");
    assert_eq!(json["documentId"], "doc-1");
    assert_eq!(json["chunkIndex"], 0);
    assert_eq!(json["score"], 0.95);
    // Optional None fields should be absent
    assert!(json.get("downloadUrl").is_none());
    assert!(json.get("knowledgeBaseId").is_none());
    assert!(json.get("knowledgeBaseName").is_none());
}

#[test]
fn test_search_result_serialization_with_optionals() {
    let result = SearchResult {
        id: "chunk-2".to_string(),
        document_id: "doc-2".to_string(),
        source: "notes.txt".to_string(),
        text: "Some text".to_string(),
        chunk_index: 3,
        score: 0.88,
        metadata: json!({}),
        download_url: Some("https://s3.example.com/bucket/file.pdf".to_string()),
        knowledge_base_id: Some("kb-123".to_string()),
        knowledge_base_name: Some("My KB".to_string()),
    };
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(
        json["downloadUrl"],
        "https://s3.example.com/bucket/file.pdf"
    );
    assert_eq!(json["knowledgeBaseId"], "kb-123");
    assert_eq!(json["knowledgeBaseName"], "My KB");
}

#[test]
fn test_search_result_clone() {
    let result = SearchResult {
        id: "chunk-1".to_string(),
        document_id: "doc-1".to_string(),
        source: "file.pdf".to_string(),
        text: "text".to_string(),
        chunk_index: 0,
        score: 0.5,
        metadata: json!(null),
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    };
    let cloned = result.clone();
    assert_eq!(cloned.id, result.id);
    assert_eq!(cloned.score, result.score);
}

// -----------------------------------------------------------------------
// Health / Readiness / Metrics responses
// -----------------------------------------------------------------------

#[test]
fn test_health_response_camel_case() {
    let resp = HealthResponse {
        status: "healthy".to_string(),
        service: "kb-retrieval-service".to_string(),
        timestamp: "2026-02-14T00:00:00Z".to_string(),
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["status"], "healthy");
    assert_eq!(json["service"], "kb-retrieval-service");
    assert!(json.get("timestamp").is_some());
}

#[test]
fn test_readiness_response_camel_case() {
    let resp = ReadinessResponse {
        status: "ready".to_string(),
        service: "kb-retrieval-service".to_string(),
        embedding_model: "loaded".to_string(),
        data_mount: "available".to_string(),
        timestamp: "2026-02-14T00:00:00Z".to_string(),
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["embeddingModel"], "loaded");
    assert_eq!(json["dataMount"], "available");
}

#[test]
fn test_metrics_response_structure() {
    let resp = MetricsResponse {
        connection_pool: PoolMetrics {
            size: 10,
            max_size: 50,
            hits: 100,
            misses: 20,
            evictions: 5,
            hit_rate: 83.33,
        },
        requests: RequestMetrics {
            total: 120,
            successful: 115,
            failed: 5,
            avg_latency_ms: 45.2,
        },
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["connectionPool"]["size"], 10);
    assert_eq!(json["connectionPool"]["maxSize"], 50);
    assert_eq!(json["connectionPool"]["hitRate"], 83.33);
    assert_eq!(json["requests"]["total"], 120);
    assert_eq!(json["requests"]["avgLatencyMs"], 45.2);
}

// -----------------------------------------------------------------------
// KbMetadataResponse
// -----------------------------------------------------------------------

#[test]
fn test_kb_metadata_response_skip_none() {
    let resp = KbMetadataResponse {
        knowledge_base_id: "kb1".to_string(),
        project_id: "proj1".to_string(),
        lancedb_path: "/mnt/pvcs/default-nemo/projects/proj1/knowledgebases/kb1/lancedb"
            .to_string(),
        embedding_model: "all-MiniLM-L6-v2".to_string(),
        vector_size: 384,
        chunk_count: None,
        document_count: None,
        storage_mb: None,
        last_processed_at: None,
        last_processing_mode: None,
        indexing_mode: None,
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["knowledgeBaseId"], "kb1");
    assert_eq!(json["vectorSize"], 384);
    // Nones should be absent
    assert!(json.get("chunkCount").is_none());
    assert!(json.get("lastProcessedAt").is_none());
    assert!(json.get("indexingMode").is_none());
}

#[test]
fn test_kb_metadata_response_with_all_fields() {
    let resp = KbMetadataResponse {
        knowledge_base_id: "kb2".to_string(),
        project_id: "proj2".to_string(),
        lancedb_path: "/mnt/pvcs/default-nemo/projects/proj2/knowledgebases/kb2/lancedb-run-abc"
            .to_string(),
        embedding_model: "model".to_string(),
        vector_size: 768,
        chunk_count: Some(1234),
        document_count: Some(42),
        storage_mb: Some(12.5),
        last_processed_at: Some("2026-02-14T10:00:00Z".to_string()),
        last_processing_mode: Some("full".to_string()),
        indexing_mode: Some("hybrid".to_string()),
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["chunkCount"], 1234);
    assert_eq!(json["documentCount"], 42);
    assert_eq!(json["storageMb"], 12.5);
    assert_eq!(json["lastProcessedAt"], "2026-02-14T10:00:00Z");
    assert_eq!(json["lastProcessingMode"], "full");
    assert_eq!(json["indexingMode"], "hybrid");
}

// -----------------------------------------------------------------------
// Multi-search response types
// -----------------------------------------------------------------------

#[test]
fn test_multi_search_merge_response() {
    let resp = MultiSearchMergeResponse {
        results: vec![],
        aggregation_strategy: "merge".to_string(),
        query: "test".to_string(),
        top_k: 10,
        processing_time_ms: 50.0,
        knowledge_bases_queried: 3,
        requested_search_mode: Some("vector".to_string()),
        warnings: vec![],
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["aggregationStrategy"], "merge");
    assert_eq!(json["knowledgeBasesQueried"], 3);
    assert_eq!(json["requestedSearchMode"], "vector");
}

#[test]
fn test_multi_search_per_kb_response() {
    let resp = MultiSearchPerKbResponse {
        results: vec![PerKbResult {
            knowledge_base_id: "kb1".to_string(),
            knowledge_base_name: "Test KB".to_string(),
            search_mode: "vector".to_string(),
            chunks: vec![],
        }],
        aggregation_strategy: "per_kb".to_string(),
        query: "test".to_string(),
        top_k: 5,
        processing_time_ms: 30.0,
        knowledge_bases_queried: 1,
        requested_search_mode: None,
    };
    let json = serde_json::to_value(&resp).unwrap();
    assert_eq!(json["aggregationStrategy"], "per_kb");
    assert_eq!(json["results"][0]["knowledgeBaseId"], "kb1");
    assert_eq!(json["results"][0]["knowledgeBaseName"], "Test KB");
    // requestedSearchMode is None, should be absent
    assert!(json.get("requestedSearchMode").is_none());
}
