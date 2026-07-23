//! Per-project Bifrost virtual-key credentials.
//!
//! Mirrors config-service `readProjectVirtualKeyToken`: the bearer lives in K8s
//! Secret `as-proj-{projectId}-vk` (key `virtual_key_token`). Future gateway-backed
//! embedding paths should use [`ProjectGatewayAuth::virtual_key_token`] with
//! [`ProjectGatewayAuth::llm_gateway_url`].

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, bail};
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use moka::future::Cache;
use tracing::{debug, warn};

use crate::config::Config;

const VK_TOKEN_SECRET_KEY: &str = "virtual_key_token";

/// Bifrost credentials scoped to one AgentStudio project.
#[derive(Clone)]
pub struct ProjectGatewayAuth {
    project_id: String,
    llm_gateway_url: String,
    virtual_key_token: String,
}

impl ProjectGatewayAuth {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn llm_gateway_url(&self) -> &str {
        &self.llm_gateway_url
    }

    pub fn virtual_key_token(&self) -> &str {
        &self.virtual_key_token
    }
}

impl std::fmt::Debug for ProjectGatewayAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectGatewayAuth")
            .field("project_id", &self.project_id)
            .field("llm_gateway_url", &self.llm_gateway_url)
            .field("virtual_key_token", &"<redacted>")
            .finish()
    }
}

enum ResolverBackend {
    K8s(Api<Secret>),
    Disabled,
    /// Integration tests only — production uses K8s or Disabled.
    #[allow(dead_code)]
    Fixed(String),
}

/// Resolves project virtual keys from the cluster (when running in Kubernetes).
pub struct ProjectGatewayResolver {
    namespace: String,
    llm_gateway_url: String,
    cache: Cache<String, Arc<ProjectGatewayAuth>>,
    backend: ResolverBackend,
}

impl ProjectGatewayResolver {
    /// Test / local runs without a Kubernetes API (used by integration tests, not the binary).
    ///
    /// Gated behind `cfg(test)` / the `test-support` feature so it is never
    /// compiled into production/release builds. `allow(dead_code)` covers the
    /// feature-enabled lib build (integration tests call it, the binary doesn't).
    #[cfg(any(test, feature = "test-support"))]
    #[allow(dead_code)]
    pub fn disabled_for_tests(config: &Config) -> Self {
        Self {
            namespace: config.k8s_namespace.clone(),
            llm_gateway_url: config.llm_gateway_url.clone(),
            cache: Cache::builder().max_capacity(8).build(),
            backend: ResolverBackend::Disabled,
        }
    }

    /// Route / integration tests that need a VK but not a live K8s API.
    ///
    /// Gated behind `cfg(test)` / the `test-support` feature so this
    /// K8s-bypassing constructor is never part of the production public API.
    #[cfg(any(test, feature = "test-support"))]
    #[allow(dead_code)]
    pub fn with_fixed_auth_for_tests(config: &Config, virtual_key_token: &str) -> Self {
        Self {
            namespace: config.k8s_namespace.clone(),
            llm_gateway_url: config.llm_gateway_url.clone(),
            cache: Cache::builder().max_capacity(8).build(),
            backend: ResolverBackend::Fixed(virtual_key_token.to_string()),
        }
    }

    pub async fn from_config(config: &Config) -> Self {
        let backend = match kube::Client::try_default().await {
            Ok(client) => {
                tracing::info!(
                    namespace = %config.k8s_namespace,
                    llm_gateway_url = %config.llm_gateway_url,
                    "Project gateway resolver initialized (K8s Secret as-proj-{{projectId}}-vk)"
                );
                ResolverBackend::K8s(Api::namespaced(client, &config.k8s_namespace))
            }
            Err(e) => {
                warn!(
                    "Kubernetes API unavailable ({}); per-project Bifrost keys disabled",
                    e
                );
                ResolverBackend::Disabled
            }
        };

        Self {
            namespace: config.k8s_namespace.clone(),
            llm_gateway_url: config.llm_gateway_url.clone(),
            cache: Cache::builder()
                .max_capacity(512)
                .time_to_live(Duration::from_secs(config.project_gateway_cache_ttl_secs))
                .build(),
            backend,
        }
    }

