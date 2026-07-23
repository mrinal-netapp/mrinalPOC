# mk/dispatch.mk -- cloud-scoped help + env-propagation guardrail.
#
# The single `make deploy CLOUD=<cloud> ENV=<env>` entry point lives in
# mk/cloud/deploy-dispatch.mk (mirroring infra-dispatch.mk / storage-dispatch.mk).
# This file keeps the per-cloud `help-<cloud>` filters and the
# verify-env-propagation dry-run guardrail.

# ─── Cloud-scoped help ───────────────────────────────────────────────────────
# Filters `make help` output to only the targets a $(CLOUD) operator
# cares about, keyed off the standard naming convention defined in
# docs/deployment/makefile-target-conventions.md:
#   helm-<tier>-upgrade (CLOUD=<cloud>) or legacy helm-<tier>-upgrade-<cloud>
#   helm-tier-template-<cloud>
#   helm-identity-(install|upgrade|template)-<cloud>
#   deploy-all-tiers-<cloud>
#   <cloud>-* (cloud-side provisioning helpers)
#
# Reads $(MAKEFILE_LIST) (which now includes every mk/*.mk and
# mk/cloud/*.mk) so a per-cloud target newly added under mk/cloud/
# shows up automatically.

# Each per-cloud help filter is an OR list of full target prefixes
# rather than nested groups with empty alternatives (`(|-foo)`); macOS
# awk (BSD) rejects the latter as "illegal primary in regular expression".
help-local: ## List local-cluster targets (KIND / Docker Desktop / k3d / minikube)
	@echo "AgentStudio local-cluster targets:"
	@# `local-[a-z-]+` catchall future-proofs new convention-clean helpers
	@# (e.g. local-ensure-shared-default-bucket if/when the legacy
	@# verb-cloud-noun names are renamed). The explicit alternatives below
	@# keep the existing legacy targets visible until they're renamed.
	@awk -F':.*?## ' '/^(helm-[a-z-]+-upgrade(-local)?|helm-tier-template-local|helm-identity-install-local|helm-identity-upgrade-local|helm-identity-template-local|deploy-local|deploy-local-bootstrap-fresh|undeploy-local|ensure-local-shared-default-bucket|purge-local-shared-default-bucket|load-images-local|local-[a-z-]+):.*## / {printf "  %-45s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

help-aks: ## List AKS-relevant targets (Workload Identity + ANF NFS + Key Vault)
	@echo "AgentStudio AKS targets:"
	@# Every AKS-specific helper starts with `aks-` and is picked up by
	@# the `aks-[a-z-]+` catchall. The remaining explicit alternatives
	@# are the helm-* tier surface that legitimately spans every cloud
	@# (helm-<tier>-upgrade-aks, helm-tier-template-aks,
	@# helm-identity-{install,upgrade,template}-aks, deploy-all-tiers-aks).
	@awk -F':.*?## ' '/^(helm-[a-z-]+-upgrade(-aks)?|helm-tier-template-aks|helm-identity-install-aks|helm-identity-upgrade-aks|helm-identity-template-aks|deploy-all-tiers-aks|aks-[a-z-]+):.*## / {printf "  %-45s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

help-gke: ## List GKE-relevant targets (Filestore RWX + Cloud DNS + GCNV)
	@echo "AgentStudio GKE targets:"
	@awk -F':.*?## ' '/^(helm-[a-z-]+-upgrade(-gke)?|helm-tier-template-gke|helm-identity-install-gke|helm-identity-upgrade-gke|helm-identity-template-gke|deploy-all-tiers-gke|deploy-gke|deploy-gke-auto|gke-[a-z-]+):.*## / {printf "  %-45s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

help-eks: ## List EKS-relevant targets (FSx Trident RWX + AWS LB Controller + IAM-OIDC)
	@echo "AgentStudio EKS targets:"
	@awk -F':.*?## ' '/^(helm-[a-z-]+-upgrade(-eks)?|helm-tier-template-eks|helm-identity-install-eks|helm-identity-upgrade-eks|helm-identity-template-eks|deploy-all-tiers-eks|deploy-eks|eks-[a-z-]+):.*## / {printf "  %-45s %s\n", $$1, $$2}' $(MAKEFILE_LIST)


