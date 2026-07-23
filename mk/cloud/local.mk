# mk/cloud/local.mk -- per-tier wrappers + orchestrator + cloud-side
# helpers for local Kubernetes clusters (KIND, Docker Desktop, k3d, minikube).
#
# Collects everything that only runs against a laptop-class cluster.
# Tier wrappers each delegate to helm_upgrade_tier (mk/tier-helm.mk);
# orchestrator + bootstrap helpers stay here because they hard-code
# local cluster assumptions (hostPath StorageClass, KIND inotify
# tuning, image-load mechanism, etc.).

# Local KIND uses 8443 (can't bind <1024 without root on rootless Docker).
# Only apply this override for local deployments; mk/cloud/*.mk files are
# all included by the root Makefile, so we must detect local-targeting
# without polluting cloud invocations.
#
# Trigger conditions (any one fires):
#   1. `CLOUD=local` set on the command line / env — the explicit signal.
#   2. The make goals include a `-local` target (e.g. `make deploy-local`,
#      `make helm-services-upgrade-local`) — what the user actually runs
#      day-to-day. Without this branch, GATEWAY_HTTPS_PORT stayed at the
#      mk/common.mk default of 443, the chart got
#      `--set-string global.gatewayHttpsPort=443`, and all emitted issuer
#      URLs lost their `:8443` suffix — Istio + workflow-engine + others
#      then rejected real Keycloak tokens (whose iss carries `:8443`) with
#      `Token validation failed: invalid issuer` 401. Verified on sks6316.
_LOCAL_TARGETS := $(filter %-local deploy-local,$(MAKECMDGOALS))
ifneq ($(or $(filter local,$(CLOUD)),$(_LOCAL_TARGETS)),)
override GATEWAY_HTTPS_PORT := 8443
export GATEWAY_HTTPS_PORT
endif

# ─── Per-tier install / upgrade targets ───────────────────────────────────────

# The former helm-<tier>-upgrade-local wrappers are now the generic
# helm-<tier>-upgrade targets (mk/cloud/deploy-orchestrator.mk), invoked with
# CLOUD=local. deploy-local below calls them that way.

# Smoke-test all local tier charts without touching the cluster.
helm-tier-template-local: ## Smoke-test all local tier charts via helm template (no cluster contact)
	@echo "Smoke-testing tier charts (local overlay)..."
	$(call helm_template_all_tiers,local,$(LOCAL_TIER_SET))
	@echo "All local tier charts rendered successfully."

# ─── Local-only cluster helpers ──────────────────────────────────────────────

# Path to the shared-hostPath storage manifest used by local deployments.
LOCAL_SHARED_STORAGE_MANIFEST ?= $(shell pwd)/deployments/storage/local-shared-default-bucket.yaml

ensure-local-shared-default-bucket: ## Create shared hostPath StorageClass + PVs for local default-bucket (idempotent)
	@echo "Applying shared hostPath storage for local default-bucket (platform/workers/services)..."
	@kubectl apply -f $(LOCAL_SHARED_STORAGE_MANIFEST)
	@# Clear stale claimRefs on Released PVs so they become Available for rebinding.
	@# reclaimPolicy: Retain keeps the hostPath data safe across helm uninstall, but
	@# leaves the PV in Released state — blocking the next PVC bind until patched.
	@for pv in nemo-default-bucket-workers nemo-default-bucket-services nemo-default-bucket-platform; do \
	  state=$$(kubectl get pv $$pv -o jsonpath='{.status.phase}' 2>/dev/null || true); \
	  if [ "$$state" = "Released" ]; then \
	    echo "  Clearing stale claimRef on $$pv (Released → Available)"; \
	    kubectl patch pv $$pv -p '{"spec":{"claimRef":null}}' >/dev/null; \
	  fi; \
	done

purge-local-shared-default-bucket: ## Delete shared hostPath PVCs, PVs and StorageClass (used by undeploy-local)
	@echo "Removing shared hostPath PVCs..."
	-kubectl delete pvc s3gateway-default-bucket -n $(HELM_NS_PLATFORM)  --ignore-not-found
	-kubectl delete pvc s3gateway-default-bucket -n $(HELM_NS_WORKERS)   --ignore-not-found
	-kubectl delete pvc s3gateway-default-bucket -n $(HELM_NS_SERVICES)  --ignore-not-found
	@echo "Removing shared hostPath PVs..."
	-kubectl delete pv nemo-default-bucket-platform nemo-default-bucket-workers nemo-default-bucket-services --ignore-not-found
	@echo "Removing StorageClass..."
	-kubectl delete storageclass nemo-local-shared --ignore-not-found