    /// Load the project's virtual key when present. Returns `None` if the Secret
    /// is missing or K8s is unavailable (search still works with local ONNX today).
    ///
    /// Prefer [`resolve`] when callers need to distinguish "secret not found"
    /// from "RBAC denied" / "secret exists but token empty" — those failure
    /// modes all collapse to `None` here. Kept on the API surface for the
    /// metadata route's tolerant if-let path (where any lookup failure is
    /// best handled as "VK not available, render basic metadata only").
    pub async fn resolve_optional(&self, project_id: &str) -> Option<Arc<ProjectGatewayAuth>> {
        match self.resolve(project_id).await {
            GatewayLookup::Ready(auth) => Some(auth),
            _ => None,
        }
    }

    /// Like [`resolve_optional`] but surfaces *why* the lookup failed so the
    /// caller can craft a precise user-facing error. Critical for the search
    /// route, where the previous "Secret missing? Just return None" path
    /// turned every failure mode — including missing RBAC on the
    /// kb-retrieval-service ServiceAccount — into the misleading
    /// "Project has no Bifrost virtual key configured" UI message.
    /// Verified on sks6316: SA lacked `get` on secrets in agentstudio-services,
    /// the 403 was logged at `warn` level but invisible to the UI, and the
    /// operator went hunting for a non-existent gateway-setup workflow bug.
    /// Each variant maps to a different remediation hint at the call site.
    pub async fn resolve(&self, project_id: &str) -> GatewayLookup {
        if validate_project_id(project_id).is_err() {
            warn!("Invalid project id for gateway lookup");
            return GatewayLookup::InvalidProjectId;
        }

        if let Some(hit) = self.cache.get(project_id).await {
            return GatewayLookup::Ready(hit);
        }

        let auth = match &self.backend {
            ResolverBackend::Disabled => return GatewayLookup::Disabled,
            ResolverBackend::Fixed(token) => ProjectGatewayAuth {
                project_id: project_id.to_string(),
                llm_gateway_url: self.llm_gateway_url.clone(),
                virtual_key_token: token.clone(),
            },
            ResolverBackend::K8s(secrets) => match self.fetch_from_k8s(secrets, project_id).await {
                FetchOutcome::Ready(auth) => auth,
                other => return other.into_lookup(&self.namespace, project_id),
            },
        };

        let arc = Arc::new(auth);
        self.cache.insert(project_id.to_string(), arc.clone()).await;
        debug!(
            project_id = %project_id,
            namespace = %self.namespace,
            "Loaded Bifrost project virtual key"
        );
        GatewayLookup::Ready(arc)
    }

    /// Same as [`resolve_optional`] but surfaces a clear error when the key is required.
    #[allow(dead_code)]
    pub async fn resolve_required(&self, project_id: &str) -> Result<Arc<ProjectGatewayAuth>> {
        self.resolve_optional(project_id).await.ok_or_else(|| {
            anyhow::anyhow!(
                "Bifrost virtual key not available for project '{}'. \
                 Ensure ProjectInitWorkflow created Secret as-proj-{}-vk in namespace '{}'.",
                project_id,
                project_id,
                self.namespace
            )
        })
    }