# ============================================================================
# Env-propagation guardrail
# ============================================================================
# Asserts that IMAGE_TAG / FORCE_PULL / ENDPOINT flow through to the emitted
# Helm command lines for every cloud's deploy entrypoint. Uses `make -n` so
# nothing is executed against a cluster — purely a dry-run grep.
#
# This target exists because mk/tier-helm.mk's per-cloud tier-set strings
# (LOCAL_TIER_SET / AKS_TIER_SET / GKE_TIER_SET / EKS_TIER_SET) are easy to
# get wrong: a missed `$(if $(IMAGE_TAG),...)` clause silently ignores the
# env var. Local in particular previously dropped IMAGE_TAG/FORCE_PULL/
# ENDPOINT, so `make deploy CLOUD=local IMAGE_TAG=v1.2.3` had no effect.
#
# Usage:
#   make verify-env-propagation \
#     IMAGE_TAG=v0.0.0-test FORCE_PULL=1 \
#     ENDPOINT=studio-test.local HELM_EXTRA_ARGS="--set foo=bar"
#
# See docs/deployment/env-propagation-matrix.md for the propagation contract.
verify-env-propagation: ## Dry-run helm-platform-upgrade for every cloud and assert IMAGE_TAG/FORCE_PULL/ENDPOINT flow into helm --set tokens
	@set -e; \
	TAG="$${IMAGE_TAG:-v0.0.0-verify}"; \
	END="$${ENDPOINT:-studio-verify.local}"; \
	FP="$${FORCE_PULL:-1}"; \
	XA="$${HELM_EXTRA_ARGS:-}"; \
	echo "verify-env-propagation: IMAGE_TAG=$$TAG FORCE_PULL=$$FP ENDPOINT=$$END"; \
	failed=0; \
	for cloud in local aks gke eks; do \
	  echo ""; \
	  echo "─── $$cloud ───"; \
	  out=$$($(MAKE) -n helm-platform-upgrade CLOUD=$$cloud IMAGE_TAG=$$TAG FORCE_PULL=$$FP ENDPOINT=$$END HELM_EXTRA_ARGS="$$XA" 2>&1 || true); \
	  if echo "$$out" | grep -qF -- "--set global.imageTag=$$TAG"; then \
	    echo "  ✓ IMAGE_TAG propagated"; \
	  else \
	    echo "  ✗ IMAGE_TAG NOT found in helm command lines"; failed=1; \
	  fi; \
	  if echo "$$out" | grep -qF -- "--set global.imagePullPolicy=Always"; then \
	    echo "  ✓ FORCE_PULL propagated"; \
	  else \
	    echo "  ✗ FORCE_PULL NOT found in helm command lines"; failed=1; \
	  fi; \
	  if [ "$$cloud" = "aks" ]; then \
	    echo "  · ENDPOINT: AKS deliberately drops it from tier-set (see env-propagation-matrix.md)"; \
	  else \
	    if echo "$$out" | grep -qF -- "--set global.endpoint=$$END"; then \
	      echo "  ✓ ENDPOINT propagated"; \
	    else \
	      echo "  ✗ ENDPOINT NOT found in helm command lines"; failed=1; \
	    fi; \
	  fi; \
	  if [ -n "$$XA" ]; then \
	    if echo "$$out" | grep -qF -- "$$XA"; then \
	      echo "  ✓ HELM_EXTRA_ARGS propagated"; \
	    else \
	      echo "  ✗ HELM_EXTRA_ARGS NOT found"; failed=1; \
	    fi; \
	  fi; \
	done; \
	echo ""; \
	if [ "$$failed" -ne 0 ]; then \
	  echo "verify-env-propagation: FAILED — at least one tier-set is dropping a deploy var. Check mk/tier-helm.mk."; \
	  exit 1; \
	fi; \
	echo "verify-env-propagation: OK — every cloud propagates IMAGE_TAG/FORCE_PULL/ENDPOINT."