undeploy-local: ## Tear down all local tier Helm releases in reverse order (preserves PVCs). Pass OBSERVABILITY=1 to also remove observability stack; PURGE_LOCAL_PVCS=1 to delete shared hostPath PVCs/PVs; DELETE_NAMESPACES=1 to delete tier namespaces; REMOVE_ISTIO=1 to also uninstall Istio control plane.
	@echo "=== Undeploying local tiers (reverse order) ==="
	-helm uninstall $(HELM_RELEASE_EDGE)        --namespace $(HELM_NS_EDGE)         2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_CONSOLE)     --namespace $(HELM_NS_CONSOLE)      2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_SERVICES)    --namespace $(HELM_NS_SERVICES)     2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_LLM_GATEWAY) --namespace $(HELM_NS_LLM_GATEWAY)  2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_PLATFORM)    --namespace $(HELM_NS_PLATFORM)     2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_WORKERS)     --namespace $(HELM_NS_WORKERS)      2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_IDENTITY)    --namespace $(HELM_NS_IDENTITY)     2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_DATABASE)    --namespace $(HELM_NS_DATABASE)     2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_CSI_PROVIDER) --namespace $(HELM_NS_CSI)         2>/dev/null || true
	-helm uninstall $(HELM_RELEASE_CSI_DRIVER)  --namespace $(HELM_NS_CSI)          2>/dev/null || true
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "OBSERVABILITY=1: removing observability stack..."; \
	  $(MAKE) helm-observability-uninstall; \
	fi
	@if [ "$(REMOVE_ISTIO)" = "1" ]; then \
	  echo "REMOVE_ISTIO=1: removing Istio control plane..."; \
	  helm delete istio-mesh-policies -n istio-system 2>/dev/null || true; \
	  helm delete istiod -n istio-system 2>/dev/null || true; \
	  helm delete istio-base -n istio-system 2>/dev/null || true; \
	  kubectl delete namespace istio-system --ignore-not-found 2>/dev/null || true; \
	fi
	@if [ "$(PURGE_LOCAL_PVCS)" = "1" ]; then \
	  echo "PURGE_LOCAL_PVCS=1: purging shared hostPath PVCs/PVs/StorageClass..."; \
	  $(MAKE) purge-local-shared-default-bucket; \
	fi
	@if [ "$(DELETE_NAMESPACES)" = "1" ]; then \
	  echo "Deleting tier namespaces..."; \
	  for ns in $(HELM_NS_EDGE) $(HELM_NS_CONSOLE) $(HELM_NS_SERVICES) $(HELM_NS_LLM_GATEWAY) $(HELM_NS_PLATFORM) $(HELM_NS_WORKERS) $(HELM_NS_IDENTITY) $(HELM_NS_DATABASE); do \
	    kubectl delete namespace $$ns --ignore-not-found; \
	  done; \
	fi
	@echo "=== Local teardown complete. PVCs preserved (use PURGE_LOCAL_PVCS=1 to delete shared hostPath PVCs; DELETE_NAMESPACES=1 to remove namespaces; REMOVE_ISTIO=1 to remove Istio control plane; OBSERVABILITY=1 to remove observability stack). ==="

