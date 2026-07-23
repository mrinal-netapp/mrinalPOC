# mk/cloud/deploy-orchestrator.mk -- cloud-agnostic tier upgrade targets.
#
# Collapses the former 6x4 per-cloud wrappers (helm-<tier>-upgrade-<cloud> in
# mk/cloud/{aks,eks,gke,local}.mk) into ONE generic target per tier, selected
# by the CLOUD variable (the helm token: local|aks|eks|gke). Each per-cloud
# orchestrator now calls `$(MAKE) helm-<tier>-upgrade CLOUD=<cloud>`.
#
# The per-cloud difference is pure DATA, resolved via GNU make computed
# variable references: $($(CLOUD_UC)_TIER_SET) and $($(CLOUD_UC)_<TIER>_EXTRA)
# (e.g. CLOUD=aks -> $(AKS_TIER_SET) / $(AKS_WORKERS_EXTRA)). values-<cloud>.yaml
# is applied inside helm_upgrade_tier (mk/tier-helm.mk) when present.
#
# Per-tier pre-hooks are preserved exactly as they were per cloud:
#   workers/services/console : sync-shared-secrets (+ label-secrets-for-helm on aks only)
#   platform                 : platform_pre_hook (all clouds)
#   llm-gateway/edge         : none
# The aks-only label-secrets step is gated on $(filter aks,$(CLOUD)) so the
# emitted commands stay byte-identical to the pre-collapse per-cloud targets.

# Uppercased CLOUD for computed *_TIER_SET / *_<TIER>_EXTRA lookups.
CLOUD_UC := $(shell printf '%s' '$(CLOUD)' | tr '[:lower:]' '[:upper:]')

# Guard against dispatch tokens (azure/aws/gcp) or typos silently selecting the
# wrong values-<cloud>.yaml overlay.
define require_helm_cloud
	@case "$(CLOUD)" in local|aks|eks|gke) ;; \
	  *) echo "ERROR: helm tier upgrades need CLOUD in {local,aks,eks,gke} (got '$(CLOUD)')." >&2; \
	     echo "       Dispatch tokens azure/aws/gcp are for 'make deploy' only." >&2; exit 1 ;; \
	esac
endef

helm-workers-upgrade: ## Upgrade/Install workers tier (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_WORKERS)
	$(if $(filter aks,$(CLOUD)),$(call label-secrets-for-helm,$(HELM_RELEASE_WORKERS),$(HELM_NS_WORKERS)))
	$(call helm_upgrade_tier,workers,$(HELM_RELEASE_WORKERS),$(HELM_NS_WORKERS),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_WORKERS_EXTRA))

helm-platform-upgrade: ## Upgrade/Install platform tier (temporal, lakekeeper, redis) (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(call platform_pre_hook)
	$(call helm_upgrade_tier,platform,$(HELM_RELEASE_PLATFORM),$(HELM_NS_PLATFORM),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_PLATFORM_EXTRA))

helm-llm-gateway-upgrade: ## Upgrade/Install llm-gateway tier (bifrost) (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(call helm_upgrade_tier,llm-gateway,$(HELM_RELEASE_LLM_GATEWAY),$(HELM_NS_LLM_GATEWAY),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_LLM_GATEWAY_EXTRA))

helm-services-upgrade: ## Upgrade/Install services tier (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_SERVICES)
	$(if $(filter aks,$(CLOUD)),$(call label-secrets-for-helm,$(HELM_RELEASE_SERVICES),$(HELM_NS_SERVICES)))
	$(call helm_upgrade_tier,services,$(HELM_RELEASE_SERVICES),$(HELM_NS_SERVICES),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_SERVICES_EXTRA))

helm-console-upgrade: ## Upgrade/Install console tier (gui) (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_CONSOLE)
	$(if $(filter aks,$(CLOUD)),$(call label-secrets-for-helm,$(HELM_RELEASE_CONSOLE),$(HELM_NS_CONSOLE)))
	$(call helm_upgrade_tier,console,$(HELM_RELEASE_CONSOLE),$(HELM_NS_CONSOLE),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_CONSOLE_EXTRA))

helm-edge-upgrade: ## Upgrade/Install edge tier (Gateway + HTTPRoutes + mesh policies) (CLOUD={local|aks|eks|gke})
	$(call require_helm_cloud)
	$(call helm_upgrade_tier,edge,$(HELM_RELEASE_EDGE),$(HELM_NS_EDGE),$(CLOUD),$($(CLOUD_UC)_TIER_SET),$($(CLOUD_UC)_EDGE_EXTRA))

