//! End-to-end search tests against a real LanceDB instance.
//!
//! These tests:
//! 1. Create a temporary LanceDB database on the local filesystem
//! 2. Build a `kb_vectors` table with realistic sample data and embeddings
//! 3. Run actual vector, FTS, and hybrid searches via `SearchEngine`
//! 4. Verify results are returned correctly, scored, and ordered
//!
//! The test data simulates a knowledge base about programming languages with
//! hand-crafted embeddings that have known similarity relationships.

use std::sync::Arc;

use arrow_array::{FixedSizeListArray, Float32Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};

use kb_retrieval_service::search::SearchEngine;

/// Embedding dimension used in tests. We use a smaller dimension (8) for speed
/// and easy manual construction of vectors with known similarity properties.
const TEST_DIM: i32 = 8;

/// Number of sample documents/chunks in the test KB.
const NUM_CHUNKS: usize = 10;

// ---------------------------------------------------------------------------
// Test data generation
// ---------------------------------------------------------------------------

/// Sample document data for a small "programming languages" knowledge base.
struct TestChunk {
    id: &'static str,
    document_id: &'static str,
    source: &'static str,
    text: &'static str,
    chunk_index: i64,
    vector: [f32; 8],
    metadata_json: &'static str,
}

/// Generate test chunks with hand-crafted vectors.
///
/// Vectors are designed so that:
/// - "rust" chunks (0,1,2) are close to each other
/// - "python" chunks (3,4) are close to each other
/// - "javascript" chunks (5,6) are close to each other
/// - "database" chunks (7,8) are close to each other
/// - "general" chunk (9) is somewhat equidistant
///
/// The query vector for "rust programming" will be close to chunks 0,1,2.
fn test_chunks() -> Vec<TestChunk> {
    vec![
        TestChunk {
            id: "chunk-0",
            document_id: "doc-rust",
            source: "rust-guide.pdf",
            text: "Rust is a systems programming language focused on safety and performance",
            chunk_index: 0,
            vector: [0.9, 0.8, 0.1, 0.05, 0.05, 0.1, 0.05, 0.1],
            metadata_json: r#"{"file_path":"projects/p1/files/rust-guide.pdf","language":"rust"}"#,
        },
        TestChunk {
            id: "chunk-1",
            document_id: "doc-rust",
            source: "rust-guide.pdf",
            text: "Rust ownership model ensures memory safety without garbage collection",
            chunk_index: 1,
            vector: [0.85, 0.75, 0.15, 0.05, 0.1, 0.05, 0.1, 0.05],
            metadata_json: r#"{"file_path":"projects/p1/files/rust-guide.pdf","language":"rust"}"#,
        },
        TestChunk {
            id: "chunk-2",
            document_id: "doc-rust-perf",
            source: "rust-performance.md",
            text: "Rust achieves zero-cost abstractions and high performance comparable to C and C++",
            chunk_index: 0,
            vector: [0.88, 0.7, 0.12, 0.08, 0.08, 0.15, 0.08, 0.12],
            metadata_json: r#"{"file_path":"projects/p1/files/rust-performance.md","language":"rust"}"#,
        },
        TestChunk {
            id: "chunk-3",
            document_id: "doc-python",
            source: "python-intro.pdf",
            text: "Python is a high-level interpreted programming language known for readability",
            chunk_index: 0,
            vector: [0.1, 0.15, 0.85, 0.8, 0.05, 0.1, 0.05, 0.1],
            metadata_json: r#"{"file_path":"projects/p1/files/python-intro.pdf","language":"python"}"#,
        },
        TestChunk {
            id: "chunk-4",
            document_id: "doc-python",
            source: "python-intro.pdf",
            text: "Python supports multiple programming paradigms including object-oriented",
            chunk_index: 1,
            vector: [0.12, 0.1, 0.8, 0.85, 0.1, 0.05, 0.08, 0.12],
            metadata_json: r#"{"file_path":"projects/p1/files/python-intro.pdf","language":"python"}"#,
        },
        TestChunk {
            id: "chunk-5",
            document_id: "doc-javascript",
            source: "js-guide.pdf",
            text: "JavaScript is the programming language of the web used for frontend development",
            chunk_index: 0,
            vector: [0.1, 0.05, 0.1, 0.05, 0.9, 0.85, 0.1, 0.05],
            metadata_json: r#"{"file_path":"projects/p1/files/js-guide.pdf","language":"javascript"}"#,
        },
        TestChunk {
            id: "chunk-6",
            document_id: "doc-javascript",
            source: "js-guide.pdf",
            text: "JavaScript runs in web browsers and on servers with Node.js runtime",
            chunk_index: 1,
            vector: [0.08, 0.1, 0.05, 0.1, 0.85, 0.88, 0.12, 0.08],
            metadata_json: r#"{"file_path":"projects/p1/files/js-guide.pdf","language":"javascript"}"#,
        },
        TestChunk {
            id: "chunk-7",
            document_id: "doc-database",
            source: "database-design.pdf",
            text: "PostgreSQL is a powerful relational database system with SQL support",
            chunk_index: 0,
            vector: [0.05, 0.1, 0.05, 0.1, 0.1, 0.05, 0.9, 0.85],
            metadata_json: r#"{"file_path":"projects/p1/files/database-design.pdf","topic":"database"}"#,
        },
        TestChunk {
            id: "chunk-8",
            document_id: "doc-database",
            source: "database-design.pdf",
            text: "Database indexing improves query performance for large datasets",
            chunk_index: 1,
            vector: [0.08, 0.05, 0.1, 0.08, 0.05, 0.1, 0.85, 0.88],
            metadata_json: r#"{"file_path":"projects/p1/files/database-design.pdf","topic":"database"}"#,
        },
        TestChunk {
            id: "chunk-9",
            document_id: "doc-overview",
            source: "programming-overview.pdf",
            text: "Modern programming languages provide tools for building reliable software systems",
            chunk_index: 0,
            vector: [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3],
            metadata_json: r#"{"file_path":"projects/p1/files/programming-overview.pdf","topic":"general"}"#,
        },
    ]
}