deploy-local-bootstrap-fresh: ## Fresh-cluster bootstrap for local deployments (gateway API/TLS, DB readiness, shared secrets, identity)
	@# Raise inotify limits on the cluster node — default max_user_instances=128 is
	@# too low for the number of fsnotify watchers created by Go services.
	@KIND_NODE=$$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); \
	if [ -n "$$KIND_NODE" ]; then \
	  docker exec "$$KIND_NODE" sysctl -w fs.inotify.max_user_instances=512 > /dev/null 2>&1 && \
	  echo "  inotify: max_user_instances set to 512 on $$KIND_NODE" || true; \
	fi
	$(MAKE) helm-tier-namespaces
	$(MAKE) ensure-local-shared-default-bucket
	@# Local default is gateway.provider=istio. Skip NGF install (which
	@# pulls ghcr.io/nginx/nginx-gateway-fabric and would otherwise block
	@# the deploy on corporate networks that intercept ghcr.io). Keep the
	@# Gateway API CRDs — they're cloud-neutral. Set GATEWAY_PROVIDER=nginx
	@# to bring NGF back into the install (rollback path).
	@if [ "$(GATEWAY_PROVIDER)" = "nginx" ]; then \
	  $(MAKE) install-gateway-api SKIP_NGF_INSTALL=0; \
	else \
	  $(MAKE) install-gateway-api; \
	  echo "Installing self-managed Istio (local default = istio)..."; \
	  $(MAKE) helm-istio-install; \
	  echo "Bridging legacy NGF TLS secret if present (idempotent; no-op on fresh clusters)..."; \
	  $(MAKE) migrate-ngf-tls-to-edge; \
	  echo "Installing Istio mesh policies (PeerAuth STRICT, AuthzPolicy, injection labels)..."; \
	  $(MAKE) helm-mesh-policies-install; \
	fi
	@echo "Preparing Gateway API TLS secret for local edge namespace..."
	@# Local clusters may have cert-manager CRDs without an active issuer flow for this gateway.
	@# Force legacy TLS prep so nemo-gateway-tls is always created for single-pass local deploys.
	@ENDPOINT="$(ENDPOINT)" NAMESPACE=$(HELM_NS_EDGE) CERT_MANAGER_GATEWAY_TLS="$(CERT_MANAGER_GATEWAY_TLS)" FORCE_LEGACY_TLS_PREP=1 $(SCRIPTS_DIR)/prepare-nemo-gateway.sh || true
	@# Provision cluster-internal utility images (init-tools, job-setup) for the
	@# current kubectl context. The chart references these as
	@# `$(CONTAINER_IMAGE_REPO)/<img>:$(IMAGE_TAG)` (and a few stubborn templates
	@# also reference `:latest`), so this step ensures BOTH refs are reachable
	@# from the cluster:
	@#
	@#   - kind / k3d / docker-desktop / orbstack:
	@#       Build with the registry-prefixed tag (and `:latest`) on the host
	@#       daemon. For kind / k3d, side-load the same refs into the node so
	@#       the kubelet resolves them without ever touching the registry.
	@#       docker-desktop / orbstack share the daemon directly — no load
	@#       needed. Local clusters never need registry credentials.
	@#
	@#   - any other context (SKS / AKS / GKE / EKS / ...):
	@#       Build + push via the standard per-image Makefile (build-push),
	@#       which tags `:IMAGE_TAG` and `:latest` and pushes both. Without
	@#       this, deploys against a remote cluster ImagePullBackOff the moment
	@#       a hook Job references one of these utility images at the current
	@#       IMAGE_TAG — verified on sks6316 (workers-s3-bucket-init Job hung
	@#       for 30+ min because nothing in the build pipeline pushed job-setup
	@#       at the new commit tag, even though it sits in ALL_IMAGES alongside
	@#       every other image and SHOULD have been pushed).
	@#
	@# Both arms honor IMAGE_TAG (falling back to `latest`, matching the chart's
	@# own default for global.imageTag) so resume-from-failure runs at the same
	@# IMAGE_TAG find the same image on the cluster.
	@echo "Preparing utility images (init-tools, job-setup)..."
	@CTX=$$(kubectl config current-context 2>/dev/null || true); \
	if [ -z "$$CTX" ]; then \
	  echo "ERROR: no active kubectl context — cannot determine local-vs-remote build path." >&2; \
	  echo "  Set a context with 'kubectl config use-context <name>' (or 'kubectx <name>') and retry." >&2; \
	  echo "  Without this guard, an empty context would fall through to the remote-registry" >&2; \
	  echo "  build+push arm and attempt to push to \$$(CONTAINER_IMAGE_REPO) unintentionally." >&2; \
	  exit 1; \
	fi; \
	CLUSTER_NAME=$${CTX#kind-}; CLUSTER_NAME=$${CLUSTER_NAME#k3d-}; \
	EFFECTIVE_TAG="$(or $(IMAGE_TAG),latest)"; \
	for img_dir in init-tools job-setup; do \
	  if [ ! -f "src/images/$$img_dir/Dockerfile" ]; then continue; fi; \
	  TAG_REF="$(CONTAINER_IMAGE_REPO)/$$img_dir:$$EFFECTIVE_TAG"; \
	  LATEST_REF="$(CONTAINER_IMAGE_REPO)/$$img_dir:latest"; \
	  case "$$CTX" in \
	    kind-*|k3d-*|docker-desktop|orbstack) \
	      echo "  [$$CTX] building $$TAG_REF (+:latest) on host daemon..."; \
	      docker build -t "$$TAG_REF" -t "$$LATEST_REF" src/images/$$img_dir/ --quiet 2>/dev/null || \
	        docker build -t "$$TAG_REF" -t "$$LATEST_REF" src/images/$$img_dir/; \
	      case "$$CTX" in \
	        kind-*) kind load docker-image "$$TAG_REF" "$$LATEST_REF" --name "$$CLUSTER_NAME" 2>/dev/null || true ;; \
	        k3d-*)  k3d image import "$$TAG_REF" "$$LATEST_REF" -c "$$CLUSTER_NAME" 2>/dev/null || true ;; \
	        docker-desktop|orbstack) echo "    [$$CTX] shares daemon — no load needed." ;; \
	      esac ;; \
	    *) \
	      echo "  [$$CTX] remote cluster: build+push $$TAG_REF (+:latest)..."; \
	      $(MAKE) -C src/images/$$img_dir build-push \
	        VERSION="$$EFFECTIVE_TAG" \
	        REGISTRY="$(CONTAINER_IMAGE_REPO)" \
	        REPO_ROOT="$(CURDIR)" \
	        DOCKER_PLATFORMS="$(DOCKER_PLATFORMS)" \
	        CONTAINER="$(CONTAINER)" || exit 1 ;; \
	  esac; \
	done
	$(MAKE) helm-database-upgrade
	$(MAKE) helm-wait-database
	$(MAKE) ensure-shared-postgresql-secret
	$(MAKE) helm-identity-upgrade-local KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-wait-keycloak KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)

