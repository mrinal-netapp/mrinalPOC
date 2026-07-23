//! Shared fixtures for integration tests (route handlers + pool).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use arrow_array::{FixedSizeListArray, Float32Array, Int64Array, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const TEST_DIM: i32 = 8;

struct TestChunk {
    id: &'static str,
    document_id: &'static str,
    source: &'static str,
    text: &'static str,
    chunk_index: i64,
    vector: [f32; 8],
    metadata_json: &'static str,
}

fn test_chunks() -> Vec<TestChunk> {
    vec![
        TestChunk {
            id: "chunk-0",
            document_id: "doc-rust",
            source: "rust-guide.pdf",
            text: "Rust is a systems programming language focused on safety and performance",
            chunk_index: 0,
            vector: [0.9, 0.8, 0.1, 0.05, 0.05, 0.1, 0.05, 0.1],
            metadata_json: r#"{"file_path":"projects/p1/files/rust-guide.pdf"}"#,
        },
        TestChunk {
            id: "chunk-1",
            document_id: "doc-rust",
            source: "rust-guide.pdf",
            text: "Rust ownership model ensures memory safety without garbage collection",
            chunk_index: 1,
            vector: [0.85, 0.75, 0.15, 0.05, 0.1, 0.05, 0.1, 0.05],
            metadata_json: r#"{"file_path":"projects/p1/files/rust-guide.pdf"}"#,
        },
        TestChunk {
            id: "chunk-2",
            document_id: "doc-python",
            source: "python-intro.pdf",
            text: "Python is a high-level interpreted programming language",
            chunk_index: 0,
            vector: [0.1, 0.15, 0.85, 0.8, 0.05, 0.1, 0.05, 0.1],
            metadata_json: r#"{"file_path":"projects/p1/files/python-intro.pdf"}"#,
        },
    ]
}

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

fn build_record_batch(chunks: &[TestChunk]) -> RecordBatch {
    let schema = test_schema();
    let ids = StringArray::from(chunks.iter().map(|c| c.id).collect::<Vec<_>>());
    let doc_ids = StringArray::from(chunks.iter().map(|c| c.document_id).collect::<Vec<_>>());
    let sources = StringArray::from(chunks.iter().map(|c| c.source).collect::<Vec<_>>());
    let texts = StringArray::from(chunks.iter().map(|c| c.text).collect::<Vec<_>>());
    let chunk_indices = Int64Array::from(chunks.iter().map(|c| c.chunk_index).collect::<Vec<_>>());
    let metadatas = StringArray::from(chunks.iter().map(|c| c.metadata_json).collect::<Vec<_>>());

    let flat_values: Vec<f32> = chunks
        .iter()
        .flat_map(|c| c.vector.iter().copied())
        .collect();
    let values_array = Float32Array::from(flat_values);
    let vector_field = Arc::new(Field::new("item", DataType::Float32, true));
    let vector_array =
        FixedSizeListArray::try_new(vector_field, TEST_DIM, Arc::new(values_array), None)
            .expect("vector column");

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
    .expect("record batch")
}

/// Default query embedding returned by [`spawn_embedding_mock`].
pub fn rust_query_embedding() -> Vec<f32> {
    vec![0.9, 0.8, 0.1, 0.05, 0.05, 0.1, 0.05, 0.1]
}

/// Create `kb_vectors` at `lance_dir` with a small deterministic dataset.
pub async fn seed_lancedb_table(lance_dir: &Path, with_fts: bool) {
    std::fs::create_dir_all(lance_dir).expect("lance dir");
    let chunks = test_chunks();
    let batch = build_record_batch(&chunks);
    let arrow_schema = test_schema();

    let db = lancedb::connect(lance_dir.to_str().unwrap())
        .execute()
        .await
        .expect("connect lancedb");

    let table = db
        .create_table(
            "kb_vectors",
            arrow_array::RecordBatchIterator::new(vec![Ok(batch)], arrow_schema),
        )
        .execute()
        .await
        .expect("create table");

    if with_fts {
        table
            .create_index(
                &["text"],
                lancedb::index::Index::FTS(lancedb::index::scalar::FtsIndexBuilder::default()),
            )
            .execute()
            .await
            .expect("fts index");
    }
}

