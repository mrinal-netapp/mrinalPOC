use super::*;
use arrow_array::{Float64Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use std::sync::Arc;

// -----------------------------------------------------------------------
// distance_to_score tests
// -----------------------------------------------------------------------

#[test]
fn test_distance_to_score_cosine_zero() {
    // Distance 0 → score 1.0 (identical vectors)
    let score = distance_to_score(0.0, "cosine");
    assert!((score - 1.0).abs() < 1e-9);
}

#[test]
fn test_distance_to_score_cosine_max() {
    // Cosine distance 2.0 → score 0.0 (opposite vectors)
    let score = distance_to_score(2.0, "cosine");
    assert!((score - 0.0).abs() < 1e-9);
}

#[test]
fn test_distance_to_score_cosine_mid() {
    // Cosine distance 1.0 → score 0.5
    let score = distance_to_score(1.0, "cosine");
    assert!((score - 0.5).abs() < 1e-9);
}

#[test]
fn test_distance_to_score_cosine_clamped() {
    // Cosine distance > 2.0 → clamped to 0.0
    let score = distance_to_score(3.0, "cosine");
    assert_eq!(score, 0.0);
}

#[test]
fn test_distance_to_score_l2_zero() {
    // L2 distance 0 → score 1.0
    let score = distance_to_score(0.0, "l2");
    assert!((score - 1.0).abs() < 1e-9);
}

#[test]
fn test_distance_to_score_l2_one() {
    // L2 distance 1 → score 0.5
    let score = distance_to_score(1.0, "l2");
    assert!((score - 0.5).abs() < 1e-9);
}

#[test]
fn test_distance_to_score_l2_large() {
    // Large L2 distance → score approaches 0
    let score = distance_to_score(1000.0, "l2");
    assert!(score < 0.01);
    assert!(score > 0.0);
}

#[test]
fn test_distance_to_score_dot_product() {
    assert_eq!(distance_to_score(0.0, "dot"), 0.0);
    assert_eq!(distance_to_score(0.5, "dot"), 0.5);
    assert_eq!(distance_to_score(1.0, "dot"), 1.0);
}

#[test]
fn test_distance_to_score_dot_clamped() {
    // Dot product can exceed 1.0 — should clamp
    assert_eq!(distance_to_score(1.5, "dot"), 1.0);
    // Negative → clamp to 0
    assert_eq!(distance_to_score(-0.5, "dot"), 0.0);
}

#[test]
fn test_distance_to_score_default_is_cosine() {
    // Unknown metric should default to cosine behavior
    let score = distance_to_score(0.0, "unknown_metric");
    assert!((score - 1.0).abs() < 1e-9);
    let score = distance_to_score(2.0, "");
    assert!((score - 0.0).abs() < 1e-9);
}

// -----------------------------------------------------------------------
// parse_distance_type tests
// -----------------------------------------------------------------------

#[test]
fn test_parse_distance_type_cosine() {
    assert!(matches!(
        parse_distance_type("cosine"),
        DistanceType::Cosine
    ));
}

#[test]
fn test_parse_distance_type_l2() {
    assert!(matches!(parse_distance_type("l2"), DistanceType::L2));
    assert!(matches!(parse_distance_type("L2"), DistanceType::L2));
}

#[test]
fn test_parse_distance_type_dot() {
    assert!(matches!(parse_distance_type("dot"), DistanceType::Dot));
    assert!(matches!(parse_distance_type("DOT"), DistanceType::Dot));
}

#[test]
fn test_parse_distance_type_default() {
    assert!(matches!(
        parse_distance_type("unknown"),
        DistanceType::Cosine
    ));
    assert!(matches!(parse_distance_type(""), DistanceType::Cosine));
}

// -----------------------------------------------------------------------
// Arrow extraction helpers
// -----------------------------------------------------------------------

fn make_test_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, true),
        Field::new("document_id", DataType::Utf8, true),
        Field::new("source", DataType::Utf8, true),
        Field::new("text", DataType::Utf8, true),
        Field::new("chunk_index", DataType::Int64, true),
        Field::new("metadata", DataType::Utf8, true),
        Field::new("_distance", DataType::Float64, true),
    ]))
}