/// Build the Arrow schema matching the production `kb_vectors` table.
fn test_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("document_id", DataType::Utf8, false),
        Field::new("source", DataType::Utf8, false),
        Field::new("text", DataType::Utf8, false),
        Field::new("chunk_index", DataType::Int64, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                TEST_DIM,
            ),
            false,
        ),
        Field::new("metadata", DataType::Utf8, false),
    ]))
}

/// Build a RecordBatch from test chunks.
fn build_record_batch(chunks: &[TestChunk]) -> RecordBatch {
    let schema = test_schema();

    let ids = StringArray::from(chunks.iter().map(|c| c.id).collect::<Vec<_>>());
    let doc_ids = StringArray::from(chunks.iter().map(|c| c.document_id).collect::<Vec<_>>());
    let sources = StringArray::from(chunks.iter().map(|c| c.source).collect::<Vec<_>>());
    let texts = StringArray::from(chunks.iter().map(|c| c.text).collect::<Vec<_>>());
    let chunk_indices = Int64Array::from(chunks.iter().map(|c| c.chunk_index).collect::<Vec<_>>());
    let metadatas = StringArray::from(chunks.iter().map(|c| c.metadata_json).collect::<Vec<_>>());

    // Build the FixedSizeList vector column from flattened float values
    let flat_values: Vec<f32> = chunks
        .iter()
        .flat_map(|c| c.vector.iter().copied())
        .collect();
    let values_array = Float32Array::from(flat_values);
    let vector_field = Arc::new(Field::new("item", DataType::Float32, true));
    let vector_array =
        FixedSizeListArray::try_new(vector_field, TEST_DIM, Arc::new(values_array), None)
            .expect("Failed to create FixedSizeListArray");

    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(ids),
            Arc::new(doc_ids),
            Arc::new(sources),
            Arc::new(texts),
            Arc::new(chunk_indices),
            Arc::new(vector_array),
            Arc::new(metadatas),
        ],
    )
    .expect("Failed to create RecordBatch")
}

/// Create a LanceDB table in a temporary directory with test data.
/// Returns the Table handle.
async fn create_test_table(temp_dir: &tempfile::TempDir, with_fts: bool) -> lancedb::table::Table {
    let chunks = test_chunks();
    let batch = build_record_batch(&chunks);

    let db_path = temp_dir.path().join("test_lancedb");
    let db = lancedb::connect(db_path.to_str().unwrap())
        .execute()
        .await
        .expect("Failed to connect to LanceDB");

    // Create table from RecordBatch
    let arrow_schema = test_schema();
    let table = db
        .create_table(
            "kb_vectors",
            arrow_array::RecordBatchIterator::new(vec![Ok(batch)], arrow_schema),
        )
        .execute()
        .await
        .expect("Failed to create table");

    // Create FTS index on "text" column if requested
    if with_fts {
        table
            .create_index(
                &["text"],
                lancedb::index::Index::FTS(lancedb::index::scalar::FtsIndexBuilder::default()),
            )
            .execute()
            .await
            .expect("Failed to create FTS index");
    }

    table
}

