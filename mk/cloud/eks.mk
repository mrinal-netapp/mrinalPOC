# mk/cloud/eks.mk -- per-tier wrappers + orchestrator + EKS-specific
# helpers (FSx Trident RWX, internet-facing NLB gateway, AWS Load Balancer
# Controller, IAM-OIDC integration).
#
# Collects everything that only runs against an AWS EKS cluster. Tier
# wrappers each delegate to helm_upgrade_tier (mk/tier-helm.mk);
# deploy-eks handles KEYCLOAK_HOSTNAME derivation from ENDPOINT
# before invoking deploy-all-tiers-eks.
#
# EKS_TIER_SET / EKS_<TIER>_EXTRA live in mk/tier-helm.mk; see the macro
# doc header there for why EKS sets BOTH global.endpoint AND top-level
# endpoint (mirrors GKE's reasoning).

# ─── Per-tier install / upgrade targets ──────────────────────────────────────
# EKS runs the tiers WITHOUT IRSA (chart-rendered secrets + node IAM, like
# the -local / -gke variants) but with real cluster storage: FSx Trident
# (RWX) for the s3gateway + services default-bucket PVCs (via each tier's
# values-eks.yaml), default EBS CSI (RWO) for everything else.

# The former helm-<tier>-upgrade-eks wrappers are now the generic
# helm-<tier>-upgrade targets (mk/cloud/deploy-orchestrator.mk), invoked with
# CLOUD=eks. deploy-all-tiers-eks below calls them that way.

# Smoke-test all EKS tier charts offline (no cluster contact). Pulls in the
# tier's values-eks.yaml when present so the FSx overlays are exercised.
# helm_template_all_tiers (mk/tier-helm.mk) handles `helm dependency update`
# per tier inline -- no need to pre-walk the chart list here.
helm-tier-template-eks: ## Smoke-test all tier charts with EKS overlays via helm template (no cluster contact)
	@echo "Smoke-testing tier charts (EKS overlay)..."
	@# helm_template_all_tiers runs a (sentinel-aware) `helm dependency update`
	@# per tier inline, so no pre-walk is needed here. Tiers that vendor their
	@# charts (platform: redis/lakekeeper) carry .helm-skip-dep-update and are
	@# skipped, avoiding the rate-limited charts.bitnami.com / Docker Hub pull.
	$(call helm_template_all_tiers,eks,$(EKS_TIER_SET))
	@echo "All EKS tier charts rendered successfully."

# ─── EKS orchestrator ────────────────────────────────────────────────────────

deploy-eks: ## Deploy on AWS EKS (alias: derives KEYCLOAK_HOSTNAME then `deploy-all-tiers CLOUD=eks`). Requires ENDPOINT, CONTAINER_IMAGE_REPO, IMAGE_TAG.
	@# Thin entry point: derives KEYCLOAK_HOSTNAME from ENDPOINT (:port suffix
	@# empty on cloud 443, ":8443" on local) then hands off to the generic
	@# orchestrator. Prefer `make deploy CLOUD=aws ENV=<env>` (env-file driven).
	@kc_hostname="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | tr -d '[:space:]')"; \
	endpoint="$$(printf '%s' '$(ENDPOINT)' | tr -d '[:space:]')"; \
	if [ -z "$$kc_hostname" ] && [ -n "$$endpoint" ]; then \
		kc_hostname="https://auth.$${endpoint}$(gateway_port_suffix)"; \
		echo "Derived KEYCLOAK_HOSTNAME=$$kc_hostname from ENDPOINT=$$endpoint"; \
	fi; \
	if [ -z "$$kc_hostname" ]; then \
		echo "ERROR: deploy-eks needs ENDPOINT or KEYCLOAK_HOSTNAME."; \
		echo "  make deploy-eks ENDPOINT=<endpoint> CONTAINER_IMAGE_REPO=<repo> IMAGE_TAG=<tag>"; \
		exit 1; \
	fi; \
	$(MAKE) deploy-all-tiers CLOUD=eks \
		KEYCLOAK_HOSTNAME="$$kc_hostname" \
		HELM_EXTRA_ARGS="$(HELM_EXTRA_ARGS)"

ALLOW_PENDING_RELEASE_UNINSTALL ?= false

# deploy-all-tiers-eks is now a thin alias to the generic orchestrator; the
# EKS-specific foundation (FSx overlay + gateway TLS + DB + identity + obs) is
# eks-bootstrap-fresh, wrapped here as eks-deploy-foundation. eks-deploy-postgate
# is the shared no-op (mk/cloud/deploy-orchestrator.mk).
deploy-all-tiers-eks: ## Deploy all EKS tiers (alias for `deploy-all-tiers CLOUD=eks`). OBSERVABILITY=1 for monitoring.
	$(MAKE) deploy-all-tiers CLOUD=eks

EKS_INSTALL_LBC_SCRIPT := $(AWS_SCRIPTS_DIR)/eks-install-lbc.sh

eks-ensure-load-balancer-controller: ## Install/upgrade AWS LBC from CFN outputs (DEPLOY_ENV_FILE required). SKIP_EKS_LBC_INSTALL=1 to skip.
	@test -f "$(EKS_INSTALL_LBC_SCRIPT)" || { \
	  echo "ERROR: missing $(EKS_INSTALL_LBC_SCRIPT) — git pull origin $$(git branch --show-current) on this checkout." >&2; \
	  exit 127; \
	}
	@DEPLOY_ENV_FILE="$(DEPLOY_ENV_FILE)" bash "$(EKS_INSTALL_LBC_SCRIPT)"

