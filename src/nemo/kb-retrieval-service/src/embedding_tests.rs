use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

struct MockEmbeddingsServer {
    base_url: String,
    _handle: tokio::task::JoinHandle<()>,
}

/// Spin up a minimal HTTP server that returns canned responses in order.
async fn spawn_mock_server(responses: Vec<(u16, String, Option<u64>)>) -> MockEmbeddingsServer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let counter = Arc::new(AtomicUsize::new(0));
    let responses = Arc::new(responses);

    let handle = tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let idx = counter.fetch_add(1, Ordering::SeqCst);
            let (status, body, retry_after) = responses
                .get(idx)
                .or_else(|| responses.last())
                .cloned()
                .unwrap_or((500, "{}".to_string(), None));

            let mut buf = vec![0u8; 8192];
            let _ = stream.read(&mut buf).await;

            let status_text = match status {
                200 => "OK",
                400 => "Bad Request",
                401 => "Unauthorized",
                429 => "Too Many Requests",
                500 => "Internal Server Error",
                _ => "Error",
            };
            let retry_hdr = retry_after
                .map(|s| format!("Retry-After: {s}\r\n"))
                .unwrap_or_default();
            let response = format!(
                "HTTP/1.1 {status} {status_text}\r\nContent-Type: application/json\r\n{retry_hdr}Content-Length: {}\r\n\r\n{body}",
                body.len(),
                body = body
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });

    MockEmbeddingsServer {
        base_url: format!("http://{addr}"),
        _handle: handle,
    }
}

fn success_body(embedding: &[f32], index: usize) -> String {
    let values: Vec<String> = embedding.iter().map(|v| v.to_string()).collect();
    format!(
        r#"{{"data":[{{"embedding":[{}],"index":{index}}}]}}"#,
        values.join(",")
    )
}

#[test]
fn gateway_url_trims_trailing_slash() {
    let svc = EmbeddingService::new("http://bifrost:8080/".into());
    assert!(svc.is_ready());
}

#[tokio::test]
async fn encode_query_success_returns_embedding() {
    let server = spawn_mock_server(vec![(200, success_body(&[0.1, 0.2, 0.3], 0), None)]).await;
    let svc = EmbeddingService::new(server.base_url);
    let vec = svc
        .encode_query("test-model", "hello world", "vk-token")
        .await
        .expect("embedding should succeed");
    assert_eq!(vec, vec![0.1, 0.2, 0.3]);
}

#[tokio::test]
async fn encode_query_sorts_by_index() {
    let body = r#"{"data":[{"embedding":[1.0],"index":1},{"embedding":[2.0],"index":0}]}"#;
    let server = spawn_mock_server(vec![(200, body.to_string(), None)]).await;
    let svc = EmbeddingService::new(server.base_url);
    let vec = svc
        .encode_query("test-model", "q", "vk")
        .await
        .expect("should pick lowest index after sort");
    assert_eq!(vec, vec![2.0]);
}

#[tokio::test]
async fn encode_query_401_fails_immediately() {
    let server = spawn_mock_server(vec![(401, r#"{"error":"bad key"}"#.to_string(), None)]).await;
    let svc = EmbeddingService::new(server.base_url);
    let err = svc
        .encode_query("test-model", "q", "vk")
        .await
        .expect_err("401 must not retry");
    let msg = err.to_string();
    assert!(msg.contains("401"));
    assert!(msg.contains("virtual-key"));
}

#[tokio::test]
async fn encode_query_400_fails_without_retry() {
    let server = spawn_mock_server(vec![(
        400,
        r#"{"error":"model_blocked"}"#.to_string(),
        None,
    )])
    .await;
    let svc = EmbeddingService::new(server.base_url);
    let err = svc
        .encode_query("blocked-model", "q", "vk")
        .await
        .expect_err("4xx client errors must fail fast");
    assert!(err.to_string().contains("HTTP 400"));
}

#[tokio::test]
async fn encode_query_retries_on_500_then_succeeds() {
    let server = spawn_mock_server(vec![
        (500, r#"{"error":"cold start"}"#.to_string(), None),
        (200, success_body(&[0.5], 0), None),
    ])
    .await;
    let svc = EmbeddingService::new(server.base_url);
    let vec = svc
        .encode_query("test-model", "q", "vk")
        .await
        .expect("should succeed after one retry");
    assert_eq!(vec, vec![0.5]);
}

#[tokio::test]
async fn encode_query_empty_data_entries() {
    let server = spawn_mock_server(vec![(200, r#"{"data":[]}"#.to_string(), None)]).await;
    let svc = EmbeddingService::new(server.base_url);
    let err = svc
        .encode_query("m", "q", "vk")
        .await
        .expect_err("empty data must error");
    assert!(err.to_string().contains("no data entries"));
}

#[tokio::test]
async fn encode_query_empty_embedding_vector() {
    let server = spawn_mock_server(vec![(
        200,
        r#"{"data":[{"embedding":[],"index":0}]}"#.to_string(),
        None,
    )])
    .await;
    let svc = EmbeddingService::new(server.base_url);
    let err = svc
        .encode_query("m", "q", "vk")
        .await
        .expect_err("empty vector must error");
    assert!(err.to_string().contains("empty vector"));
}

#[tokio::test]
async fn encode_query_rejects_illegal_api_key_header() {
    let server = spawn_mock_server(vec![(200, success_body(&[1.0], 0), None)]).await;
    let svc = EmbeddingService::new(server.base_url);
    let err = svc
        .encode_query("m", "q", "bad\nkey")
        .await
        .expect_err("newline in api_key is illegal in headers");
    assert!(err.to_string().contains("illegal in an HTTP header"));
}

#[tokio::test]
async fn encode_query_retries_on_429_with_retry_after() {
    let server = spawn_mock_server(vec![
        (429, r#"{"error":"rate limited"}"#.to_string(), Some(0)),
        (200, success_body(&[0.9], 0), None),
    ])
    .await;
    let svc = EmbeddingService::new(server.base_url);
    let vec = svc
        .encode_query("test-model", "q", "vk")
        .await
        .expect("should succeed after 429 retry");
    assert_eq!(vec, vec![0.9]);
}

#[test]
fn is_ready_false_when_url_empty() {
    let svc = EmbeddingService::new(String::new());
    assert!(!svc.is_ready());
}

#[test]
fn is_ready_true_when_url_present() {
    let svc = EmbeddingService::new("http://bifrost:8080".into());
    assert!(svc.is_ready());
}

#[tokio::test]
async fn encode_query_errors_on_empty_url() {
    let svc = EmbeddingService::new(String::new());
    let err = svc
        .encode_query("model", "hello", "key")
        .await
        .expect_err("should fail when gateway URL is unset");
    assert!(err.to_string().contains("LLM_GATEWAY_URL"));
}

#[tokio::test]
async fn encode_query_errors_on_empty_api_key() {
    let svc = EmbeddingService::new("http://bifrost:8080".into());
    let err = svc
        .encode_query("model", "hello", "")
        .await
        .expect_err("should fail when api_key is unset");
    assert!(err.to_string().contains("virtual-key token"));
}

#[test]
fn fastrand_secs_is_bounded() {
    let v = fastrand_secs(10);
    assert!((0.0..=10.0).contains(&v));
}