/// Query vector for "rust programming" — close to chunks 0,1,2.
fn rust_query_vector() -> Vec<f32> {
    vec![0.9, 0.8, 0.1, 0.05, 0.05, 0.1, 0.05, 0.1]
}

/// Query vector for "python programming" — close to chunks 3,4.
fn python_query_vector() -> Vec<f32> {
    vec![0.1, 0.15, 0.85, 0.8, 0.05, 0.1, 0.05, 0.1]
}

/// Query vector for "database systems" — close to chunks 7,8.
fn database_query_vector() -> Vec<f32> {
    vec![0.05, 0.1, 0.05, 0.1, 0.1, 0.05, 0.9, 0.85]
}

// ===========================================================================
// Vector search tests
// ===========================================================================

#[tokio::test]
async fn test_vector_search_returns_correct_results() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results = SearchEngine::vector_search(
        &table,
        &rust_query_vector(),
        5, // top_k
        "cosine",
        None, // nprobe
        None, // refine_factor
    )
    .await
    .expect("vector search should succeed");

    // Should return results
    assert!(!results.is_empty(), "Should return at least one result");
    assert!(results.len() <= 5, "Should not exceed top_k");

    // The top result should be chunk-0 (exact match to query vector)
    assert_eq!(
        results[0].id, "chunk-0",
        "Exact vector match should rank first"
    );
}

#[tokio::test]
async fn test_vector_search_top_results_are_rust_chunks() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 5, "cosine", None, None)
            .await
            .unwrap();

    // Top 3 should all be from the rust cluster (chunks 0, 1, 2)
    let top3_ids: Vec<&str> = results[..3].iter().map(|r| r.id.as_str()).collect();
    assert!(top3_ids.contains(&"chunk-0"), "chunk-0 should be in top 3");
    assert!(top3_ids.contains(&"chunk-1"), "chunk-1 should be in top 3");
    assert!(top3_ids.contains(&"chunk-2"), "chunk-2 should be in top 3");
}

#[tokio::test]
async fn test_vector_search_python_query() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &python_query_vector(), 3, "cosine", None, None)
            .await
            .unwrap();

    assert!(!results.is_empty());
    // Top results should be python chunks
    let top2_ids: Vec<&str> = results[..2].iter().map(|r| r.id.as_str()).collect();
    assert!(
        top2_ids.contains(&"chunk-3"),
        "chunk-3 (Python) should be in top 2"
    );
    assert!(
        top2_ids.contains(&"chunk-4"),
        "chunk-4 (Python) should be in top 2"
    );
}

#[tokio::test]
async fn test_vector_search_database_query() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &database_query_vector(), 3, "cosine", None, None)
            .await
            .unwrap();

    assert!(!results.is_empty());
    let top2_ids: Vec<&str> = results[..2].iter().map(|r| r.id.as_str()).collect();
    assert!(
        top2_ids.contains(&"chunk-7"),
        "chunk-7 (DB) should be in top 2"
    );
    assert!(
        top2_ids.contains(&"chunk-8"),
        "chunk-8 (DB) should be in top 2"
    );
}

#[tokio::test]
async fn test_vector_search_scores_are_normalized() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 10, "cosine", None, None)
            .await
            .unwrap();

    for result in &results {
        assert!(
            result.score >= 0.0 && result.score <= 1.0,
            "Score {} should be in [0, 1] for chunk {}",
            result.score,
            result.id
        );
    }
}

#[tokio::test]
async fn test_vector_search_scores_are_sorted_descending() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 10, "cosine", None, None)
            .await
            .unwrap();

    for i in 1..results.len() {
        assert!(
            results[i - 1].score >= results[i].score,
            "Scores should be descending: {} at rank {} vs {} at rank {}",
            results[i - 1].score,
            i - 1,
            results[i].score,
            i
        );
    }
}