# ─── Generic cloud orchestrator ───────────────────────────────────────────────
# deploy-all-tiers CLOUD={aks|eks|gke} runs the shared skeleton and delegates the
# cloud-specific pre-workers prep (storage bootstrap, gateway TLS, DB, identity,
# observability) to $(CLOUD)-deploy-foundation, and the end gate to
# $(CLOUD)-deploy-postgate. The former per-cloud deploy-all-tiers-<cloud> targets
# are now thin aliases to this. `local` keeps its own bespoke orchestrator
# (deploy-local) and does NOT route here.
#
# Skeleton (common to aks/eks/gke):
#   require KEYCLOAK_HOSTNAME (derive from ENDPOINT) -> cluster-info -> registry
#   guardrail + IMAGE_TAG guard -> pending-release rollback -> (istio) prereq +
#   verify -> namespaces -> (istio) label + mesh -> $(CLOUD)-deploy-foundation ->
#   workers (+ shared-bucket PV vars if $(SHARED_PVS_ENV) present) -> wait-s3gateway
#   -> platform -> llm-gateway -> services (+PV) -> console -> edge ->
#   (istio) inject-existing + NGF teardown -> $(CLOUD)-deploy-postgate
#
# Gateway substrate stays GATEWAY_PROVIDER-gated (NGF preserved; deprecation is
# out of scope). SHARED_PVS_ENV is only written by aks-deploy-foundation
# (aks-ensure-shared-default-bucket); on eks/gke it is absent so the workers/
# services PV `--set` is skipped -- the tail therefore stays cloud-agnostic.
ALLOW_PENDING_RELEASE_UNINSTALL ?= false