    async fn fetch_from_k8s(&self, secrets: &Api<Secret>, project_id: &str) -> FetchOutcome {
        let name = project_virtual_key_secret_name(project_id);
        let secret = match secrets.get(&name).await {
            Ok(s) => s,
            Err(kube::Error::Api(err)) if err.code == 404 => {
                return FetchOutcome::NotFound;
            }
            // 403 / 401 mean the kb-retrieval-service ServiceAccount lacks
            // the Role/RoleBinding that grants `get` on secrets — NOT that
            // the project gateway is unconfigured. Surface it distinctly
            // so the route handler emits an actionable error instead of
            // the misleading "VK not configured" message. Verified on
            // sks6316: kubectl auth can-i get secrets returned `no` while
            // the secret was clearly present.
            Err(kube::Error::Api(err)) if err.code == 403 || err.code == 401 => {
                return FetchOutcome::Forbidden(err.message.clone());
            }
            Err(e) => return FetchOutcome::Error(format!("get namespaced Secret: {e}")),
        };

        let data = secret.data.unwrap_or_default();
        let Some(token) = data.get(VK_TOKEN_SECRET_KEY) else {
            return FetchOutcome::MissingKey;
        };
        let token = match String::from_utf8(token.0.clone()) {
            Ok(t) => t,
            Err(_) => {
                return FetchOutcome::Error("virtual_key_token is not valid UTF-8".to_string());
            }
        };
        if token.is_empty() {
            return FetchOutcome::EmptyToken;
        }

        FetchOutcome::Ready(ProjectGatewayAuth {
            project_id: project_id.to_string(),
            llm_gateway_url: self.llm_gateway_url.clone(),
            virtual_key_token: token,
        })
    }
}

/// Internal outcome from a single K8s `get Secret` round-trip. Kept module-
/// private; public consumers see [`GatewayLookup`] which also covers cache
/// hits + disabled-backend.
enum FetchOutcome {
    /// Got the token, ready to use.
    Ready(ProjectGatewayAuth),
    /// Secret doesn't exist — gateway-setup hasn't run for this project.
    NotFound,
    /// K8s API denied the request (403/401) — RBAC misconfigured for the
    /// kb-retrieval-service ServiceAccount. Carries the API message verbatim.
    Forbidden(String),
    /// Secret exists but doesn't carry the expected `virtual_key_token` key.
    /// Indicates a config-service writer bug or manual tampering, not a
    /// missing-VK situation.
    MissingKey,
    /// Secret exists, key present, but the value is empty — same diagnosis
    /// as MissingKey but a different writer bug.
    EmptyToken,
    /// Anything else: network, kube-rs decode, etc.
    Error(String),
}

impl FetchOutcome {
    /// Promote a fetch outcome to the public [`GatewayLookup`], logging the
    /// underlying cause at an appropriate level. Centralised so every failure
    /// path leaves the same breadcrumb in the service logs even when the
    /// route handler maps it to a user-facing string.
    fn into_lookup(self, namespace: &str, project_id: &str) -> GatewayLookup {
        match self {
            FetchOutcome::Ready(_) => {
                unreachable!("resolve() should handle Ready before reaching into_lookup")
            }
            FetchOutcome::NotFound => {
                debug!(
                    project_id = %project_id,
                    namespace = %namespace,
                    "Project VK secret not found"
                );
                GatewayLookup::NotConfigured
            }
            FetchOutcome::Forbidden(msg) => {
                warn!(
                    project_id = %project_id,
                    namespace = %namespace,
                    "K8s API denied get-secret for project VK (RBAC): {}",
                    msg
                );
                GatewayLookup::Forbidden(msg)
            }
            FetchOutcome::MissingKey => {
                warn!(
                    project_id = %project_id,
                    namespace = %namespace,
                    "Project VK secret exists but virtual_key_token key is missing"
                );
                GatewayLookup::MalformedSecret(
                    "the as-proj-*-vk Secret exists but the `virtual_key_token` data key is missing"
                        .to_string(),
                )
            }
            FetchOutcome::EmptyToken => {
                warn!(
                    project_id = %project_id,
                    namespace = %namespace,
                    "Project VK secret token is empty"
                );
                GatewayLookup::MalformedSecret(
                    "the as-proj-*-vk Secret's `virtual_key_token` data is present but empty"
                        .to_string(),
                )
            }
            FetchOutcome::Error(msg) => {
                warn!(
                    project_id = %project_id,
                    namespace = %namespace,
                    "Project VK lookup failed: {}",
                    msg
                );
                GatewayLookup::LookupError(msg)
            }
        }
    }
}

