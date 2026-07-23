.PHONY: help build docker-build docker-build-service docker-push docker-push-service docker-build-push \
	deploy-foundation deploy-identity deploy-observability undeploy-local \
	deploy deploy-gke gke-ensure-storage-ready infra storage \
	deploy-eks eks-bootstrap-fresh eks-test-deploy \
	deploy-cloud-auto deploy-gke-auto gke-preflight gke-storage gke-dns gke-verify \
	help-aks help-gke help-eks help-local \
	helm-ss-csi-driver-upgrade aks-ss-csi-driver-upgrade \
	helm-wait-keycloak helm-worker-hpa-preflight \
	helm-identity-install-local helm-identity-upgrade-local helm-identity-install-aks helm-identity-upgrade-aks \
	helm-identity-install-eks helm-identity-upgrade-eks helm-identity-template-eks \
	helm-identity-template-local helm-identity-template-aks helm-identity-lint \
	helm-identity-uninstall helm-identity-status helm-identity-logs helm-identity-bootstrap-logs helm-identity-port-forward \
	helm-identity-install-gke helm-identity-upgrade-gke helm-identity-template-gke \
	keycloak-db-secret-sync keycloak-admin-secret \
	aks-keycloak-entra-register \
	aks-keycloak-mirror-bootstrap-admin \
	helm-database-install helm-database-uninstall helm-database-upgrade helm-database-upgrade-force helm-database-status \
	helm-observability-upgrade helm-observability-upgrade-aks helm-observability-upgrade-gke helm-observability-upgrade-eks helm-observability-uninstall helm-observability-status \
	install-gateway-api helm-istio-install verify-istio-gateway \
	optimize-gateway-nginx configure-ontap-storage \
	helm-wait-database ensure-shared-postgresql-secret deploy-local-bootstrap-fresh \
	images-build images-push images-build-push image-build image-push \
	bifrost-build-push bifrost-mirror-push \
	helm-tei-prepull \
	verify-env-propagation local-force-pull-rollout local-preflight \
	workers-build workers-push workers-build-push \
	operator-build operator-push operator-build-push operator-deploy operator-undeploy operator-status operator-logs \
	print-nemo-services print-worker-images print-all-images \
	lint-makefile lint-no-port-leak \
	helm-install-istio-mesh-policies helm-install-istio \
	istio-label-namespaces istio-inject-existing istio-promote-strict istio-enable-default-deny istio-verify \
	clean clean-helm clean-all \
	helm-validate helm-validate-local helm-validate-aks helm-validate-gke helm-validate-eks \
	lint-values lint-values-tier

# ============================================================================
# AgentStudio root Makefile
#
# Thin loader: pulls in shared variables, generic recipes, build targets,
# the identity tier, the canned tier-helm macro + cross-tier infra, and
# every per-cloud dialect under mk/cloud/. Adding a new cloud means
# dropping mk/cloud/<cloud>.mk in place — no edits here.
#
# Layered include order (matters because later files reference earlier ones):
#   1. mk/common.mk     — vars + exports + generic helm-* macros
#   2. mk/build.mk      — build / docker / images / workers / operator
#   3. mk/identity.mk   — Keycloak install/upgrade per cloud
#   4. mk/tier-helm.mk  — helm_upgrade_tier macro + database/observability/foundation
#   5. mk/cloud/*.mk    — per-cloud tier wrappers + orchestrators
#   6. mk/dispatch.mk   — `make deploy CLOUD=<cloud>` facade + help-<cloud>
#   7. mk/validate.mk   — offline values parity + helm-validate gate
# ============================================================================

# Suppress `make[N]: Entering directory '...'` and the matching `Leaving`
# lines that GNU make emits on every sub-`$(MAKE)` recursion. The deploy
# targets call `$(MAKE) helm-foo-upgrade-local` many times per run; without
# this the user sees five copies of that noise wrapping each phase, which
# drowns the colored Phase banners. Equivalent to passing
# `--no-print-directory` on every make invocation. Standard pattern.
MAKEFLAGS += --no-print-directory

# `make` with no target prints help. Pin .DEFAULT_GOAL before any include
# pulls in a target; otherwise the first target seen (currently `build`
# from mk/build.mk) becomes the default and a bare `make` accidentally
# kicks off a full multi-service build.
.DEFAULT_GOAL := help

include mk/common.mk
include mk/build.mk
include mk/identity.mk
include mk/tier-helm.mk

