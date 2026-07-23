use super::*;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::config::Config;
use crate::embedding::EmbeddingService;
use crate::pool::ConnectionPool;
use crate::project_gateway::{GatewayLookup, ProjectGatewayResolver};

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
fn test_request_metrics_new() {
    let metrics = AppRequestMetrics::new();
    assert_eq!(metrics.total.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.successful.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.failed.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.total_latency_us.load(Ordering::Relaxed), 0);
}

#[test]
fn test_record_success() {
    let metrics = AppRequestMetrics::new();
    metrics.record_success(1000);
    assert_eq!(metrics.total.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.successful.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.failed.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.total_latency_us.load(Ordering::Relaxed), 1000);
}

#[test]
fn test_record_failure() {
    let metrics = AppRequestMetrics::new();
    metrics.record_failure(500);
    assert_eq!(metrics.total.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.successful.load(Ordering::Relaxed), 0);
    assert_eq!(metrics.failed.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.total_latency_us.load(Ordering::Relaxed), 500);
}

#[test]
fn test_record_multiple_requests() {
    let metrics = AppRequestMetrics::new();
    metrics.record_success(1000);
    metrics.record_success(2000);
    metrics.record_failure(500);
    metrics.record_success(3000);
    metrics.record_failure(1500);

    assert_eq!(metrics.total.load(Ordering::Relaxed), 5);
    assert_eq!(metrics.successful.load(Ordering::Relaxed), 3);
    assert_eq!(metrics.failed.load(Ordering::Relaxed), 2);
    assert_eq!(
        metrics.total_latency_us.load(Ordering::Relaxed),
        1000 + 2000 + 500 + 3000 + 1500
    );
}

#[test]
fn test_record_zero_latency() {
    let metrics = AppRequestMetrics::new();
    metrics.record_success(0);
    assert_eq!(metrics.total.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.total_latency_us.load(Ordering::Relaxed), 0);
}

#[test]
fn test_avg_latency_calculation() {
    let metrics = AppRequestMetrics::new();
    metrics.record_success(1000);
    metrics.record_success(2000);
    metrics.record_success(3000);

    let total = metrics.total.load(Ordering::Relaxed);
    let total_latency_us = metrics.total_latency_us.load(Ordering::Relaxed);
    let avg_latency_ms = (total_latency_us as f64) / (total as f64) / 1000.0;
    assert!((avg_latency_ms - 2.0).abs() < 1e-9);
}

#[test]
fn test_avg_latency_zero_requests() {
    let metrics = AppRequestMetrics::new();
    let total = metrics.total.load(Ordering::Relaxed);
    let avg = if total > 0 {
        let total_latency_us = metrics.total_latency_us.load(Ordering::Relaxed);
        (total_latency_us as f64) / (total as f64) / 1000.0
    } else {
        0.0
    };
    assert_eq!(avg, 0.0);
}

#[test]
fn test_concurrent_metric_recording() {
    use std::thread;

    let metrics = Arc::new(AppRequestMetrics::new());
    let mut handles = vec![];

    for _ in 0..10 {
        let m = metrics.clone();
        handles.push(thread::spawn(move || {
            for _ in 0..100 {
                m.record_success(100);
            }
        }));
    }

    for _ in 0..5 {
        let m = metrics.clone();
        handles.push(thread::spawn(move || {
            for _ in 0..100 {
                m.record_failure(50);
            }
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    assert_eq!(metrics.total.load(Ordering::Relaxed), 1500);
    assert_eq!(metrics.successful.load(Ordering::Relaxed), 1000);
    assert_eq!(metrics.failed.load(Ordering::Relaxed), 500);
    assert_eq!(
        metrics.total_latency_us.load(Ordering::Relaxed),
        1000 * 100 + 500 * 50
    );
}

#[tokio::test]
async fn test_project_gateway_lookup_returns_ready_with_fixed_auth() {
    let config = test_config();
    let pool = Arc::new(ConnectionPool::new(config.clone()));
    let embedding = Arc::new(EmbeddingService::new("http://bifrost:8080".into()));
    let state = AppState {
        config: config.clone(),
        pool,
        embedding,
        project_gateway: Arc::new(ProjectGatewayResolver::with_fixed_auth_for_tests(
            &config, "vk",
        )),
        request_metrics: Arc::new(AppRequestMetrics::new()),
    };
    match state.project_gateway_lookup("proj1").await {
        GatewayLookup::Ready(auth) => assert_eq!(auth.virtual_key_token(), "vk"),
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn test_app_state_get_metrics() {
    let config = test_config();
    let pool = Arc::new(ConnectionPool::new(config.clone()));
    pool.stats.hits.store(10, Ordering::Relaxed);
    pool.stats.misses.store(2, Ordering::Relaxed);
    pool.stats.evictions.store(1, Ordering::Relaxed);

    let embedding = Arc::new(EmbeddingService::new(String::new()));
    let request_metrics = Arc::new(AppRequestMetrics::new());
    request_metrics.record_success(2000);
    request_metrics.record_failure(500);

    let state = AppState {
        config: config.clone(),
        pool,
        embedding,
        project_gateway: Arc::new(ProjectGatewayResolver::disabled_for_tests(&config)),
        request_metrics,
    };

    let m = state.get_metrics();
    assert_eq!(m.connection_pool.hits, 10);
    assert_eq!(m.connection_pool.misses, 2);
    assert_eq!(m.connection_pool.evictions, 1);
    assert!((m.connection_pool.hit_rate - (10.0 / 12.0 * 100.0)).abs() < 1e-6);
    assert_eq!(m.connection_pool.max_size, 10);
    assert_eq!(m.requests.total, 2);
    assert_eq!(m.requests.successful, 1);
    assert_eq!(m.requests.failed, 1);
    assert!((m.requests.avg_latency_ms - 1.25).abs() < 1e-6);
}