/// Public outcome of [`ProjectGatewayResolver::resolve`]. Every variant maps
/// to a distinct user-facing message; the [`Self::diagnostic`] helper
/// produces the canonical phrasing used by the search / metadata routes so
/// the wording stays consistent.
#[derive(Clone, Debug)]
pub enum GatewayLookup {
    /// Token found (either fresh or from the cache).
    Ready(Arc<ProjectGatewayAuth>),
    /// `as-proj-*-vk` Secret doesn't exist for this project — typically
    /// means the gateway-setup workflow hasn't completed yet (or the
    /// project itself isn't bootstrapped).
    NotConfigured,
    /// K8s API denied the get-secret call. Almost always RBAC — the
    /// kb-retrieval-service ServiceAccount needs a Role granting
    /// `get` on secrets in its namespace. Wraps the API message for
    /// surfacing in the response body.
    Forbidden(String),
    /// Secret exists but its contents don't match the expected shape.
    /// Wraps a human-readable description.
    MalformedSecret(String),
    /// Resolver backend was constructed with the Disabled variant
    /// (no in-cluster K8s client). Searches that need a VK can't
    /// proceed at all.
    Disabled,
    /// Project id failed the validate_project_id check.
    InvalidProjectId,
    /// Anything else — network, kube-rs internal error, etc.
    LookupError(String),
}

impl GatewayLookup {
    /// Single source of truth for the human-readable diagnostic. Both the
    /// search and metadata routes call this so the user sees consistent
    /// language and an actionable remediation hint per failure mode.
    pub fn diagnostic(&self, project_id: &str) -> String {
        match self {
            GatewayLookup::Ready(_) => {
                format!("Bifrost virtual key is ready for project {project_id}")
            }
            GatewayLookup::NotConfigured => format!(
                "No Bifrost virtual-key Secret (`as-proj-{project_id}-vk`) found for project {project_id}. \
                 The project's gateway-setup step hasn't completed — check the ProjectInitWorkflow for this project."
            ),
            GatewayLookup::Forbidden(msg) => format!(
                "kb-retrieval-service is not authorised to read the Bifrost virtual-key Secret \
                 for project {project_id}. This is an RBAC misconfiguration on the kb-retrieval-service \
                 ServiceAccount, not a project-setup problem. Add a Role granting `get` on `secrets` \
                 in the kb-retrieval-service namespace (the chart's templates/rbac.yaml provides this; \
                 it may have been removed or the chart upgrade hasn't applied yet). \
                 K8s API said: {msg}"
            ),
            GatewayLookup::MalformedSecret(detail) => format!(
                "Bifrost virtual-key Secret for project {project_id} is malformed: {detail}. \
                 Re-run gateway-setup or recreate the Secret via the config-service admin path."
            ),
            GatewayLookup::Disabled =>
                "kb-retrieval-service is running without a K8s gateway resolver — project VK lookups are disabled. \
                 Check K8S_NAMESPACE configuration and the in-cluster ServiceAccount.".to_string(),
            GatewayLookup::InvalidProjectId => format!(
                "Project id {project_id:?} failed validation — must be 1-128 alphanumeric chars (+ dash/underscore)."
            ),
            GatewayLookup::LookupError(msg) => format!(
                "Bifrost virtual-key lookup for project {project_id} failed with an unexpected error: {msg}"
            ),
        }
    }
}

/// Secret name written by config-service `writeProjectVirtualKeyTokenSecret`.
pub fn project_virtual_key_secret_name(project_id: &str) -> String {
    format!("as-proj-{project_id}-vk")
}

/// Construct auth for unit tests in other modules (fields are private).
#[cfg(test)]
pub(crate) fn test_project_gateway_auth(project_id: &str, token: &str) -> Arc<ProjectGatewayAuth> {
    Arc::new(ProjectGatewayAuth {
        project_id: project_id.to_string(),
        llm_gateway_url: "http://bifrost:8080".to_string(),
        virtual_key_token: token.to_string(),
    })
}

pub fn validate_project_id(project_id: &str) -> Result<()> {
    if project_id.is_empty() || project_id.len() > 128 {
        bail!("project id must be 1-128 characters");
    }
    if !project_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        bail!("project id contains invalid characters");
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_gateway_tests.rs"]
mod tests;
