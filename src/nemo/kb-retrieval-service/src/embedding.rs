//! Gateway-backed embedding for query encoding.
//!
//! Replaces the previous in-process ONNX + tokenizer pipeline with an HTTP
//! call to Bifrost (`/litellm/v1/embeddings`). Bifrost routes the model
//! name to the correct upstream — for built-ins this is the in-cluster
//! TEI Service (e.g., `tei-minilm`); for user-registered remote models it's
//! the upstream provider keyed by the project's virtual key.
//!
//! Auth is per-call: the project's Bifrost virtual-key bearer is resolved
//! by the route handler (via `ProjectGatewayResolver`) and threaded into
//! [`EmbeddingService::encode_query`] as the `api_key` argument.

use anyhow::{Context, Result, anyhow};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tracing::{debug, warn};

/// Provider-qualified Bifrost wire ID for legacy MiniLM KBs whose metadata
/// lacks an explicit embedding-model identifier.
pub const DEFAULT_MODEL_NAME: &str = "as-tei-minilm/sentence-transformers__all-MiniLM-L6-v2";

/// Per-request HTTP timeout. TEI's ORT backend can be slow on cold start.
const REQUEST_TIMEOUT_SECONDS: u64 = 120;

/// Max retries for network + 429 + 5xx errors. Ported from
/// unified-embedding-bifrost so a cold-starting TEI Deployment or a
/// momentarily-overloaded Bifrost doesn't surface as a hard 503 to the
/// search caller. 401 is NEVER retried — bad credentials don't get
/// better with time.
const MAX_RETRIES: u8 = 5;

#[derive(Clone)]
pub struct EmbeddingService {
    http: reqwest::Client,
    gateway_url: String,
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: Vec<&'a str>,
    encoding_format: &'static str,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingEntry>,
}

#[derive(Deserialize)]
struct EmbeddingEntry {
    embedding: Vec<f32>,
    #[serde(default)]
    index: usize,
}