#[tokio::test]
async fn test_vector_search_top_k_limits_results() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    for top_k in [1, 3, 5, 10] {
        let results =
            SearchEngine::vector_search(&table, &rust_query_vector(), top_k, "cosine", None, None)
                .await
                .unwrap();

        assert!(
            results.len() <= top_k as usize,
            "top_k={}: got {} results (max {})",
            top_k,
            results.len(),
            top_k
        );
    }
}

#[tokio::test]
async fn test_vector_search_returns_metadata() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 1, "cosine", None, None)
            .await
            .unwrap();

    let first = &results[0];
    assert_eq!(first.id, "chunk-0");
    assert_eq!(first.document_id, "doc-rust");
    assert_eq!(first.source, "rust-guide.pdf");
    assert!(!first.text.is_empty(), "text should not be empty");
    assert_eq!(first.chunk_index, 0);

    // Metadata should be parsed as JSON
    assert!(
        first.metadata.is_object(),
        "metadata should be a JSON object"
    );
    assert_eq!(
        first.metadata.get("language").unwrap().as_str().unwrap(),
        "rust"
    );
}

#[tokio::test]
async fn test_vector_search_l2_distance() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results = SearchEngine::vector_search(&table, &rust_query_vector(), 3, "l2", None, None)
        .await
        .unwrap();

    assert!(!results.is_empty());
    // Scores should be in [0, 1] even with L2
    for r in &results {
        assert!(r.score >= 0.0 && r.score <= 1.0);
    }
    // Top result should still be the closest (chunk-0)
    assert_eq!(results[0].id, "chunk-0");
}

// ===========================================================================
// FTS (Full-Text Search) tests
// ===========================================================================

#[tokio::test]
async fn test_fts_search_finds_keyword_matches() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "Rust safety performance", 5)
        .await
        .expect("FTS search should succeed");

    assert!(!results.is_empty(), "FTS should find keyword matches");

    // Results should contain rust-related chunks
    let result_ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert!(
        result_ids.contains(&"chunk-0") || result_ids.contains(&"chunk-2"),
        "FTS should find rust chunks mentioning safety/performance"
    );
}

#[tokio::test]
async fn test_fts_search_python_keywords() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "Python interpreted readability", 5)
        .await
        .unwrap();

    assert!(!results.is_empty());
    let result_ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert!(
        result_ids.contains(&"chunk-3"),
        "FTS should find Python intro chunk"
    );
}

#[tokio::test]
async fn test_fts_search_database_keywords() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "PostgreSQL database SQL", 5)
        .await
        .unwrap();

    assert!(!results.is_empty());
    let result_ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert!(
        result_ids.contains(&"chunk-7"),
        "FTS should find PostgreSQL chunk"
    );
}

#[tokio::test]
async fn test_fts_search_scores_are_normalized() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "programming language", 10)
        .await
        .unwrap();

    for r in &results {
        assert!(
            r.score >= 0.0 && r.score <= 1.0,
            "FTS score {} should be in [0, 1] for {}",
            r.score,
            r.id
        );
    }
}

#[tokio::test]
async fn test_fts_search_top_k_limits() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "programming", 2)
        .await
        .unwrap();

    assert!(results.len() <= 2, "Should not exceed top_k=2");
}

#[tokio::test]
async fn test_fts_search_no_match_query() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::fts_search(&table, "xyznonexistentterm12345", 5)
        .await
        .unwrap();

    assert!(
        results.is_empty(),
        "Non-matching query should return empty results"
    );
}

// ===========================================================================
// Hybrid search tests
// ===========================================================================

#[tokio::test]
async fn test_hybrid_search_combines_vector_and_fts() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::hybrid_search(
        &table,
        "Rust programming safety",
        &rust_query_vector(),
        5,
        "cosine",
        None,
        None,
        true,
    )
    .await
    .expect("Hybrid search should succeed");

    assert!(!results.is_empty(), "Hybrid search should return results");

    // The rust chunks should dominate (appear in both vector and FTS results)
    let top3_ids: Vec<&str> = results.iter().take(3).map(|r| r.id.as_str()).collect();
    let has_rust = top3_ids.iter().any(|id| {
        id.starts_with("chunk-0") || id.starts_with("chunk-1") || id.starts_with("chunk-2")
    });
    assert!(
        has_rust,
        "Top hybrid results should include rust chunks: {:?}",
        top3_ids
    );
}