fn make_fts_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, true),
        Field::new("document_id", DataType::Utf8, true),
        Field::new("source", DataType::Utf8, true),
        Field::new("text", DataType::Utf8, true),
        Field::new("chunk_index", DataType::Int64, true),
        Field::new("metadata", DataType::Utf8, true),
        Field::new("_score", DataType::Float64, true),
    ]))
}

fn make_test_batch(
    ids: &[&str],
    distances: &[f64],
    schema: Arc<Schema>,
    _score_col: &str,
) -> RecordBatch {
    let n = ids.len();
    let doc_ids: Vec<&str> = (0..n)
        .map(|i| if i == 0 { "doc-1" } else { "doc-2" })
        .collect();
    let sources: Vec<&str> = vec!["file.pdf"; n];
    let texts: Vec<&str> = (0..n).map(|_| "sample text").collect();
    let chunk_indices: Vec<i64> = (0..n).map(|i| i as i64).collect();
    let metadatas: Vec<&str> = vec![r#"{"file_path":"projects/p/file.pdf"}"#; n];

    let columns: Vec<Arc<dyn arrow_array::Array>> = vec![
        Arc::new(StringArray::from(ids.to_vec())),
        Arc::new(StringArray::from(doc_ids)),
        Arc::new(StringArray::from(sources)),
        Arc::new(StringArray::from(texts)),
        Arc::new(Int64Array::from(chunk_indices)),
        Arc::new(StringArray::from(metadatas)),
        Arc::new(Float64Array::from(distances.to_vec())),
    ];

    RecordBatch::try_new(schema, columns).unwrap()
}

#[test]
fn test_extract_string_valid() {
    let schema = Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, false)]));
    let batch =
        RecordBatch::try_new(schema, vec![Arc::new(StringArray::from(vec!["hello"]))]).unwrap();
    assert_eq!(extract_string(&batch, "name", 0), Some("hello".to_string()));
}

#[test]
fn test_extract_string_missing_column() {
    let schema = Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, false)]));
    let batch =
        RecordBatch::try_new(schema, vec![Arc::new(StringArray::from(vec!["hello"]))]).unwrap();
    assert_eq!(extract_string(&batch, "nonexistent", 0), None);
}

#[test]
fn test_extract_i64_valid() {
    let schema = Arc::new(Schema::new(vec![Field::new("idx", DataType::Int64, false)]));
    let batch = RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![42]))]).unwrap();
    assert_eq!(extract_i64(&batch, "idx", 0), Some(42));
}

#[test]
fn test_extract_f64_from_float64() {
    use std::f64::consts::PI;
    let schema = Arc::new(Schema::new(vec![Field::new(
        "val",
        DataType::Float64,
        false,
    )]));
    let batch = RecordBatch::try_new(schema, vec![Arc::new(Float64Array::from(vec![PI]))]).unwrap();
    let val = extract_f64(&batch, "val", 0).unwrap();
    assert!((val - PI).abs() < 1e-9);
}

#[test]
fn test_extract_f64_from_float32() {
    use arrow_array::Float32Array;
    let schema = Arc::new(Schema::new(vec![Field::new(
        "val",
        DataType::Float32,
        false,
    )]));
    let batch =
        RecordBatch::try_new(schema, vec![Arc::new(Float32Array::from(vec![2.5f32]))]).unwrap();
    let val = extract_f64(&batch, "val", 0).unwrap();
    assert!((val - 2.5).abs() < 0.001);
}

#[test]
fn test_extract_f64_missing_column() {
    let schema = Arc::new(Schema::new(vec![Field::new(
        "val",
        DataType::Float64,
        false,
    )]));
    let batch =
        RecordBatch::try_new(schema, vec![Arc::new(Float64Array::from(vec![1.0]))]).unwrap();
    assert!(extract_f64(&batch, "missing", 0).is_none());
}