eks-deploy-foundation: ## (internal) EKS pre-workers prep (LBC + gateway TLS + FSx DB overlay + identity + observability)
	@# AWS Load Balancer Controller: required for Istio Gateway NLB + static EIPs.
	@# Stack-managed envs (DEPLOY_ENV_FILE set) install from CFN LoadBalancerControllerRoleArn.
	@test -f "$(EKS_INSTALL_LBC_SCRIPT)" || { \
	  echo "ERROR: missing $(EKS_INSTALL_LBC_SCRIPT) — git pull origin $$(git branch --show-current) on this checkout." >&2; \
	  exit 127; \
	}
	@DEPLOY_ENV_FILE="$(DEPLOY_ENV_FILE)" bash "$(EKS_INSTALL_LBC_SCRIPT)"
	$(MAKE) eks-bootstrap-fresh

# Database-tier overlay: FSx Trident StorageClass for the shared-postgresql
# StatefulSet. Tier chart overlays (workers/platform/services/llm-gateway/
# console) are applied inline on each helm-*-upgrade-eks target via
# -f .../values-eks.yaml; the database chart is generic, so we pass the
# overlay through HELM_EXTRA_ARGS during eks-bootstrap-fresh.
EKS_OVERLAY ?= -f $(HELM_ROOT)/database/values-eks.yaml

eks-bootstrap-fresh: ## Fresh-cluster bootstrap for AWS EKS tier deploy (gateway TLS, DB, identity)
	$(MAKE) helm-tier-namespaces
	@# NGF only on explicit nginx rollback (GATEWAY_PROVIDER=nginx). Istio path
	@# installs Gateway API CRDs via deploy-all-tiers istio-prereq.
	@if [ "$(GATEWAY_PROVIDER)" = "nginx" ]; then \
		$(MAKE) install-gateway-api SKIP_NGF_INSTALL=0; \
	fi
	@echo "Preparing Gateway API TLS secret for AWS edge namespace..."
	@ENDPOINT="$(strip $(ENDPOINT))" NAMESPACE=$(HELM_NS_EDGE) CERT_MANAGER_GATEWAY_TLS="$(CERT_MANAGER_GATEWAY_TLS)" FORCE_LEGACY_TLS_PREP=1 $(SCRIPTS_DIR)/prepare-nemo-gateway.sh
	@kubectl get secret -n $(HELM_NS_EDGE) nemo-gateway-tls >/dev/null 2>&1 || { \
	  echo "ERROR: required TLS secret 'nemo-gateway-tls' is missing in namespace $(HELM_NS_EDGE)."; \
	  echo "Fix TLS generation first, then re-run deploy-eks."; \
	  exit 1; \
	}
	$(MAKE) helm-database-upgrade HELM_EXTRA_ARGS="$(EKS_OVERLAY)"
	$(MAKE) helm-wait-database
	$(MAKE) ensure-shared-postgresql-secret
	@echo "Ensuring shared PostgreSQL databases exist (idempotent)..."
	@DATABASE_NAMESPACE=$(DATABASE_NAMESPACE) POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-agentstudio-postgres-password} \
	  scripts/ensure-shared-databases.sh
	@# DB password single source of truth: copy the DB tier's shared-postgresql-secret
	@# into the identity namespace so Keycloak consumes it via postgres.auth.existingSecret.
	$(MAKE) keycloak-db-secret-sync KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Bootstrap admin single source of truth: create keycloak-bootstrap-admin
	@# create-if-absent (fresh cluster -> random password that seeds Keycloak's
	@# first-boot admin; existing cluster -> left untouched so it keeps matching
	@# the admin already stored in the long-lived DB). values-eks.yaml points
	@# keycloak.bootstrapAdmin.existingSecret at it, so the chart never re-renders
	@# (and thus never drifts) the admin credential.
	$(MAKE) keycloak-admin-secret KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-identity-install-eks KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-wait-keycloak KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Observability runs AFTER identity so keycloak-oidc-secrets (synced into monitoring by
	@# helm-observability-upgrade-eks) already has grafana-proxy-client-secret patched in
	@# by post-realm-bootstrap.
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "=== Phase 0: Observability (EKS) ===" && $(MAKE) helm-observability-upgrade-eks \
	    || { echo "FAILED at Phase 0 (Observability). Fix the issue and re-run: make deploy-eks OBSERVABILITY=1"; exit 1; }; \
	  echo "=== Phase 0: Ensuring Phoenix PostgreSQL schema (restart if empty DB) ==="; \
	  $(MAKE) ensure-phoenix-postgres-ready \
	    || { echo "FAILED: Phoenix PostgreSQL schema not initialized. Fix Phoenix/Postgres and re-run deploy-eks OBSERVABILITY=1"; exit 1; }; \
	fi

# Render-time validation that all five EKS tier charts + identity overlay
# parse cleanly with FSx defaults. Useful in CI before any cluster contact.
eks-test-deploy: ## Validate AWS EKS deploy: helm template all EKS overlays (no cluster)
	@bash scripts/test/aws-eks-deploy-test.sh