deploy-all-tiers: ## Deploy all tiers on a cloud: make deploy-all-tiers CLOUD={aks|eks|gke} (invoked by `make deploy`). OBSERVABILITY=1 for monitoring.
	@case "$(CLOUD)" in aks|eks|gke) ;; *) echo "ERROR: deploy-all-tiers needs CLOUD in {aks,eks,gke} (got '$(CLOUD)'); local uses deploy-local." >&2; exit 1 ;; esac
	@# KEYCLOAK_HOSTNAME is required by the identity tier (productionMode). It is
	@# derived from the env file by `make deploy` (env-file mode) or by the
	@# deploy-eks/deploy-gke wrappers (flag mode) before we get here.
	@if [ -z "$(strip $(KEYCLOAK_HOSTNAME))" ]; then \
	  echo "ERROR: deploy-all-tiers (CLOUD=$(CLOUD)) requires KEYCLOAK_HOSTNAME." >&2; \
	  echo "       Use 'make deploy CLOUD=<c> ENV=<env> IMAGE_TAG=<tag>' (derives it), or pass KEYCLOAK_HOSTNAME=https://auth.<endpoint>." >&2; \
	  exit 1; \
	fi
	@kubectl cluster-info > /dev/null 2>&1 || { echo "ERROR: no active kubectl context"; exit 1; }
	@# Registry guardrail: reject the laptop default repo + require an image tag on
	@# real cloud deploys (a stray laptop repo makes kubelet fail every pull).
	@repo="$$(printf '%s' '$(CONTAINER_IMAGE_REPO)' | tr -d '[:space:]')"; \
	if [ -z "$$repo" ] || echo "$$repo" | grep -Eq '^docker\.repo\.eng\.netapp\.com/user/'; then \
	  echo "ERROR: deploy-all-tiers (CLOUD=$(CLOUD)) requires CONTAINER_IMAGE_REPO set to your cloud registry (got: $${repo:-<empty>})." >&2; exit 1; \
	fi; \
	if [ -z "$$(printf '%s' '$(IMAGE_TAG)' | tr -d '[:space:]')" ]; then \
	  echo "ERROR: deploy-all-tiers (CLOUD=$(CLOUD)) requires IMAGE_TAG (CI-produced tag)." >&2; exit 1; \
	fi
	@# Pre-flight: roll back releases stuck in pending-* so a re-run after an
	@# interrupted deploy doesn't block on "another operation in progress".
	@for rel_ns in \
	    "$(HELM_RELEASE_DATABASE):$(HELM_NS_DATABASE)" \
	    "$(HELM_RELEASE_IDENTITY):$(HELM_NS_IDENTITY)" \
	    "$(HELM_RELEASE_WORKERS):$(HELM_NS_WORKERS)" \
	    "$(HELM_RELEASE_PLATFORM):$(HELM_NS_PLATFORM)" \
	    "$(HELM_RELEASE_LLM_GATEWAY):$(HELM_NS_LLM_GATEWAY)" \
	    "$(HELM_RELEASE_SERVICES):$(HELM_NS_SERVICES)" \
	    "$(HELM_RELEASE_CONSOLE):$(HELM_NS_CONSOLE)" \
	    "$(HELM_RELEASE_EDGE):$(HELM_NS_EDGE)"; do \
	  rel=$$(echo $$rel_ns | cut -d: -f1); ns=$$(echo $$rel_ns | cut -d: -f2); \
	  st=$$(helm status $$rel -n $$ns -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['status'])" 2>/dev/null || true); \
	  case "$$st" in pending-install|pending-upgrade|pending-rollback) \
	    echo "  Pre-flight: rolling back stuck release $$rel ($$st) in $$ns"; \
	    if ! helm rollback $$rel -n $$ns 2>/dev/null; then \
	      if [ "$(ALLOW_PENDING_RELEASE_UNINSTALL)" = "true" ]; then \
	        echo "  WARNING: rollback failed for $$rel; explicit opt-in set, running helm uninstall"; \
	        helm uninstall $$rel -n $$ns 2>/dev/null || true; \
	      else \
	        echo "ERROR: rollback failed for $$rel in $$ns; refusing to auto-uninstall (possible data-loss). Set ALLOW_PENDING_RELEASE_UNINSTALL=true to permit."; \
	        exit 1; \
	      fi; \
	    fi ;; \
	  esac; \
	done
	@# Gateway substrate (GATEWAY_PROVIDER-gated; NGF preserved). istio-prereq is
	@# idempotent. install-gateway-api (NGF path) is handled per-cloud in the
	@# foundation, matching today's behavior.
	@if [ "$(GATEWAY_PROVIDER)" = "istio" ]; then \
	  $(MAKE) istio-prereq; \
	  echo "=== Pre-flight: verify-istio-gateway (GATEWAY_PROVIDER=istio) ==="; \
	  $(MAKE) verify-istio-gateway; \
	fi
	$(MAKE) helm-tier-namespaces
	@if [ "$(GATEWAY_PROVIDER)" = "istio" ]; then \
	  echo "=== Mesh: label namespaces for injection + install mesh policies (STRICT) ==="; \
	  $(MAKE) istio-label-namespaces; \
	  $(MAKE) helm-mesh-policies-install; \
	fi
	@# Cloud-specific foundation: storage bootstrap + gateway TLS + database +
	@# identity + observability, in the cloud's order (kept behavior-preserving).
	$(MAKE) $(CLOUD)-deploy-foundation
	@# ── Common tier tail (workers -> edge). AKS shared-bucket PV names, if the
	@# foundation wrote $(SHARED_PVS_ENV), are threaded into workers + services.
	@if [ "$(CLOUD)" = "aks" ] && [ -n "$(strip $(SHARED_PVS_ENV))" ] && [ -s "$(SHARED_PVS_ENV)" ]; then \
	  set -a; . ./"$(SHARED_PVS_ENV)"; set +a; \
	  $(MAKE) helm-workers-upgrade CLOUD=$(CLOUD) S3GW_PV_DEFAULT_BUCKET=$$S3GW_PV_DEFAULT_BUCKET; \
	else \
	  $(MAKE) helm-workers-upgrade CLOUD=$(CLOUD); \
	fi
	$(MAKE) helm-wait-s3gateway
	$(MAKE) helm-platform-upgrade CLOUD=$(CLOUD)
	$(MAKE) helm-llm-gateway-upgrade CLOUD=$(CLOUD)
	@if [ "$(CLOUD)" = "aks" ] && [ -n "$(strip $(SHARED_PVS_ENV))" ] && [ -s "$(SHARED_PVS_ENV)" ]; then \
	  set -a; . ./"$(SHARED_PVS_ENV)"; set +a; \
	  $(MAKE) helm-services-upgrade CLOUD=$(CLOUD) SERVICES_PV_DEFAULT_BUCKET=$$SERVICES_PV_DEFAULT_BUCKET; \
	else \
	  $(MAKE) helm-services-upgrade CLOUD=$(CLOUD); \
	fi
	$(MAKE) helm-console-upgrade CLOUD=$(CLOUD)
	$(MAKE) helm-edge-upgrade CLOUD=$(CLOUD)
	@# Sidecar convergence + post-cutover NGF teardown (istio only; idempotent).
	@if [ "$(GATEWAY_PROVIDER)" = "istio" ]; then \
	  $(MAKE) istio-inject-existing; \
	  echo "=== Post-cutover: tearing down NGF (gated on Gateway Programmed=True) ==="; \
	  if $(MAKE) wait-istio-gateway-programmed; then \
	    $(MAKE) ngf-uninstall; \
	  else \
	    echo "WARN: edge Gateway did not reach Programmed=True; leaving NGF in place. Re-run 'make ngf-uninstall' once healthy."; \
	  fi; \
	fi
	$(MAKE) $(CLOUD)-deploy-postgate
	@echo ""
	@echo "=== $(CLOUD) tier deployment complete ==="

# Default no-op end-of-deploy gate; aks/gke override in their cloud mk files.
eks-deploy-postgate: ; @:

# ─── Back-compat aliases (helm-<tier>-upgrade-<cloud>) ───────────────────────
# Legacy runbooks/scripts still invoke the per-cloud names. Thin forwards to the
# generic targets with CLOUD=<cloud> (MAKEFLAGS propagates -n for dry-runs).
helm-%-upgrade-local:
	@$(MAKE) helm-$*-upgrade CLOUD=local $(MAKEOVERRIDES)

helm-%-upgrade-aks:
	@$(MAKE) helm-$*-upgrade CLOUD=aks $(MAKEOVERRIDES)

helm-%-upgrade-eks:
	@$(MAKE) helm-$*-upgrade CLOUD=eks $(MAKEOVERRIDES)

helm-%-upgrade-gke:
	@$(MAKE) helm-$*-upgrade CLOUD=gke $(MAKEOVERRIDES)