// -----------------------------------------------------------------------
// extract_vector_results tests
// -----------------------------------------------------------------------

#[test]
fn test_extract_vector_results_cosine() {
    let schema = make_test_schema();
    let batch = make_test_batch(
        &["c1", "c2", "c3"],
        &[0.0, 1.0, 0.5],
        schema.clone(),
        "_distance",
    );
    let results = extract_vector_results(&[batch], "cosine");
    assert_eq!(results.len(), 3);

    // Results should be sorted by score descending
    // c1: distance=0 → score=1.0
    // c3: distance=0.5 → score=0.75
    // c2: distance=1.0 → score=0.5
    assert_eq!(results[0].id, "c1");
    assert!((results[0].score - 1.0).abs() < 1e-9);
    assert_eq!(results[1].id, "c3");
    assert!((results[1].score - 0.75).abs() < 1e-9);
    assert_eq!(results[2].id, "c2");
    assert!((results[2].score - 0.5).abs() < 1e-9);
}

#[test]
fn test_extract_vector_results_l2() {
    let schema = make_test_schema();
    let batch = make_test_batch(&["a", "b"], &[0.0, 4.0], schema.clone(), "_distance");
    let results = extract_vector_results(&[batch], "l2");
    assert_eq!(results.len(), 2);
    // a: distance=0 → score=1.0
    // b: distance=4 → score=1/(1+4)=0.2
    assert_eq!(results[0].id, "a");
    assert!((results[0].score - 1.0).abs() < 1e-9);
    assert_eq!(results[1].id, "b");
    assert!((results[1].score - 0.2).abs() < 1e-9);
}

#[test]
fn test_extract_vector_results_multiple_batches() {
    let schema = make_test_schema();
    let batch1 = make_test_batch(&["c1"], &[0.0], schema.clone(), "_distance");
    let batch2 = make_test_batch(&["c2"], &[1.0], schema.clone(), "_distance");
    let results = extract_vector_results(&[batch1, batch2], "cosine");
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].id, "c1");
    assert_eq!(results[1].id, "c2");
}

#[test]
fn test_extract_vector_results_empty() {
    let results = extract_vector_results(&[], "cosine");
    assert!(results.is_empty());
}

// -----------------------------------------------------------------------
// extract_fts_results tests
// -----------------------------------------------------------------------

#[test]
fn test_extract_fts_results() {
    let schema = make_fts_schema();
    let batch = make_test_batch(&["f1", "f2"], &[10.0, 2.0], schema.clone(), "_score");
    let results = extract_fts_results(&[batch]);
    assert_eq!(results.len(), 2);

    // f1: raw_score=10 → score = 10/(10+1) ≈ 0.909
    // f2: raw_score=2 → score = 2/(2+1) ≈ 0.667
    assert_eq!(results[0].id, "f1");
    assert!((results[0].score - 10.0 / 11.0).abs() < 1e-3);
    assert_eq!(results[1].id, "f2");
    assert!((results[1].score - 2.0 / 3.0).abs() < 1e-3);
}

#[test]
fn test_extract_fts_results_zero_score() {
    let schema = make_fts_schema();
    let batch = make_test_batch(&["f1"], &[0.0], schema.clone(), "_score");
    let results = extract_fts_results(&[batch]);
    // raw_score=0 → score=0/(0+1)=0
    assert!((results[0].score - 0.0).abs() < 1e-9);
}

// -----------------------------------------------------------------------
// build_search_result tests
// -----------------------------------------------------------------------

#[test]
fn test_build_search_result_parses_metadata() {
    let schema = make_test_schema();
    let batch = make_test_batch(&["c1"], &[0.0], schema, "_distance");
    let result = build_search_result(&batch, 0, 0.95);

    assert_eq!(result.id, "c1");
    assert_eq!(result.document_id, "doc-1");
    assert_eq!(result.source, "file.pdf");
    assert_eq!(result.text, "sample text");
    assert_eq!(result.chunk_index, 0);
    assert!((result.score - 0.95).abs() < 1e-9);
    // Metadata should be parsed JSON
    assert!(result.metadata.is_object());
    assert_eq!(
        result.metadata.get("file_path").unwrap().as_str().unwrap(),
        "projects/p/file.pdf"
    );
    assert!(result.download_url.is_none());
}