# Full tier-based local deployment — works on any local Kubernetes cluster
# (KIND, Docker Desktop, k3d, minikube). Mirrors deploy-all-tiers-aks but
# uses values-local.yaml overlays instead of values-aks.yaml.
# Run once: make load-images-local  (loads locally-built images into the cluster)
# Then:     make deploy-local
deploy-local: ## Deploy all tiers on a local Kubernetes cluster (KIND / Docker Desktop / k3d / minikube). OBSERVABILITY=1 for monitoring.
	@# Phased orchestrator. Each phase is its own make target so a failure
	@# stops with a precise resume hint; the user can fix the underlying
	@# issue and re-run from that phase forward without re-running the
	@# whole chain. Mirrors the deploy-all pattern from
	@# `unified-embedding-models`, adapted for the tier layout.
	@kubectl cluster-info > /dev/null 2>&1 || { echo "ERROR: no active kubectl context — point kubectl at your local cluster"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  AgentStudio local deploy → ENDPOINT=$(ENDPOINT) IMAGE_TAG=$(IMAGE_TAG)$(if $(FORCE_PULL), FORCE_PULL=1)$(if $(filter 1,$(OBSERVABILITY)), OBSERVABILITY=1)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@# Pre-flight (silent on the happy path; prints only when it rolls back
	@# a stuck release). Runs before any phase so an interrupted prior
	@# deploy doesn't block this one on "another operation in progress".
	$(MAKE) local-preflight
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 1/8: Foundation  (CSI driver, namespaces, Gateway API, database, identity)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@# Base Secrets Store CSI driver DaemonSet. AKS uses it to mount Azure
	@# Key Vault objects via the Azure provider; on local clusters Keycloak's
	@# values-local.yaml has secretProviderClass.enabled=false (chart-rendered
	@# secrets, not Key Vault) so the DaemonSet provides zero value here.
	@# Skipped by default on local to avoid the registry.k8s.io image pull
	@# stalling the deploy on networks that intercept k8s registry TLS.
	@# Opt back in by passing INSTALL_SS_CSI_DRIVER=1.
	@if [ "$(INSTALL_SS_CSI_DRIVER)" = "1" ]; then \
	  $(MAKE) helm-ss-csi-driver-upgrade \
	    || { printf "\n$(COLOR_CYAN)FAILED at Phase 1 (CSI driver)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make deploy-local INSTALL_SS_CSI_DRIVER=1$(COLOR_RESET)\n\n"; exit 1; }; \
	else \
	  echo "  Skipping Secrets Store CSI driver on local (no SecretProviderClass references on this overlay; pass INSTALL_SS_CSI_DRIVER=1 to install anyway)."; \
	fi
	@$(MAKE) deploy-local-bootstrap-fresh \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 1 (Foundation bootstrap)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make deploy-local-bootstrap-fresh$(COLOR_RESET) → $(COLOR_GREEN)make deploy-local$(COLOR_RESET) (will skip already-completed phases)\n\n"; exit 1; }
	@# Observability runs AFTER identity so keycloak-oidc-secrets (synced into monitoring by
	@# deploy-observability-local → helm-observability-upgrade-local → sync-shared-secrets)
	@# already has grafana-proxy-client-secret patched in by the post-realm-bootstrap Job.
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 0: Observability (Prometheus + Grafana)\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	  $(MAKE) deploy-observability-local \
	    || { printf "\n$(COLOR_CYAN)FAILED at Phase 0 (Observability)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make deploy-local OBSERVABILITY=1$(COLOR_RESET)\n\n"; exit 1; }; \
	fi
	@# Edge tier defaults to gateway.provider=istio on local; assert the
	@# cluster-admin prereqs (istiod Ready, GatewayClass=istio Accepted,
	@# Gateway API CRD bundle, edge TLS Secret) are all in place before any
	@# tier upgrade. Skip on the explicit nginx rollback path.
	@if [ "$(GATEWAY_PROVIDER)" != "nginx" ]; then \
	  printf "\n  Pre-tier: verify-istio-gateway (local default = istio)\n"; \
	  $(MAKE) verify-istio-gateway \
	    || { printf "\n$(COLOR_CYAN)FAILED at Phase 1 (verify-istio-gateway)$(COLOR_RESET).\n  Resume: fix istiod/Gateway API prereqs then $(COLOR_GREEN)make deploy-local$(COLOR_RESET) (or pass $(COLOR_GREEN)GATEWAY_PROVIDER=nginx$(COLOR_RESET) for the NGF rollback path)\n\n"; exit 1; }; \
	fi
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 2/8: Workers  (s3gateway, dataset/kb/connector workers, storage-manager)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@$(MAKE) helm-workers-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 2 (Workers)$(COLOR_RESET).\n  Resume from here: $(COLOR_GREEN)make helm-workers-upgrade CLOUD=local && make deploy-local$(COLOR_RESET)\n\n"; exit 1; }
	@$(MAKE) helm-wait-s3gateway \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 2 (s3gateway readiness)$(COLOR_RESET).\n  Inspect: $(COLOR_GREEN)kubectl get pods -n $(HELM_NS_WORKERS)$(COLOR_RESET) then $(COLOR_GREEN)make deploy-local$(COLOR_RESET)\n\n"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 3/8: Platform  (Temporal, Lakekeeper, Redis)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@$(MAKE) helm-platform-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 3 (Platform)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make helm-platform-upgrade CLOUD=local && make deploy-local$(COLOR_RESET)\n\n"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 4/8: LLM Gateway  (Bifrost)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@$(MAKE) helm-llm-gateway-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 4 (LLM Gateway)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make helm-llm-gateway-upgrade CLOUD=local && make deploy-local$(COLOR_RESET)\n\n"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 5/8: Services  (config-service, agent-service, workflow-engine, kb-retrieval, artifact, analytics, apigateway)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@$(MAKE) helm-services-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 5 (Services)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make helm-services-upgrade CLOUD=local && make deploy-local$(COLOR_RESET)\n\n"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 6/8: Console  (gui, agent-studio-ui)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@$(MAKE) helm-console-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 6 (Console)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make helm-console-upgrade CLOUD=local$(COLOR_RESET)\n\n"; exit 1; }
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 7/8: Edge  (Gateway + HTTPRoutes bind to backend Services)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@# Edge tier last: Gateway + HTTPRoute(s) in agentstudio-edge bind to
	@# the now-existing backend Services. Local default is the Istio data
	@# plane (gateway.provider=istio in values-local.yaml); pass
	@# GATEWAY_PROVIDER=nginx for the NGF rollback path.
	@$(MAKE) helm-edge-upgrade CLOUD=local \
	  || { printf "\n$(COLOR_CYAN)FAILED at Phase 7 (Edge)$(COLOR_RESET).\n  Resume: $(COLOR_GREEN)make helm-edge-upgrade CLOUD=local$(COLOR_RESET)\n\n"; exit 1; }
	@# Post-cutover NGF teardown: only on the istio path AND once the new
	@# edge Gateway is Programmed=True. Mirrors the same gate AKS/GKE/EKS
	@# orchestrators use, so `make deploy CLOUD=local` exercises the
	@# identical migration code path the cloud CDs will run. ngf-uninstall
	@# is idempotent — on fresh-istio clusters with no NGF release this is
	@# a no-op. Skip on the explicit nginx rollback path. Non-fatal: a
	@# missed NGF cleanup doesn't break the deploy, just leaves cruft.
	@if [ "$(GATEWAY_PROVIDER)" != "nginx" ]; then \
	  printf "\n  Post-cutover: tearing down NGF (gated on Gateway Programmed=True)\n"; \
	  if $(MAKE) wait-istio-gateway-programmed; then \
	    $(MAKE) ngf-uninstall || echo "WARN: ngf-uninstall returned non-zero; safe to re-run manually."; \
	  else \
	    echo "WARN: edge Gateway did not reach Programmed=True; leaving NGF in place. Re-run 'make ngf-uninstall' once the istio Gateway is healthy."; \
	  fi; \
	fi
	@if [ "$(FORCE_PULL)" = "1" ]; then \
	  printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Phase 8/8: Force-pull rollout  (FORCE_PULL=1; rolls every Deployment so pods re-pull)\n$(SEPARATOR)$(COLOR_RESET)\n\n"; \
	  $(MAKE) local-force-pull-rollout \
	    || { printf "\n$(COLOR_CYAN)FAILED at Phase 8 (Force-pull rollout)$(COLOR_RESET).\n  Inspect kubectl RBAC + retry: $(COLOR_GREEN)make local-force-pull-rollout$(COLOR_RESET)\n\n"; exit 1; }; \
	fi
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  $(COLOR_GREEN)✔  Local deploy complete$(COLOR_CYAN)\n$(SEPARATOR)$(COLOR_RESET)\n"
	@printf "  Verify pods:    $(COLOR_GREEN)kubectl get pods -A$(COLOR_RESET)\n"
	@printf "  Local access:   $(COLOR_GREEN)http://localhost:8080$(COLOR_RESET)  /  $(COLOR_GREEN)https://localhost:8443$(COLOR_RESET)\n\n"

# Pre-flight: roll back any helm release stuck in pending-* so a re-run
# of deploy-local doesn't fail with "another operation in progress" on
# the next helm upgrade. Silent on the happy path. Extracted from
# deploy-local so the phased view stays focused on the actual phases.
local-preflight: ## Roll back stuck pending-* helm releases across tier namespaces (called automatically by deploy-local)
	@rolled=0; \
	for rel_ns in \
	    "$(HELM_RELEASE_PLATFORM):$(HELM_NS_PLATFORM)" \
	    "$(HELM_RELEASE_LLM_GATEWAY):$(HELM_NS_LLM_GATEWAY)" \
	    "$(HELM_RELEASE_SERVICES):$(HELM_NS_SERVICES)" \
	    "$(HELM_RELEASE_CONSOLE):$(HELM_NS_CONSOLE)" \
	    "$(HELM_RELEASE_WORKERS):$(HELM_NS_WORKERS)" \
	    "$(HELM_RELEASE_EDGE):$(HELM_NS_EDGE)"; do \
	  rel=$$(echo $$rel_ns | cut -d: -f1); ns=$$(echo $$rel_ns | cut -d: -f2); \
	  st=$$(helm status $$rel -n $$ns -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['status'])" 2>/dev/null || true); \
	  case "$$st" in pending-install|pending-upgrade|pending-rollback) \
	    if [ $$rolled -eq 0 ]; then printf "\n$(COLOR_CYAN)  Pre-flight: rolling back stuck helm releases$(COLOR_RESET)\n"; rolled=1; fi; \
	    printf "    ⟲  %s in %s (was: %s)\n" "$$rel" "$$ns" "$$st"; \
	    helm rollback $$rel -n $$ns 2>/dev/null || helm uninstall $$rel -n $$ns 2>/dev/null || true ;; \
	  esac; \
	done

local-force-pull-rollout: ## Restart every AgentStudio Deployment+StatefulSet so pods re-pull (paired with FORCE_PULL=1 + imagePullPolicy=Always). Safe to invoke manually.
	@# Previously this step did `kubectl rollout restart ... 2>/dev/null || true`,
	@# which swallowed RBAC/network failures silently. That left tier pods
	@# untouched across multiple FORCE_PULL=1 deploys (verified: every
	@# Deployment's `kubectl.kubernetes.io/restartedAt` annotation stayed
	@# empty for hours). We now surface errors per-resource AND iterate
	@# over each Deployment/StatefulSet by name so the user sees exactly
	@# what got patched. A summary at the end tallies success vs failure.
	@echo ""
	@echo "===  force-pull-rollout: restarting every AgentStudio workload ==="
	@total_ok=0; total_skip=0; total_fail=0; \
	for ns in \
	    "$(HELM_NS_DATABASE)" \
	    "$(HELM_NS_IDENTITY)" \
	    "$(HELM_NS_PLATFORM)" \
	    "$(HELM_NS_LLM_GATEWAY)" \
	    "$(HELM_NS_SERVICES)" \
	    "$(HELM_NS_CONSOLE)" \
	    "$(HELM_NS_WORKERS)" \
	    "$(HELM_NS_OBSERVABILITY)"; do \
	  if ! kubectl get namespace "$$ns" >/dev/null 2>&1; then \
	    echo "  ⏭  $$ns (namespace does not exist)"; \
	    total_skip=$$((total_skip+1)); \
	    continue; \
	  fi; \
	  printf "  ▶  %s\n" "$$ns"; \
	  for kind in deployment statefulset; do \
	    names=$$(kubectl get $$kind -n "$$ns" -o name 2>/dev/null || true); \
	    if [ -z "$$names" ]; then continue; fi; \
	    for res in $$names; do \
	      if kubectl rollout restart "$$res" -n "$$ns" >/dev/null; then \
	        printf "      ✓  rolled %s\n" "$$res"; \
	        total_ok=$$((total_ok+1)); \
	      else \
	        printf "      ✗  FAILED to roll %s — check RBAC/connectivity\n" "$$res" >&2; \
	        total_fail=$$((total_fail+1)); \
	      fi; \
	    done; \
	  done; \
	done; \
	echo ""; \
	echo "===  force-pull-rollout summary: $$total_ok rolled, $$total_skip namespace(s) skipped, $$total_fail failed ==="; \
	if [ $$total_fail -gt 0 ]; then \
	  echo "    Failures surfaced above. Verify your kubeconfig has 'patch deployments,statefulsets' RBAC." >&2; \
	  exit 1; \
	fi
	@echo "Watch with: kubectl get pods -A -w"

# Load all locally-built images into the local cluster.
# Auto-detects cluster type from the current kubectl context name:
#   kind-*         → kind load docker-image
#   k3d-*          → k3d image import
#   docker-desktop → no-op (Docker Desktop shares the host Docker daemon)
#   orbstack       → no-op (OrbStack shares the host Docker daemon)
#   minikube       → minikube image load
load-images-local: ## Load locally-built images into the local cluster (detects kind/k3d/docker-desktop/orbstack/minikube)
	@CTX=$$(kubectl config current-context 2>/dev/null || true); \
	case "$$CTX" in \
	  docker-desktop|orbstack) \
	    echo "[$$CTX] shares the host Docker daemon — no image load required."; \
	    exit 0 ;; \
	  kind-*) \
	    cluster=$${CTX#kind-}; \
	    for service in $(NEMO_SERVICES); do \
	      img="$(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)"; \
	      echo "  kind load $$img -> $$cluster"; \
	      kind load docker-image "$$img" --name "$$cluster" || exit 1; \
	    done ;; \
	  k3d-*) \
	    cluster=$${CTX#k3d-}; \
	    for service in $(NEMO_SERVICES); do \
	      img="$(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)"; \
	      echo "  k3d image import $$img -> $$cluster"; \
	      k3d image import "$$img" -c "$$cluster" || exit 1; \
	    done ;; \
	  minikube) \
	    for service in $(NEMO_SERVICES); do \
	      img="$(CONTAINER_IMAGE_REPO)/nemo/$$service:$(VERSION)"; \
	      echo "  minikube image load $$img"; \
	      minikube image load "$$img" || exit 1; \
	    done ;; \
	  *) \
	    echo "[$$CTX] unknown local context — no image load attempted."; \
	    exit 0 ;; \
	esac


# Note: migrate-local-monolith-to-tiers (one-shot tool for tearing down the
# pre-PR-#64 nemo/nemo-deps monolith on KIND/Docker-Desktop/k3d/minikube)
# was removed once all local environments had moved to the tier layout.
# If you need to recover a pre-PR-#64 local cluster, check out the
# target from git history at PR #64's parent commit.