/// Write metadata.json beside a KB directory.
pub fn write_metadata(kb_dir: &Path, lance_table_path: &str, indexing_mode: &str, with_fts: bool) {
    std::fs::create_dir_all(kb_dir).expect("kb dir");
    let meta = serde_json::json!({
        "lanceTablePath": lance_table_path,
        "indexingMode": indexing_mode,
        "vectorSize": TEST_DIM,
        "embeddingGatewayModelId": "test-model",
        "hasVectorIndex": true,
        "vectorIndexMetric": "cosine",
        "hasFtsIndex": with_fts,
        "chunkCount": 3,
        "documentCount": 2,
    });
    std::fs::write(
        kb_dir.join("metadata.json"),
        serde_json::to_string_pretty(&meta).unwrap(),
    )
    .expect("metadata.json");
}

/// Layout under `data_root`: projects/{project}/knowledgebases/{kb}/ + LanceDB run dir.
pub struct KbFixture {
    pub data_root: PathBuf,
    pub project_id: String,
    pub kb_id: String,
    pub lance_path: PathBuf,
    pub embedding_gateway_url: String,
    _temp: tempfile::TempDir,
}

impl KbFixture {
    pub async fn vector_kb() -> Self {
        Self::build("semantic", false).await
    }

    pub async fn hybrid_kb() -> Self {
        Self::build("hybrid", true).await
    }

    async fn build(indexing_mode: &str, with_fts: bool) -> Self {
        let temp = tempfile::tempdir().expect("tempdir");
        let data_root = temp.path().to_path_buf();
        let project_id = "proj1".to_string();
        let kb_id = "kb1".to_string();
        let kb_dir = data_root
            .join("projects")
            .join(&project_id)
            .join("knowledgebases")
            .join(&kb_id);
        let lance_path = kb_dir.join("lancedb-run-test");
        seed_lancedb_table(&lance_path, with_fts).await;
        write_metadata(
            &kb_dir,
            &lance_path.to_string_lossy(),
            indexing_mode,
            with_fts,
        );

        let embedding_gateway_url = spawn_embedding_mock(rust_query_embedding()).await;

        Self {
            data_root,
            project_id,
            kb_id,
            lance_path,
            embedding_gateway_url,
            _temp: temp,
        }
    }

    pub fn kb_dir(&self) -> PathBuf {
        self.data_root
            .join("projects")
            .join(&self.project_id)
            .join("knowledgebases")
            .join(&self.kb_id)
    }
}

/// Minimal HTTP server that always returns one embedding vector.
pub async fn spawn_embedding_mock(embedding: Vec<f32>) -> String {
    let values: Vec<String> = embedding.iter().map(|v| v.to_string()).collect();
    let body = format!(
        r#"{{"data":[{{"embedding":[{}],"index":0}}]}}"#,
        values.join(",")
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = Arc::new(body);

    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let _ = stream.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });

    format!("http://{addr}")
}

/// Mock server that counts requests (for embedding-cache assertions).
pub async fn spawn_embedding_mock_counting(embedding: Vec<f32>) -> (String, Arc<AtomicUsize>) {
    let values: Vec<String> = embedding.iter().map(|v| v.to_string()).collect();
    let body = Arc::new(format!(
        r#"{{"data":[{{"embedding":[{}],"index":0}}]}}"#,
        values.join(",")
    ));
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_bg = hits.clone();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let body = body.clone();
            let hits = hits_bg.clone();
            tokio::spawn(async move {
                hits.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 8192];
                let _ = stream.read(&mut buf).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            });
        }
    });

    (format!("http://{addr}"), hits)
}