#[test]
fn test_build_search_result_invalid_metadata_json() {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, true),
        Field::new("document_id", DataType::Utf8, true),
        Field::new("source", DataType::Utf8, true),
        Field::new("text", DataType::Utf8, true),
        Field::new("chunk_index", DataType::Int64, true),
        Field::new("metadata", DataType::Utf8, true),
        Field::new("_distance", DataType::Float64, true),
    ]));
    let columns: Vec<Arc<dyn arrow_array::Array>> = vec![
        Arc::new(StringArray::from(vec!["c1"])),
        Arc::new(StringArray::from(vec!["d1"])),
        Arc::new(StringArray::from(vec!["src"])),
        Arc::new(StringArray::from(vec!["txt"])),
        Arc::new(Int64Array::from(vec![0])),
        Arc::new(StringArray::from(vec!["not-valid-json"])),
        Arc::new(Float64Array::from(vec![0.0])),
    ];
    let batch = RecordBatch::try_new(schema, columns).unwrap();
    let result = build_search_result(&batch, 0, 0.8);
    // Invalid JSON → metadata should be null
    assert!(result.metadata.is_null());
}

// -----------------------------------------------------------------------
// RRF merge tests
// -----------------------------------------------------------------------

fn make_result(id: &str, score: f64) -> SearchResult {
    SearchResult {
        id: id.to_string(),
        document_id: "doc".to_string(),
        source: "src".to_string(),
        text: "txt".to_string(),
        chunk_index: 0,
        score,
        metadata: serde_json::Value::Null,
        download_url: None,
        knowledge_base_id: None,
        knowledge_base_name: None,
    }
}

#[test]
fn test_rrf_merge_disjoint() {
    // Two completely disjoint result sets
    let vector = vec![make_result("a", 0.9), make_result("b", 0.8)];
    let fts = vec![make_result("c", 0.95), make_result("d", 0.85)];
    let merged = rrf_merge(&vector, &fts, 10);
    assert_eq!(merged.len(), 4);
    // All scores should be > 0
    for r in &merged {
        assert!(r.score > 0.0);
    }
}

#[test]
fn test_rrf_merge_overlapping() {
    // Overlapping results — "a" appears in both
    let vector = vec![make_result("a", 0.9), make_result("b", 0.8)];
    let fts = vec![make_result("a", 0.95), make_result("c", 0.7)];
    let merged = rrf_merge(&vector, &fts, 10);
    assert_eq!(merged.len(), 3); // a, b, c (deduplicated)

    // "a" should have the highest score (appears in both lists at rank 0)
    assert_eq!(merged[0].id, "a");
    // Score of "a" should be higher than single-list items
    assert!(merged[0].score > merged[1].score);
}

#[test]
fn test_rrf_merge_top_k_limit() {
    let vector = vec![
        make_result("a", 0.9),
        make_result("b", 0.8),
        make_result("c", 0.7),
    ];
    let fts = vec![
        make_result("d", 0.95),
        make_result("e", 0.85),
        make_result("f", 0.75),
    ];
    let merged = rrf_merge(&vector, &fts, 3);
    assert_eq!(merged.len(), 3);
}

#[test]
fn test_rrf_merge_empty_vector() {
    let vector: Vec<SearchResult> = vec![];
    let fts = vec![make_result("a", 0.9)];
    let merged = rrf_merge(&vector, &fts, 10);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].id, "a");
}

#[test]
fn test_rrf_merge_empty_fts() {
    let vector = vec![make_result("a", 0.9)];
    let fts: Vec<SearchResult> = vec![];
    let merged = rrf_merge(&vector, &fts, 10);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].id, "a");
}