impl EmbeddingService {
    /// Construct a new embedding client.
    ///
    /// `gateway_url` is the Bifrost base URL (no trailing slash). When empty,
    /// [`EmbeddingService::is_ready`] returns false and every call fails
    /// fast with a clear error.
    pub fn new(gateway_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            // Reuse up to 16 idle TCP connections per Bifrost host so a
            // search burst doesn't pay a fresh handshake per query. Ported
            // from unified-embedding-bifrost.
            .pool_max_idle_per_host(16)
            .build()
            .expect("reqwest client builder cannot fail with default config");
        Self {
            http,
            gateway_url: gateway_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn is_ready(&self) -> bool {
        !self.gateway_url.is_empty()
    }

    /// Encode a single query string. The caller supplies the per-project
    /// Bifrost virtual-key bearer (`api_key`). Bearer is intentionally NOT
    /// stored on the service — different requests in the same kb-retrieval
    /// pod may carry different projects' VKs.
    ///
    /// # Errors
    ///
    /// Returns an error when the gateway URL or API key is empty (the project
    /// gateway hasn't been set up yet), when the HTTP request fails, or when
    /// the response shape is not OpenAI-embeddings-compatible.
    pub async fn encode_query(
        &self,
        model_name: &str,
        query: &str,
        api_key: &str,
    ) -> Result<Vec<f32>> {
        if self.gateway_url.is_empty() {
            anyhow::bail!("Embedding service is not ready: LLM_GATEWAY_URL is empty");
        }
        if api_key.is_empty() {
            anyhow::bail!(
                "Embedding service is not ready: project virtual-key token is empty (gateway-setup may not have completed for this project yet)"
            );
        }

        let url = format!("{}/litellm/v1/embeddings", self.gateway_url);
        let mut headers = HeaderMap::new();
        let bearer = HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|_| anyhow!("api_key contained characters illegal in an HTTP header"))?;
        let x_api_key = HeaderValue::from_str(api_key)
            .map_err(|_| anyhow!("api_key contained characters illegal in an HTTP header"))?;
        headers.insert(AUTHORIZATION, bearer);
        // Bifrost accepts either header; sending both protects against
        // auth-middleware reshuffling on the gateway side.
        headers.insert("x-api-key", x_api_key);
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let body = EmbeddingRequest {
            model: model_name,
            input: vec![query],
            // `encoding_format: "float"` is critical — without it Bifrost
            // returns base64-encoded vectors. See commit a7310c1d.
            encoding_format: "float",
        };

        debug!(
            "POST {} model={} query_len={}",
            url,
            model_name,
            query.len()
        );

        // Retry loop ported from unified-embedding-bifrost — retries network
        // failures, 429, and 5xx with exponential backoff and Retry-After
        // honoring. 401 fails immediately with a credentials-specific message;
        // other 4xx fail immediately because they're not transient. Without
        // this, a TEI cold start (~30–60s before the ORT backend warms) or a
        // brief Bifrost restart surfaces as a hard query failure instead of
        // self-healing.
        let mut attempt: u8 = 0;
        loop {
            attempt += 1;
            let resp = match self
                .http
                .post(&url)
                .headers(headers.clone())
                .json(&body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(err) => {
                    if attempt > MAX_RETRIES {
                        return Err(err).with_context(|| {
                            format!(
                                "Embedding gateway POST {} failed after {} attempts",
                                url, MAX_RETRIES
                            )
                        });
                    }
                    sleep_backoff(attempt, format!("network: {}", err)).await;
                    continue;
                }
            };

            let status = resp.status();
            if status.is_success() {
                let parsed: EmbeddingResponse = resp
                    .json()
                    .await
                    .with_context(|| "Embedding gateway response was not valid JSON")?;
                let mut entries = parsed.data;
                if entries.is_empty() {
                    anyhow::bail!("Embedding gateway returned no data entries");
                }
                // Sort by index defensively; Bifrost should preserve order but
                // the OpenAI spec doesn't strictly require it for parallel-batch
                // responses.
                entries.sort_by_key(|e| e.index);
                let first = entries.swap_remove(0);
                if first.embedding.is_empty() {
                    anyhow::bail!("Embedding gateway returned an empty vector");
                }
                return Ok(first.embedding);
            }

            // 401 is never transient — return immediately with a hint that
            // points at the credential / VK rather than the network.
            if status.as_u16() == 401 {
                let snippet: String = resp
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(512)
                    .collect();
                anyhow::bail!(
                    "Embedding gateway returned 401 for model {} — verify the project's Bifrost virtual-key token is correct and that gateway-setup completed. body: {}",
                    model_name,
                    snippet
                );
            }

            // 429 (rate limited) and 5xx (server transient) are worth
            // retrying. Honor Retry-After when the server sends one.
            if status.as_u16() == 429 || status.is_server_error() {
                if attempt > MAX_RETRIES {
                    let snippet: String = resp
                        .text()
                        .await
                        .unwrap_or_default()
                        .chars()
                        .take(512)
                        .collect();
                    anyhow::bail!(
                        "Embedding gateway exhausted {} retries for model {}: status={} body={}",
                        MAX_RETRIES,
                        model_name,
                        status,
                        snippet
                    );
                }
                let retry_after = parse_retry_after(&resp);
                sleep_backoff(attempt, format!("http {}", status))
                    .await
                    .min_wait(retry_after)
                    .await;
                continue;
            }

            // Other 4xx (400, 403, 404, etc.) are caller errors — don't retry,
            // and surface the body so the caller can see e.g. "model_blocked"
            // from the VK allowed_models check.
            let snippet: String = resp
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(512)
                .collect();
            anyhow::bail!(
                "Embedding gateway returned HTTP {} for model {}: {}",
                status,
                model_name,
                snippet
            );
        }
    }
}

/// Sleep with exponential backoff + jitter, then return a [`Backoff`] handle
/// the caller can use to extend the delay to a server-supplied Retry-After.
/// Ported from unified-embedding-bifrost.
async fn sleep_backoff(attempt: u8, reason: String) -> Backoff {
    // Unit tests use a near-zero delay so retry paths stay fast/deterministic
    // without relying on a paused Tokio clock (reqwest still performs real I/O).
    #[cfg(test)]
    let delay = Duration::from_millis(1);
    #[cfg(not(test))]
    let delay = {
        // base = min(2^attempt, 30) seconds. Jitter scales by 0..1 to spread
        // retries from a fleet of pods so they don't thunder against Bifrost
        // simultaneously on a coordinated 5xx wave.
        let base = 2_u64.saturating_pow(attempt as u32).min(30);
        let jitter = fastrand_secs(base);
        Duration::from_secs_f64(jitter)
    };
    warn!(
        "[embedding] retry {}/{} in {:.1}s ({})",
        attempt,
        MAX_RETRIES,
        delay.as_secs_f64(),
        reason
    );
    tokio::time::sleep(delay).await;
    Backoff
}

/// Marker returned by [`sleep_backoff`]; lets callers chain a server
/// Retry-After wait on top of the jittered exponential delay without
/// duplicating the sleep code.
struct Backoff;

impl Backoff {
    async fn min_wait(self, extra: Duration) {
        if extra > Duration::ZERO {
            tokio::time::sleep(extra).await;
        }
    }
}

fn parse_retry_after(resp: &reqwest::Response) -> Duration {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or_default()
}

/// Tiny jitter helper that avoids a `rand`/`fastrand` dependency by using
/// the system clock's sub-second nanoseconds. Good enough for retry
/// spreading; not cryptographically random.
fn fastrand_secs(base: u64) -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos as f64 / 1_000_000_000.0) * base as f64
}

#[cfg(test)]
#[path = "embedding_tests.rs"]
mod tests;