#[tokio::test]
async fn test_hybrid_search_scores_in_range() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::hybrid_search(
        &table,
        "programming language",
        &rust_query_vector(),
        10,
        "cosine",
        None,
        None,
        true,
    )
    .await
    .unwrap();

    for r in &results {
        assert!(
            r.score >= 0.0 && r.score <= 1.0,
            "Hybrid score {} should be in [0, 1] for {}",
            r.score,
            r.id
        );
    }
}

#[tokio::test]
async fn test_hybrid_search_top_k_limits() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::hybrid_search(
        &table,
        "Rust",
        &rust_query_vector(),
        3,
        "cosine",
        None,
        None,
        true,
    )
    .await
    .unwrap();

    assert!(results.len() <= 3, "Hybrid should not exceed top_k=3");
}

#[tokio::test]
async fn test_hybrid_search_deduplicates_results() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::hybrid_search(
        &table,
        "Rust safety performance",
        &rust_query_vector(),
        10,
        "cosine",
        None,
        None,
        true,
    )
    .await
    .unwrap();

    // Check no duplicate IDs
    let mut seen_ids = std::collections::HashSet::new();
    for r in &results {
        assert!(
            seen_ids.insert(&r.id),
            "Duplicate ID found in hybrid results: {}",
            r.id
        );
    }
}

#[tokio::test]
async fn test_hybrid_search_without_reranking_returns_results() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    // Reranking disabled: hybrid still runs vector + FTS, but merges with a
    // plain score-based merge instead of RRF. It must still return sensible,
    // deduplicated, bounded results.
    let results = SearchEngine::hybrid_search(
        &table,
        "Rust programming safety",
        &rust_query_vector(),
        5,
        "cosine",
        None,
        None,
        false,
    )
    .await
    .expect("Hybrid search without reranking should succeed");

    assert!(
        !results.is_empty(),
        "Hybrid search without reranking should return results"
    );
    assert!(results.len() <= 5, "Should not exceed top_k=5");

    let mut seen_ids = std::collections::HashSet::new();
    for r in &results {
        assert!(
            seen_ids.insert(&r.id),
            "Duplicate ID found in un-reranked hybrid results: {}",
            r.id
        );
        assert!(
            r.score >= 0.0 && r.score <= 1.0,
            "Score {} for {} should be in [0, 1]",
            r.score,
            r.id
        );
    }
}

#[tokio::test]
async fn test_search_dispatcher_hybrid_reranker_none_disables_rrf() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    // rerankerType "none" routes hybrid through the plain merge path.
    let results = SearchEngine::search(
        &table,
        "Rust programming",
        &rust_query_vector(),
        "hybrid",
        5,
        0.0,
        "cosine",
        None,
        None,
        Some("none"),
    )
    .await
    .unwrap();

    assert!(
        !results.is_empty(),
        "Hybrid search with rerankerType=none should still return results"
    );
}

// ===========================================================================
// SearchEngine::search dispatcher tests (integrates mode selection)
// ===========================================================================

#[tokio::test]
async fn test_search_dispatcher_vector_mode() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results = SearchEngine::search(
        &table,
        "rust",
        &rust_query_vector(),
        "vector",
        5,
        0.0,
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!results.is_empty());
    assert_eq!(results[0].id, "chunk-0");
}

#[tokio::test]
async fn test_search_dispatcher_fts_mode() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::search(
        &table,
        "PostgreSQL database",
        &[], // empty vector — not needed for FTS
        "fts",
        5,
        0.0,
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!results.is_empty());
    let ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
    assert!(
        ids.contains(&"chunk-7"),
        "FTS mode should find PostgreSQL chunk"
    );
}

#[tokio::test]
async fn test_search_dispatcher_hybrid_mode() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, true).await;

    let results = SearchEngine::search(
        &table,
        "Rust programming",
        &rust_query_vector(),
        "hybrid",
        5,
        0.0,
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(!results.is_empty());
}

