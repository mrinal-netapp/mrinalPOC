# mk/cloud/deploy-dispatch.mk -- single env-file-driven entry point for the
# application deploy layer (Layer 3), mirroring mk/cloud/infra-dispatch.mk and
# mk/cloud/storage-dispatch.mk.
#
#   make deploy CLOUD=azure ENV=preprod IMAGE_TAG=<tag>
#   make deploy CLOUD=aws   ENV=dev     IMAGE_TAG=<tag>
#   make deploy CLOUD=gcp   ENV=preprod IMAGE_TAG=<tag>
#   make deploy CLOUD=local                              # laptop; no env file
#
# CLOUD entry tokens match infra/storage (azure|aws|gcp|local). They are
# normalized to the helm tokens (aks|eks|gke|local) that drive values-<t>.yaml,
# helm-identity-install-<t>, and the *_TIER_SET vars. The legacy helm tokens
# (aks|eks|gke) are still accepted so existing CI (deploy-reusable.yml, which
# passes CLOUD=aks|gke|eks with flags and no ENV) keeps working during the
# transition.
#
# Two input modes:
#   - env-file mode (ENV set, CLOUD != local): ENDPOINT + CONTAINER_IMAGE_REPO
#     are read from deployments/<dir>/envs/<ENV>.yaml, KEYCLOAK_HOSTNAME is
#     derived, and IMAGE_TAG is required (supplied by CI after the image build).
#     GKE also passes DEPLOY_ENV_FILE so gke-ensure-storage-ready loads GCNV_*
#     / TRIDENT_* from the same yaml (no manual exports for preprod deploy).
#   - legacy flag mode (no ENV): ENDPOINT/IMAGE_TAG/etc. come from flags /
#     Makefile defaults exactly as before (command-line vars flow to the
#     sub-make via MAKEFLAGS).
# In both modes the tier rollout is delegated to the existing per-cloud
# orchestrator (deploy-local / deploy-all-tiers-aks / deploy-gke / deploy-eks).
# Precedence is Make-native: command-line flag > env-file value > default.

# Union of new (infra/storage) + legacy (helm) tokens, plus local.
DEPLOY_VALID_CLOUDS := azure aws gcp local aks eks gke

# Default cloud for a bare `make deploy`. local is lowest-privilege so a typo
# falls through to a laptop deploy rather than a production push.
CLOUD ?= local

deploy: ## Deploy app tiers: make deploy CLOUD={azure|aws|gcp|local} ENV=<env> IMAGE_TAG=<tag>. Pass OBSERVABILITY=1 / ENDPOINT=... (local uses defaults, no ENV).
	@case " $(DEPLOY_VALID_CLOUDS) " in \
	  *" $(CLOUD) "*) ;; \
	  *) echo "ERROR: CLOUD=$(CLOUD) is not in {$(DEPLOY_VALID_CLOUDS)}." >&2; \
	     echo "       Use azure|aws|gcp (env-file model) or local; aks|eks|gke accepted for legacy CI." >&2; \
	     exit 1 ;; \
	esac
	@set -e; \
	case "$(CLOUD)" in \
	  azure|aks) nc=aks;   dir=azure; target=deploy-all-tiers-aks ;; \
	  aws|eks)   nc=eks;   dir=aws;   target=deploy-eks ;; \
	  gcp|gke)   nc=gke;   dir=gcp;   target=deploy-gke ;; \
	  local)     nc=local; dir=;      target=deploy-local ;; \
	esac; \
	if [ "$$nc" != "local" ] && [ -n "$(ENV)" ]; then \
	  env_file="deployments/$$dir/envs/$(ENV).yaml"; \
	  [ -f "$$env_file" ] || { echo "ERROR: env file not found: $$env_file" >&2; exit 1; }; \
	  command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 not found in PATH." >&2; exit 1; }; \
	  python3 -c "import yaml" 2>/dev/null || { \
	    echo "ERROR: PyYAML not installed (required by deployments/_lib/env_yaml.py)." >&2; \
	    echo "       Run: python3 -m pip install --user pyyaml" >&2; exit 1; }; \
	  ey() { python3 deployments/_lib/env_yaml.py --file "$$env_file" --path "$$1"; }; \
	  case "$$nc" in \
	    aks) \
	      endpoint="$$(ey endpoint)"; \
	      repo="$$(ey containerRegistry.loginServer)" ;; \
	    eks) \
	      endpoint="$$(ey application.endpoint)"; \
	      repo="$$(ey containerRegistry.loginServer)" ;; \
	    gke) \
	      endpoint="$$(ey application.endpoint)"; \
	      gar_loc="$$(ey containerRegistry.location)"; \
	      [ -n "$$gar_loc" ] || gar_loc="$$(ey location)"; \
	      gar_proj="$$(ey projectId)"; \
	      gar_repo="$$(ey containerRegistry.repositoryId)"; \
	      if [ -n "$$gar_loc" ] && [ -n "$$gar_proj" ] && [ -n "$$gar_repo" ]; then \
	        repo="$${gar_loc}-docker.pkg.dev/$${gar_proj}/$${gar_repo}"; \
	      else repo=""; fi ;; \
	  esac; \
	  [ -n "$$endpoint" ] || { echo "ERROR: endpoint missing in $$env_file (aks: endpoint; aws/gcp: application.endpoint)" >&2; exit 1; }; \
	  [ -n "$$repo" ] || { echo "ERROR: container registry not resolvable from $$env_file (azure/aws: containerRegistry.loginServer; gcp: projectId+containerRegistry.repositoryId+location or containerRegistry.location)" >&2; exit 1; }; \
	  if [ -n "$(strip $(ENDPOINT))" ]; then endpoint="$(ENDPOINT)"; fi; \
	  if [ -n "$(strip $(CONTAINER_IMAGE_REPO))" ]; then repo="$(CONTAINER_IMAGE_REPO)"; fi; \
	  if [ -z "$(IMAGE_TAG)" ]; then \
	    echo "ERROR: IMAGE_TAG is required for CLOUD=$(CLOUD) (supplied by CI after the image build)." >&2; exit 1; \
	  fi; \
	  kc_host="$(KEYCLOAK_HOSTNAME)"; \
	  [ -n "$$kc_host" ] || kc_host="https://auth.$${endpoint}$(gateway_port_suffix)"; \
	  echo "[deploy] env-file mode: $$env_file -> ENDPOINT=$$endpoint CONTAINER_IMAGE_REPO=$$repo (CLOUD=$(CLOUD) -> $$nc -> $$target)"; \
	  $(MAKE) $$target \
	    ENDPOINT="$$endpoint" \
	    CONTAINER_IMAGE_REPO="$$repo" \
	    KEYCLOAK_HOSTNAME="$$kc_host" \
	    IMAGE_TAG="$(IMAGE_TAG)" \
	    DEPLOY_ENV_FILE="$$env_file" \
	    ENV="$(ENV)" \
	    $(if $(OBSERVABILITY),OBSERVABILITY="$(OBSERVABILITY)",); \
	else \
	  echo "[deploy] flag mode: CLOUD=$(CLOUD) -> $$nc -> $$target (ENV unset; using flags/defaults)"; \
	  $(MAKE) $$target; \
	fi