# Per-cloud dialects. Glob-loaded so a future mk/cloud/<newcloud>.mk
# drops in without an edit here.
include $(wildcard mk/cloud/*.mk)

# Cloud dispatch facade: `make deploy CLOUD={local,aks,gke,eks}` plus
# help-<cloud>. Loaded last so it can reference any
# deploy-all-tiers-<cloud> target defined above.
include mk/dispatch.mk

# Offline values validation gate: lint-values (parity linter) +
# helm-validate (helm template ×4 clouds). No cluster contact.
# Wire CI: `- run: make helm-validate`.
include mk/validate.mk

# ============================================================================
# Help
# ============================================================================

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Quick start:'
	@echo '  make deploy CLOUD=local            # Full local stack (KIND / Docker Desktop / k3d / minikube)'
	@echo '  make deploy CLOUD=aks              # Full AKS stack'
	@echo '  make deploy CLOUD=gke              # Full GKE stack (auto-derives KEYCLOAK_HOSTNAME from ENDPOINT)'
	@echo '  make deploy CLOUD=eks              # Full EKS stack (FSx Trident + NLB)'
	@echo '  make help-local | help-aks | help-gke | help-eks   # Cloud-scoped target list'
	@echo ''
	@echo 'All targets (cloud-agnostic + every cloud):'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-40s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ''
	@echo 'Common variables:'
	@echo '  VERSION          Image version tag (default: from git or "dev")'
	@echo '  CONTAINER        Container runtime (default: docker, can use podman)'
	@echo '  CONTAINER_IMAGE_REPO  Container registry repository'
	@echo '  USER_ID          User ID for default registry path'
	@echo '  GHCR_PAT         GitHub Personal Access Token (required when CONTAINER_IMAGE_REPO uses ghcr.io)'
	@echo '  ENDPOINT          Domain for all services (default: agentstudio.local, used for TLS certs and subdomains: auth, s3, catalog, workflows, ws)'
	@echo '  IMAGE_TAG        Image tag override for project-built images'
	@echo '  FORCE_PULL       Set to 1 to force imagePullPolicy=Always on platform/workers/services/console/llm-gateway tier upgrades (not identity)'
	@echo '  HELM_EXTRA_ARGS  Extra args passed to helm'
	@echo '  OBSERVABILITY    Set to 1 to deploy Phase 0 (Prometheus + Grafana) before the main tiers'
	@echo '  CERT_MANAGER_GATEWAY_TLS  Set to 1 when cert-manager is installed; creates TLS secret via ClusterIssuer+Certificate (SANs from ENDPOINT)'
	@echo '  CERT_MANAGER_ISSUER_NAME  ClusterIssuer name when CERT_MANAGER_GATEWAY_TLS=1 (default: nemo-gateway-selfsigned)'
	@echo '  GATEWAY_LB_IP    Optional LoadBalancer/MetalLB VIP for TLS cert IP SAN (browser https://<VIP>:8443)'
	@echo '  GATEWAY_MATCH_ALL_HOSTS   Set to 1 so HTTPRoute accepts any Host header (e.g. access by IP without /etc/hosts)'
	@echo '  SERVICE          Service name for single-service operations'
	@echo '  SKIP_SERVICES    Comma-separated services to skip for build/push (e.g. SKIP_SERVICES=kb-retrieval-service,analytics-engine for multi-arch from Mac)'
	@echo '  DOCKER_PLATFORMS Comma-separated platforms for multi-arch (e.g. linux/amd64,linux/arm64). All builds are native-only; see docs/docker/docker-multiarch-builds.md.'
	@echo '  DOCKER_BUILDX_BUILDER  Buildx builder name to offload builds (e.g. kube for Kubernetes). See docs/docker/docker-multiarch-builds.md.'
	@echo '  DOCKER_BUILDX_CACHE    Modifier (needs DOCKER_BUILDX_BUILDER or DOCKER_PLATFORMS active): import/export buildx registry cache as <image>:buildcache in CONTAINER_IMAGE_REPO (mode=max). CONTAINER=docker only.'
	@echo '  DOCKER_BUILDX_PUSH     Modifier (needs DOCKER_BUILDX_BUILDER or DOCKER_PLATFORMS active): fold the registry push into buildx (--push). Skips the chained docker-push / images-push / workers-push targets.'
	@echo '  CONFIG_FILE      Path to Trident backends YAML (optional). If unset, single-backend mode uses BACKEND_TYPE, ONTAP_*, FSX_* env vars. See deployments/storage/README.md.'
	@echo '  BACKEND_TYPE     ontap or fsxn (single-backend mode). TRIDENT_INSTALL=0 to skip Trident install.'
	@echo '  CLOUD            Cloud cluster type (local|aks|gke|eks). Used by `make deploy CLOUD=...`.'
	@echo '  CLOUD_PROVIDER   (legacy) Cloud selector for deploy-cloud-auto facade (gcp/aws/azure; default gcp)'
	@echo '  SERVICES_NAMESPACE Namespace for AgentStudio services (default: agentstudio-services).'
	@echo '  KEYCLOAK_NAMESPACE Namespace for the Keycloak Helm release (default: agentstudio-identity). Federated to the AKS Workload Identity UAMI via system:serviceaccount:$$KEYCLOAK_NAMESPACE:keycloak.'
	@echo '  HELM_UPGRADE_TIMEOUT  Max time for helm upgrade --install to wait for hooks/Jobs (default: 30m)'
	@echo '  DATABASE_NAMESPACE Namespace for database chart (default: database)'
	@echo '  AUTO_CREATE_CLUSTER Auto-create GKE cluster if missing (default: 1)'
	@echo '  AUTO_CREATE_NODE_POOL Auto-create node pool if missing (default: 1)'
	@echo '  NODE_ARCHITECTURE Desired node architecture: amd64|arm64 (default: amd64)'
	@echo '  GKE_MACHINE_TYPE Node machine type (auto: e2-standard-4 for amd64, t2a-standard-4 for arm64)'
	@echo '  GKE_NODEPOOL_NAME Node pool name (default: <arch>-pool)'
	@echo '  GKE_NODEPOOL_NUM_NODES Nodes in created node pool (default: 3)'
	@echo '  GKE_SUBNETWORK Optional subnetwork for cluster create'
	@echo '  GKE_NODE_LOCATIONS Optional zones for node pool (comma-separated)'
	@echo '  GKE_NODE_TAINTS Optional taints for node pool (k=v:NoSchedule,...)'
	@echo '  ARCH_PIN_WORKLOADS Set to 1 to inject architecture nodeSelector overlays'
	@echo '  ARCH_NODE_SELECTOR_KEY Node selector key for architecture pin (default: kubernetes.io/arch)'
	@echo ''
	@echo 'Istio service mesh:'
	@echo '  make deploy-local-bootstrap-fresh     # Istio installed automatically (local default = istio)'
	@echo '  make deploy-all-tiers-aks             # Istio always installed first on AKS'
	@echo '  make helm-install-istio               # Install istiod control plane + mesh-policies'
	@echo '  make helm-mesh-policies-install       # Install/upgrade only mesh-policies (PeerAuth, AuthzPolicy)'
	@echo '  make istio-label-namespaces           # Label mesh-target namespaces with istio-injection=enabled'
	@echo '  make istio-inject-existing            # Convergence: restart unmeshed Deployments + StatefulSets'
	@echo '  make istio-verify                     # Check istiod health + policy status per namespace'
	@echo '  make istio-promote-strict             # After validating PERMISSIVE traffic: switch to STRICT mTLS'
	@echo '  make istio-enable-default-deny        # After validating allow-list: enable default-deny'
	@echo ''
	@echo 'Deployment (all phases are idempotent, safe to re-run):'
	@echo '  make deploy CLOUD=aks                       # Full AKS stack (database -> identity -> tiers)'
	@echo '  make deploy CLOUD=aks OBSERVABILITY=1                            # With monitoring (Phase 0)'
	@echo '  make deploy CLOUD=aks CERT_MANAGER_GATEWAY_TLS=1 ENDPOINT=studio.example.com  # With cert-manager TLS'
	@echo '  make deploy CLOUD=eks ENDPOINT=<dns>                             # Full stack on AWS EKS (FSx Trident + NLB)'
	@echo '  make deploy CLOUD=local                     # Full local stack (KIND / Docker Desktop / k3d / minikube)'
	@echo '  make deploy CLOUD=local OBSERVABILITY=1                          # Local + monitoring'
	@echo '  make deploy CLOUD=local CERT_MANAGER_GATEWAY_TLS=1 ENDPOINT=studio.local      # Local + cert-manager TLS'
	@echo ''
	@echo '  Individual phases:'
	@echo '  make deploy-observability              # Prometheus + Grafana (optional, Phase 0)'
	@echo '  make deploy-foundation                 # Gateway API + PostgreSQL'
	@echo '  make deploy-identity                   # Keycloak'
	@echo '  make helm-platform-upgrade CLOUD=aks    # Platform tier (Temporal, Lakekeeper, S3Gateway, Redis)'
	@echo '  make helm-services-upgrade CLOUD=aks    # Application services tier'
	@echo '  make helm-workers-upgrade CLOUD=aks     # Workers tier'
	@echo '  make helm-console-upgrade CLOUD=aks     # Console tier (GUI)'
	@echo '  make helm-llm-gateway-upgrade CLOUD=aks # LLM Gateway tier (Bifrost)'
	@echo ''
	@echo 'Standalone images (jobs, workspaces, MCP servers — all in src/images/):'
	@echo '  make images-build                    # Build all images in src/images/'
	@echo '  make images-push                     # Push all images to registry'
	@echo '  make images-build-push               # Build and push all images'
	@echo '  make image-build IMAGE=<name>        # Build a single image (e.g. IMAGE=mcp-server-kubernetes)'
	@echo '  make image-push  IMAGE=<name>        # Push a single image'

# ============================================================================
# Istio Service Mesh (convenience aliases + operational targets)
# ============================================================================
# Control plane installed by:   make helm-istio-install     (mk/tier-helm.mk)
# Mesh policies installed by:   make helm-mesh-policies-install (mk/tier-helm.mk)
# Both called automatically by: make deploy-local-bootstrap-fresh (mk/cloud/local.mk)
# ─────────────────────────────────────────────────────────────────────────────

helm-install-istio-mesh-policies: ## Install/upgrade mesh policies. Alias for helm-mesh-policies-install.
	$(MAKE) helm-mesh-policies-install

helm-install-istio: ## Install Istio control plane + mesh policies.
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — control plane + mesh policies\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	$(MAKE) helm-istio-install
	$(MAKE) helm-mesh-policies-install
	@printf "\n$(COLOR_GREEN)$(SEPARATOR)\n  Istio install complete — istiod healthy, mesh policies applied\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@istioctl verify-install 2>/dev/null || echo "  (istioctl not in PATH — run istioctl verify-install manually)"

istio-inject-existing: ## Convergence: restart only unmeshed Deployments and StatefulSets to inject Istio sidecars. Skips workloads whose running pods already have an istio-proxy (regular container or Istio 1.30 native-sidecar initContainer). Idempotent.
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — sidecar convergence (unmeshed workloads only)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@# Pod-based detection (the sidecar is injected at pod-admission time and
	@# never lands in the workload .spec.template). One `get pods` per
	@# namespace; awk maps each pod to its owning workload (ReplicaSet ->
	@# Deployment by stripping the pod-template-hash; StatefulSet directly)
	@# and emits only workloads with no meshed pod.
	@for ns in $(ISTIO_APP_NAMESPACES); do \
	  for wl in $$(kubectl get pods -n $$ns -o jsonpath='{range .items[*]}{.metadata.ownerReferences[0].kind}|{.metadata.ownerReferences[0].name}|{range .spec.initContainers[*]}{.name},{end}{range .spec.containers[*]}{.name},{end}{"\n"}{end}' 2>/dev/null \
	    | awk -F'|' '{ k=$$1; n=$$2; \
	        if (k=="ReplicaSet") { sub(/-[^-]+$$/,"",n); w="deployment/"n } \
	        else if (k=="StatefulSet") { w="statefulset/"n } else next; \
	        seen[w]=1; if ($$3 ~ /(^|,)istio-proxy,/) meshed[w]=1 } \
	      END { for (w in seen) if (!(w in meshed)) print w }'); do \
	    echo "  rolling $$wl in $$ns (no sidecar yet)"; \
	    kubectl rollout restart $$wl -n $$ns 2>/dev/null || true; \
	    kubectl rollout status $$wl -n $$ns --timeout=5m 2>/dev/null || true; \
	  done; \
	done
	@printf "\n$(COLOR_GREEN)  Done. Verify sidecars:\n    kubectl get pods -n <ns> -o jsonpath='{range .items[*]}{.metadata.name}{\"\\t\"}{range .spec.containers[*]}{.name}{\" \"}{end}{\"\\n\"}{end}'\n$(COLOR_RESET)\n\n"

istio-promote-strict: ## Promote mTLS from PERMISSIVE → STRICT across all app namespaces.
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — promoting to STRICT mTLS\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	helm upgrade $(HELM_RELEASE_ISTIO_POLICIES) $(MESH_POLICIES_CHART_DIR) \
	  --namespace $(HELM_NS_ISTIO) \
	  --reuse-values \
	  --set mtls.mode=STRICT \
	  $(HELM_EXTRA_ARGS)

istio-enable-default-deny: ## Enable default-deny AuthorizationPolicy (run after allow-list is validated in STRICT mode).
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — enabling default-deny AuthorizationPolicy\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	helm upgrade $(HELM_RELEASE_ISTIO_POLICIES) $(MESH_POLICIES_CHART_DIR) \
	  --namespace $(HELM_NS_ISTIO) \
	  --reuse-values \
	  --set authorizationPolicies.defaultDeny.enabled=true \
	  $(HELM_EXTRA_ARGS)

istio-verify: ## Verify Istio control plane and mesh policy status.
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — verification\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@istioctl verify-install 2>/dev/null || echo "  WARNING: istioctl not in PATH"
	@kubectl -n $(HELM_NS_ISTIO) get pods
	@echo ""
	@for ns in $(ISTIO_APP_NAMESPACES); do \
	  echo "  === $$ns ==="; \
	  kubectl -n $$ns get peerauthentication,authorizationpolicy 2>/dev/null || true; \
	done
	@echo ""
	@istioctl analyze -n $(HELM_NS_SERVICES) 2>/dev/null || echo "  (istioctl not in PATH — skipping analyze)"