#[tokio::test]
async fn test_search_with_min_score_filter() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    // Get all results first without filter
    let all_results = SearchEngine::search(
        &table,
        "rust",
        &rust_query_vector(),
        "vector",
        10,
        0.0,
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(
        all_results.len() > 1,
        "Should have multiple results to filter"
    );

    // Now apply a high min_score to filter out low-scoring results
    let filtered = SearchEngine::search(
        &table,
        "rust",
        &rust_query_vector(),
        "vector",
        10,
        0.9, // high threshold
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // Filtered should have fewer results
    assert!(
        filtered.len() <= all_results.len(),
        "Filtered should have fewer or equal results"
    );

    // All filtered results should meet the threshold
    for r in &filtered {
        assert!(
            r.score >= 0.9,
            "Result {} has score {} which is below min_score 0.9",
            r.id,
            r.score
        );
    }
}

#[tokio::test]
async fn test_search_min_score_filters_everything() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    // Use an impossibly high min_score
    let results = SearchEngine::search(
        &table,
        "rust",
        &rust_query_vector(),
        "vector",
        10,
        0.9999, // nearly impossible threshold
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    // With such a high threshold, few or no results should pass
    for r in &results {
        assert!(r.score >= 0.9999);
    }
}

#[tokio::test]
async fn test_search_default_mode_is_vector() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    // Pass an unknown mode — should default to vector
    let results = SearchEngine::search(
        &table,
        "anything",
        &rust_query_vector(),
        "unknown_mode",
        3,
        0.0,
        "cosine",
        None,
        None,
        None,
    )
    .await
    .unwrap();

    assert!(
        !results.is_empty(),
        "Unknown mode should fall back to vector search"
    );
}

// ===========================================================================
// Edge cases
// ===========================================================================

#[tokio::test]
async fn test_vector_search_top_k_1() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 1, "cosine", None, None)
            .await
            .unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "chunk-0");
}

#[tokio::test]
async fn test_vector_search_top_k_exceeds_table_size() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results = SearchEngine::vector_search(
        &table,
        &rust_query_vector(),
        100, // way more than 10 chunks
        "cosine",
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        results.len(),
        NUM_CHUNKS,
        "Should return all {} chunks when top_k exceeds table size",
        NUM_CHUNKS
    );
}

#[tokio::test]
async fn test_hybrid_search_fallback_when_no_fts_index() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    // Create table WITHOUT FTS index
    let table = create_test_table(&temp_dir, false).await;

    // Hybrid search should still succeed by falling back to vector-only
    let results = SearchEngine::hybrid_search(
        &table,
        "Rust programming",
        &rust_query_vector(),
        5,
        "cosine",
        None,
        None,
        true,
    )
    .await
    .expect("Hybrid should fallback to vector-only when no FTS index");

    assert!(
        !results.is_empty(),
        "Should return vector-only results as fallback"
    );
}

#[tokio::test]
async fn test_vector_search_different_queries_return_different_top() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let rust_results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 1, "cosine", None, None)
            .await
            .unwrap();
    let python_results =
        SearchEngine::vector_search(&table, &python_query_vector(), 1, "cosine", None, None)
            .await
            .unwrap();
    let db_results =
        SearchEngine::vector_search(&table, &database_query_vector(), 1, "cosine", None, None)
            .await
            .unwrap();

    assert_ne!(
        rust_results[0].id, python_results[0].id,
        "Rust and Python queries should return different top results"
    );
    assert_ne!(
        rust_results[0].id, db_results[0].id,
        "Rust and DB queries should return different top results"
    );
    assert_ne!(
        python_results[0].id, db_results[0].id,
        "Python and DB queries should return different top results"
    );
}

// ===========================================================================
// Result field completeness tests
// ===========================================================================

#[tokio::test]
async fn test_all_result_fields_populated() {
    let temp_dir = tempfile::TempDir::new().unwrap();
    let table = create_test_table(&temp_dir, false).await;

    let results =
        SearchEngine::vector_search(&table, &rust_query_vector(), 10, "cosine", None, None)
            .await
            .unwrap();

    for r in &results {
        assert!(!r.id.is_empty(), "id should not be empty");
        assert!(!r.document_id.is_empty(), "document_id should not be empty");
        assert!(!r.source.is_empty(), "source should not be empty");
        assert!(!r.text.is_empty(), "text should not be empty");
        assert!(r.chunk_index >= 0, "chunk_index should be non-negative");
        assert!(r.score > 0.0, "score should be positive");
        assert!(!r.metadata.is_null(), "metadata should not be null");
        // download_url is None since we didn't enrich
        assert!(r.download_url.is_none());
    }
}
