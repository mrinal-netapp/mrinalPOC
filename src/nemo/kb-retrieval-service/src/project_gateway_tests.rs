use std::sync::Arc;

use super::*;

fn test_config() -> Config {
    Config {
        port: 5000,
        data_root: "/mnt/pvcs/default-nemo".to_string(),
        default_bucket_name: "test-bucket".to_string(),
        s3_public_endpoint: None,
        pool_max_size: 10,
        pool_ttl_seconds: 60,
        debug: false,
        k8s_namespace: "agentstudio".to_string(),
        llm_gateway_url: "http://bifrost-proxy:8080".to_string(),
        project_gateway_cache_ttl_secs: 300,
    }
}

fn sample_auth(project_id: &str, token: &str) -> Arc<ProjectGatewayAuth> {
    Arc::new(ProjectGatewayAuth {
        project_id: project_id.to_string(),
        llm_gateway_url: "http://bifrost:8080".to_string(),
        virtual_key_token: token.to_string(),
    })
}

#[test]
fn secret_name_matches_config_service_convention() {
    assert_eq!(
        project_virtual_key_secret_name("proj-abc"),
        "as-proj-proj-abc-vk"
    );
}

#[test]
fn validate_project_id_accepts_uuid_like() {
    validate_project_id("550e8400-e29b-41d4-a716-446655440000").unwrap();
}

#[test]
fn validate_project_id_accepts_underscore_and_dash() {
    validate_project_id("proj_1-test").unwrap();
}

#[test]
fn validate_project_id_rejects_empty() {
    assert!(validate_project_id("").is_err());
}

#[test]
fn validate_project_id_rejects_too_long() {
    assert!(validate_project_id(&"a".repeat(129)).is_err());
}

#[test]
fn validate_project_id_rejects_path_chars() {
    assert!(validate_project_id("../evil").is_err());
    assert!(validate_project_id("proj/1").is_err());
}

#[test]
fn project_gateway_auth_getters() {
    let auth = ProjectGatewayAuth {
        project_id: "p1".to_string(),
        llm_gateway_url: "http://gw".to_string(),
        virtual_key_token: "secret".to_string(),
    };
    assert_eq!(auth.project_id(), "p1");
    assert_eq!(auth.llm_gateway_url(), "http://gw");
    assert_eq!(auth.virtual_key_token(), "secret");
}

#[test]
fn project_gateway_auth_debug_redacts_token() {
    let auth = ProjectGatewayAuth {
        project_id: "p1".to_string(),
        llm_gateway_url: "http://gw".to_string(),
        virtual_key_token: "super-secret".to_string(),
    };
    let dbg = format!("{auth:?}");
    assert!(dbg.contains("p1"));
    assert!(dbg.contains("<redacted>"));
    assert!(!dbg.contains("super-secret"));
}

#[test]
fn gateway_lookup_diagnostic_ready() {
    let msg = GatewayLookup::Ready(sample_auth("p1", "tok")).diagnostic("p1");
    assert!(msg.contains("ready"));
    assert!(msg.contains("p1"));
}

#[test]
fn gateway_lookup_diagnostic_not_configured() {
    let msg = GatewayLookup::NotConfigured.diagnostic("my-proj");
    assert!(msg.contains("as-proj-my-proj-vk"));
    assert!(msg.contains("gateway-setup"));
}

#[test]
fn gateway_lookup_diagnostic_forbidden() {
    let msg = GatewayLookup::Forbidden("denied".into()).diagnostic("p1");
    assert!(msg.contains("RBAC"));
    assert!(msg.contains("denied"));
}

#[test]
fn gateway_lookup_diagnostic_malformed_secret() {
    let msg =
        GatewayLookup::MalformedSecret("missing virtual_key_token key".into()).diagnostic("p1");
    assert!(msg.contains("malformed"));
    assert!(msg.contains("virtual_key_token"));
}

#[test]
fn gateway_lookup_diagnostic_disabled() {
    let msg = GatewayLookup::Disabled.diagnostic("p1");
    assert!(msg.contains("disabled"));
    assert!(msg.contains("K8s"));
}

#[test]
fn gateway_lookup_diagnostic_invalid_project_id() {
    let msg = GatewayLookup::InvalidProjectId.diagnostic("../bad");
    assert!(msg.contains("validation"));
}

#[test]
fn gateway_lookup_diagnostic_lookup_error() {
    let msg = GatewayLookup::LookupError("network down".into()).diagnostic("p1");
    assert!(msg.contains("unexpected error"));
    assert!(msg.contains("network down"));
}

#[tokio::test]
async fn disabled_resolver_returns_disabled() {
    let config = test_config();
    let resolver = ProjectGatewayResolver::disabled_for_tests(&config);
    assert!(matches!(
        resolver.resolve("proj1").await,
        GatewayLookup::Disabled
    ));
}

#[tokio::test]
async fn disabled_resolver_resolve_optional_returns_none() {
    let config = test_config();
    let resolver = ProjectGatewayResolver::disabled_for_tests(&config);
    assert!(resolver.resolve_optional("proj1").await.is_none());
}

#[tokio::test]
async fn disabled_resolver_rejects_invalid_project_id() {
    let config = test_config();
    let resolver = ProjectGatewayResolver::disabled_for_tests(&config);
    assert!(matches!(
        resolver.resolve("../evil").await,
        GatewayLookup::InvalidProjectId
    ));
}

#[tokio::test]
async fn fixed_auth_resolver_returns_ready() {
    let config = test_config();
    let resolver = ProjectGatewayResolver::with_fixed_auth_for_tests(&config, "integration-vk");
    match resolver.resolve("proj1").await {
        GatewayLookup::Ready(auth) => assert_eq!(auth.virtual_key_token(), "integration-vk"),
        other => panic!("expected Ready, got {other:?}"),
    }
}

#[test]
fn fetch_outcome_not_found_maps_to_not_configured() {
    let lookup = FetchOutcome::NotFound.into_lookup("agentstudio", "proj1");
    assert!(matches!(lookup, GatewayLookup::NotConfigured));
}

#[test]
fn fetch_outcome_forbidden_maps_to_forbidden() {
    let lookup = FetchOutcome::Forbidden("denied".into()).into_lookup("ns", "p1");
    match lookup {
        GatewayLookup::Forbidden(msg) => assert_eq!(msg, "denied"),
        _ => panic!("expected Forbidden"),
    }
}

#[test]
fn fetch_outcome_missing_key_maps_to_malformed() {
    let lookup = FetchOutcome::MissingKey.into_lookup("ns", "p1");
    assert!(matches!(lookup, GatewayLookup::MalformedSecret(_)));
}

#[test]
fn fetch_outcome_empty_token_maps_to_malformed() {
    let lookup = FetchOutcome::EmptyToken.into_lookup("ns", "p1");
    assert!(matches!(lookup, GatewayLookup::MalformedSecret(_)));
}

#[test]
fn fetch_outcome_error_maps_to_lookup_error() {
    let lookup = FetchOutcome::Error("network".into()).into_lookup("ns", "p1");
    match lookup {
        GatewayLookup::LookupError(msg) => assert_eq!(msg, "network"),
        _ => panic!("expected LookupError"),
    }
}

#[tokio::test]
async fn disabled_resolver_resolve_required_errors() {
    let config = test_config();
    let resolver = ProjectGatewayResolver::disabled_for_tests(&config);
    let err = resolver
        .resolve_required("proj1")
        .await
        .expect_err("disabled resolver must fail required lookup");
    assert!(err.to_string().contains("as-proj-proj1-vk"));
}
