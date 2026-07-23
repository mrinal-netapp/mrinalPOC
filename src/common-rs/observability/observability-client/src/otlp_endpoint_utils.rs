//! OTLP HTTP endpoint normalization helpers.
//!
//! Mirrors `NormalizeOTLPHttpTracesEndpoint` / `NormalizeOTLPHttpMetricsEndpoint`
//! from the Go client. The OTLP HTTP exporter wants the *full* signal URL
//! (e.g. `http://host:4318/v1/traces`) — the user-facing endpoint config is the
//! base, so we append the signal suffix when missing.

fn append_signal_path(endpoint: &str, export_path: &str) -> String {
    if endpoint.ends_with('/') {
        format!("{endpoint}{export_path}")
    } else {
        format!("{endpoint}/{export_path}")
    }
}

/// Ensure the URL ends with `/v1/traces`.
pub fn normalize_otlp_http_traces_endpoint(url: &str) -> String {
    let u = url.trim();
    if u.is_empty() {
        return String::new();
    }
    let base = u.trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("v1/traces") {
        return base.to_string();
    }
    append_signal_path(base, "v1/traces")
}

/// Ensure the URL ends with `/v1/metrics`.
pub fn normalize_otlp_http_metrics_endpoint(url: &str) -> String {
    let u = url.trim();
    if u.is_empty() {
        return String::new();
    }
    let base = u.trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("v1/metrics") {
        return base.to_string();
    }
    append_signal_path(base, "v1/metrics")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_traces_endpoint() {
        assert_eq!(
            normalize_otlp_http_traces_endpoint("http://localhost:4318"),
            "http://localhost:4318/v1/traces"
        );
        assert_eq!(
            normalize_otlp_http_traces_endpoint("http://localhost:4318/"),
            "http://localhost:4318/v1/traces"
        );
        assert_eq!(
            normalize_otlp_http_traces_endpoint("http://localhost:4318/v1/traces"),
            "http://localhost:4318/v1/traces"
        );
    }

    #[test]
    fn normalizes_metrics_endpoint() {
        assert_eq!(
            normalize_otlp_http_metrics_endpoint("http://collector:4318"),
            "http://collector:4318/v1/metrics"
        );
        assert_eq!(
            normalize_otlp_http_metrics_endpoint("https://collector.local/v1/metrics/"),
            "https://collector.local/v1/metrics"
        );
        assert!(normalize_otlp_http_metrics_endpoint("   ").is_empty());
    }
}