#[test]
fn test_rrf_merge_both_empty() {
    let vector: Vec<SearchResult> = vec![];
    let fts: Vec<SearchResult> = vec![];
    let merged = rrf_merge(&vector, &fts, 10);
    assert!(merged.is_empty());
}

#[test]
fn test_rrf_merge_scores_normalized() {
    // Scores should be normalized to [0, 1]
    let vector = vec![make_result("a", 0.9)];
    let fts = vec![make_result("a", 0.95)];
    let merged = rrf_merge(&vector, &fts, 10);
    assert!(merged[0].score >= 0.0);
    assert!(merged[0].score <= 1.0);
}

#[test]
fn test_rrf_merge_ranking_stability() {
    // If item appears in both lists at rank 0, it should beat one at rank 1
    let vector = vec![make_result("top", 0.99), make_result("second", 0.95)];
    let fts = vec![make_result("top", 0.99), make_result("other", 0.90)];
    let merged = rrf_merge(&vector, &fts, 10);
    assert_eq!(merged[0].id, "top");
}

// -----------------------------------------------------------------------
// simple_merge tests (reranking disabled path)
// -----------------------------------------------------------------------

#[test]
fn test_simple_merge_disjoint_sorts_by_native_score() {
    let vector = vec![make_result("a", 0.6), make_result("b", 0.4)];
    let fts = vec![make_result("c", 0.9), make_result("d", 0.5)];
    let merged = simple_merge(&vector, &fts, 10);

    assert_eq!(merged.len(), 4);
    // Unlike RRF, ordering is driven purely by the native normalised score.
    assert_eq!(merged[0].id, "c");
    for i in 1..merged.len() {
        assert!(merged[i - 1].score >= merged[i].score);
    }
}

#[test]
fn test_simple_merge_dedupes_keeping_higher_score() {
    // "a" appears in both lists; the higher score must win.
    let vector = vec![make_result("a", 0.3)];
    let fts = vec![make_result("a", 0.8)];
    let merged = simple_merge(&vector, &fts, 10);

    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].id, "a");
    assert!((merged[0].score - 0.8).abs() < f64::EPSILON);
}

#[test]
fn test_simple_merge_respects_top_k() {
    let vector = vec![make_result("a", 0.9), make_result("b", 0.8)];
    let fts = vec![make_result("c", 0.7), make_result("d", 0.6)];
    let merged = simple_merge(&vector, &fts, 2);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "a");
    assert_eq!(merged[1].id, "b");
}

#[test]
fn test_simple_merge_preserves_original_scores() {
    // simple_merge must NOT rescale scores the way RRF does.
    let vector = vec![make_result("a", 0.55)];
    let fts: Vec<SearchResult> = vec![];
    let merged = simple_merge(&vector, &fts, 10);
    assert_eq!(merged.len(), 1);
    assert!((merged[0].score - 0.55).abs() < f64::EPSILON);
}

#[test]
fn test_simple_merge_both_empty() {
    let vector: Vec<SearchResult> = vec![];
    let fts: Vec<SearchResult> = vec![];
    let merged = simple_merge(&vector, &fts, 10);
    assert!(merged.is_empty());
}

// -----------------------------------------------------------------------
// Sorted output validation
// -----------------------------------------------------------------------

#[test]
fn test_vector_results_sorted_descending() {
    let schema = make_test_schema();
    let batch = make_test_batch(
        &["low", "high", "mid"],
        &[1.8, 0.1, 1.0], // cosine distances
        schema,
        "_distance",
    );
    let results = extract_vector_results(&[batch], "cosine");
    for i in 1..results.len() {
        assert!(results[i - 1].score >= results[i].score);
    }
}

#[test]
fn test_fts_results_sorted_descending() {
    let schema = make_fts_schema();
    let batch = make_test_batch(
        &["low", "high", "mid"],
        &[0.5, 20.0, 5.0], // BM25 scores
        schema,
        "_score",
    );
    let results = extract_fts_results(&[batch]);
    for i in 1..results.len() {
        assert!(results[i - 1].score >= results[i].score);
    }
}
