# mk/cloud/gke.mk -- per-tier wrappers + orchestrator + GKE-specific
# helpers (GCNV-native NAS/SAN Trident storage, Cloud DNS / ExternalDNS, GCNV
# preflight, etc.).
#
# Collects everything that only runs against a GKE cluster. Tier
# wrappers each delegate to helm_upgrade_tier (mk/tier-helm.mk);
# deploy-gke handles KEYCLOAK_HOSTNAME derivation from ENDPOINT
# before invoking deploy-all-tiers-gke. Also holds the legacy
# script-driven helpers (deploy-gke-auto / gke-preflight /
# gke-storage / gke-dns / gke-verify) so all GKE-specific make
# targets live under one path.

# ─── Per-tier install / upgrade targets ──────────────────────────────────────
# GKE runs the tiers WITHOUT Workload Identity (chart-rendered secrets + node
# service account, like the -local variants) but with real cluster storage:
# GCNV-native NAS (RWX) for shared s3gateway/services PVCs and GCNV-native SAN
# (RWO) for DB workloads (via each tier's values-gke.yaml / values-gke overlay).
# GKE_TIER_SET / GKE_<TIER>_EXTRA live in mk/tier-helm.mk; see the macro doc
# header there for why GKE sets BOTH global.endpoint AND top-level endpoint.

# The former helm-<tier>-upgrade-gke wrappers are now the generic
# helm-<tier>-upgrade targets (mk/cloud/deploy-orchestrator.mk), invoked with
# CLOUD=gke. deploy-all-tiers-gke below calls them that way.

# Smoke-test all GKE tier charts offline (no cluster contact). Pulls in the
# tier's values-gke.yaml when present so GCNV overlay mappings are exercised.
helm-tier-template-gke: ## Smoke-test all tier charts with GKE overlays via helm template (no cluster contact)
	@echo "Smoke-testing tier charts (GKE overlay)..."
	@# helm_template_all_tiers runs a (sentinel-aware) `helm dependency update`
	@# per tier inline, so no pre-walk is needed here. Tiers that vendor their
	@# charts (platform: redis/lakekeeper) carry .helm-skip-dep-update and are
	@# skipped, avoiding the rate-limited charts.bitnami.com / Docker Hub pull.
	$(call helm_template_all_tiers,gke,$(GKE_TIER_SET))
	@echo "All GKE tier charts rendered successfully."

# ─── GKE orchestrator ────────────────────────────────────────────────────────

deploy-gke: ## Deploy on GKE (tiered multi-namespace layout): derives auth hostname then runs deploy-all-tiers-gke (GCNV NAS RWX for s3gateway+services bucket, GCNV SAN RWO for DB, no Workload Identity). Optional OBSERVABILITY=1 for monitoring (default off).
	@# Derives KEYCLOAK_HOSTNAME from ENDPOINT and hands it to deploy-all-tiers-gke.
	@# The identity tier needs a real hostname because helm-identity-install-gke runs
	@# productionMode=true, and without it the Keycloak 26 boot guard crashes the pod:
	@#   "hostname-backchannel-dynamic must be set to false when no hostname is provided".
	@#
	@# Hostname resolution:
	@#   1. KEYCLOAK_HOSTNAME explicitly set -> use as-is
	@#   2. ENDPOINT set                     -> derive https://auth.$(ENDPOINT)$(gateway_port_suffix)
	@#                                          (no :port suffix when GATEWAY_HTTPS_PORT=443; ":8443"
	@#                                          when GATEWAY_HTTPS_PORT=8443, etc.)
	@#   3. neither                          -> fail
	@#
	@# Defensive whitespace strip: ENDPOINT ?= agentstudio.local  # ... on same line means
	@# Make does NOT trim trailing whitespace, producing malformed URLs like
	@# "https://auth.agentstudio.local  " without the strip.
	@kc_hostname="$$(printf '%s' '$(KEYCLOAK_HOSTNAME)' | tr -d '[:space:]')"; \
	endpoint="$$(printf '%s' '$(ENDPOINT)' | tr -d '[:space:]')"; \
	if [ -z "$$kc_hostname" ] && [ -n "$$endpoint" ]; then \
		kc_hostname="https://auth.$${endpoint}$(gateway_port_suffix)"; \
		echo "Derived KEYCLOAK_HOSTNAME=$$kc_hostname from ENDPOINT=$$endpoint"; \
		if [ "$$endpoint" = "agentstudio.local" ]; then \
			echo ""; \
			echo "WARNING: ENDPOINT defaulted to agentstudio.local. That hostname does"; \
			echo "         not resolve outside a developer laptop with /etc/hosts edits"; \
			echo "         and almost certainly does not match a SAN on your GKE"; \
			echo "         gateway TLS cert. Set ENDPOINT=<your-real-domain> for any"; \
			echo "         non-laptop GKE cluster."; \
			echo ""; \
		fi; \
	fi; \
	if [ -z "$$kc_hostname" ]; then \
		echo ""; \
		echo "ERROR: deploy-gke needs either ENDPOINT (auto-derives the auth hostname)"; \
		echo "       or KEYCLOAK_HOSTNAME (explicit) -- neither is set."; \
		echo ""; \
		echo "       Recommended:"; \
		echo "         make deploy-gke \\"; \
		echo "           ENDPOINT=<your-endpoint> \\"; \
		echo "           CONTAINER_IMAGE_REPO=<repo> IMAGE_TAG=<tag>"; \
		echo "         (KEYCLOAK_HOSTNAME auto-derived to https://auth.<endpoint>$(gateway_port_suffix))"; \
		echo ""; \
		echo "       Explicit override (when the auth hostname does NOT follow the"; \
		echo "       auth.<endpoint> convention):"; \
		echo "         make deploy-gke \\"; \
		echo "           ENDPOINT=<your-endpoint> \\"; \
		echo "           CONTAINER_IMAGE_REPO=<repo> IMAGE_TAG=<tag> \\"; \
		echo "           KEYCLOAK_HOSTNAME=https://<custom-host>[:<port>]"; \
		echo ""; \
		echo "       The value MUST match the FQDN your gateway exposes for the auth"; \
		echo "       subdomain AND be covered by a SAN on the gateway wildcard cert."; \
		exit 1; \
	fi; \
	$(MAKE) deploy-all-tiers-gke \
		KEYCLOAK_HOSTNAME="$$kc_hostname"

# deploy-all-tiers-gke is now a thin alias to the generic orchestrator; the
# GKE-specific foundation (GCNV NAS/SAN storage + gateway-api + gateway TLS +
# DB(values-gke) + SAN placement reconcile + identity + observability) lives in
# gke-deploy-foundation. gke-deploy-postgate holds the post-deploy Phoenix gate.
deploy-all-tiers-gke: ## Deploy all GKE tiers (alias for `deploy-all-tiers CLOUD=gke`). Requires KEYCLOAK_HOSTNAME (deploy-gke derives it). OBSERVABILITY=1 for monitoring.
	$(MAKE) deploy-all-tiers CLOUD=gke

gke-deploy-foundation: ## (internal) GKE pre-workers prep: GCNV NAS/SAN storage + gateway-api + gateway TLS + DB + identity + observability
	@# GCNV-native dual storage: NAS (RWX) + SAN (RWO) backends/classes, then gate
	@# SAN node iSCSI readiness before the DB tier mounts its RWO LUN.
	$(MAKE) gke-ensure-storage-ready
	$(MAKE) gke-ensure-san-hosts
	@# NGF only on explicit nginx rollback (GATEWAY_PROVIDER=nginx). Istio path
	@# installs Gateway API CRDs via deploy-all-tiers istio-prereq.
	@if [ "$(GATEWAY_PROVIDER)" = "nginx" ]; then \
		$(MAKE) install-gateway-api SKIP_NGF_INSTALL=0; \
	fi
	@echo "Preparing Gateway API TLS secret (nemo-gateway-tls) in $(HELM_NS_EDGE)..."
	@ENDPOINT="$(strip $(ENDPOINT))" NAMESPACE=$(HELM_NS_EDGE) CERT_MANAGER_GATEWAY_TLS="$(CERT_MANAGER_GATEWAY_TLS)" $(SCRIPTS_DIR)/prepare-nemo-gateway.sh || true
	$(MAKE) helm-database-upgrade HELM_EXTRA_ARGS="-f deployments/helm/database/values-gke.yaml"
	$(MAKE) gke-reconcile-db-placement
	$(MAKE) helm-wait-database
	$(MAKE) ensure-shared-postgresql-secret
	@echo "Ensuring shared PostgreSQL databases exist (idempotent; initdb runs only on empty PVC)..."
	@DATABASE_NAMESPACE=$(DATABASE_NAMESPACE) POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-agentstudio-postgres-password} \
	  scripts/ensure-shared-databases.sh
	@# DB password single source of truth: copy the DB tier's shared-postgresql-secret
	@# into the identity namespace so Keycloak consumes it via postgres.auth.existingSecret.
	@# GKE has no Key Vault; the Entra broker secret is the externally-managed
	@# keycloak-entra-broker Secret (helm-identity-install-gke verifies it).
	$(MAKE) keycloak-db-secret-sync KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Bootstrap admin single source of truth: create keycloak-bootstrap-admin
	@# create-if-absent (fresh cluster -> random password that seeds Keycloak's
	@# first-boot admin; existing cluster -> left untouched so it keeps matching
	@# the admin already stored in the long-lived DB). values-gke.yaml points
	@# keycloak.bootstrapAdmin.existingSecret at it, so the chart never re-renders
	@# (and thus never drifts) the admin credential.
	$(MAKE) keycloak-admin-secret KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-identity-install-gke KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-wait-keycloak KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Observability runs AFTER identity so keycloak-oidc-secrets (synced into
	@# monitoring) already has the KC-generated grafana-proxy-client-secret.
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "=== Phase 0: Observability (GKE) ===" && $(MAKE) helm-observability-upgrade-gke \
	    || { echo "FAILED at Phase 0 (Observability). Re-run: make deploy CLOUD=gcp ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	  echo "=== Phase 0: Ensuring Phoenix PostgreSQL schema (restart if empty DB) ==="; \
	  $(MAKE) ensure-phoenix-postgres-ready \
	    || { echo "FAILED: Phoenix PostgreSQL schema not initialized. Re-run make deploy CLOUD=gcp ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	fi

gke-deploy-postgate: ## (internal) GKE end-of-deploy Phoenix schema gate (OBSERVABILITY=1)
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "=== Post-deploy gate: Phoenix PostgreSQL schema ==="; \
	  $(MAKE) ensure-phoenix-postgres-ready \
	    || { echo "FAILED post-deploy Phoenix schema gate. Re-run make deploy CLOUD=gcp ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	fi

# ─── GKE GCNV-native dual storage gate ───────────────────────────────────────
# Idempotent bootstrap + readiness gate:
# - NAS backend/class for RWX shared volumes
# - SAN backend/class for DB RWO volumes
#
# Required vars (legacy flag mode):
#   GCNV_LOCATION
#   GCNV_NETWORK=name=<vpc>
#   TRIDENT_GSA_EMAIL=<gsa email>
# Env-file deploy (make deploy CLOUD=gcp ENV=<env>): DEPLOY_ENV_FILE auto-loads
# these from deployments/gcp/envs/<env>.yaml via deployments/_lib/gcp_storage_env.py.
# Optional SAN pool placement vars (defaults):
#   GCNV_SAN_ZONE=<GCNV_LOCATION>-b
#   GCNV_SAN_REPLICA_ZONE=<GCNV_LOCATION>-c
gke-ensure-storage-ready: ## Ensure dual GCNV-native NAS/SAN pools, backends, and classes are ready on current GKE cluster.
	@if [ -n "$(DEPLOY_ENV_FILE)" ] && [ -f "$(DEPLOY_ENV_FILE)" ]; then \
	  echo "[gke-storage] loading GCNV env from $(DEPLOY_ENV_FILE)"; \
	  eval "$$(python3 deployments/_lib/gcp_storage_env.py --file "$(DEPLOY_ENV_FILE)")"; \
	fi; \
	scripts/gke-provision-gcnv-native.sh

# ─── GKE SAN host iSCSI readiness gate ───────────────────────────────────────
# The DB RWO volume is served by GCNV SAN (iSCSI). SAN (Ubuntu) nodes must have
# open-iscsi/multipath-tools installed AND the Trident node pod must have read the
# host initiator name so it registers a non-empty IQN with GCNV. If Trident
# registered before the tools were installed, the IQN is empty, the LUN is masked,
# and mounts fail with "no devices present yet". This target installs the host
# tooling (idempotent DaemonSet) and, only when an IQN is missing, restarts the
# Trident node pods, then gates until every SAN node reports an IQN. Runs after
# gke-ensure-storage-ready (Trident installed) and before the DB tier deploys.
gke-ensure-san-hosts: ## Install iSCSI tooling on SAN nodes and gate until every SAN node registers a Trident IQN.
	@scripts/gke-ensure-san-hosts.sh

# ─── GKE SAN database placement reconcile ────────────────────────────────────
# The shared-postgresql StatefulSet pins to the SAN (Ubuntu) node pool via
# database/values-gke.yaml (nodeSelector + toleration on agentstudio.netapp.io/san).
# Those nodes carry the open-iscsi tooling Trident SAN mounts require; the
# default COS pool does not. Patching the StatefulSet template does NOT evict a
# pod that is already wedged on a non-SAN node (e.g. stuck ContainerCreating with
# "open-iscsi tools not found on host"), so a plain re-deploy can't self-heal on
# its own. This target force-recreates shared-postgresql-0 ONLY when it is
# scheduled off the SAN pool, letting the StatefulSet reschedule it correctly.
# Idempotent: a pod already on a SAN node (or not yet scheduled) is left alone.
gke-reconcile-db-placement: ## Force-recreate shared-postgresql-0 if mis-scheduled off the SAN node pool.
	@set -e; \
	pod=shared-postgresql-0; \
	node="$$(kubectl -n $(DATABASE_NAMESPACE) get pod $$pod -o jsonpath='{.spec.nodeName}' 2>/dev/null || true)"; \
	if [ -z "$$node" ]; then \
	  echo "  $$pod not scheduled yet; nothing to reconcile."; \
	elif kubectl get nodes -l agentstudio.netapp.io/san=true -o name 2>/dev/null | grep -qx "node/$$node"; then \
	  echo "  $$pod is on SAN node $$node; no action."; \
	else \
	  echo "  $$pod is on non-SAN node $$node; deleting so the StatefulSet reschedules it onto the SAN pool..."; \
	  kubectl -n $(DATABASE_NAMESPACE) delete pod $$pod --wait=false 2>/dev/null || true; \
	fi

# ─── GKE auto-deploy (legacy script-driven flow) ─────────────────────────────
# These targets pre-date deploy-gke / deploy-all-tiers-gke and run a separate
# config-file-driven flow via scripts/deploy-cloud-auto.sh + scripts/gke-*.sh.
# Kept for back-compat with external runbooks; modern operators should use
# `make deploy-gke ENDPOINT=...` instead.

CLOUD_PROVIDER ?= gcp
STATE_FILE ?= .deploy-state/cloud-auto.env
RESUME_FROM ?=

deploy-cloud-auto: ## (legacy) Cloud-agnostic deploy facade (dispatches to provider target). Prefer `make deploy CLOUD=<cloud>` (mk/dispatch.mk).
	@set -e; \
	case "$(CLOUD_PROVIDER)" in \
		gcp) $(MAKE) deploy-gke-auto ;; \
		aws) echo "ERROR: CLOUD_PROVIDER=aws not implemented yet."; exit 1 ;; \
		azure) echo "ERROR: CLOUD_PROVIDER=azure not implemented yet."; exit 1 ;; \
		*) echo "ERROR: Unknown CLOUD_PROVIDER=$(CLOUD_PROVIDER). Use gcp|aws|azure."; exit 1 ;; \
	esac

deploy-gke-auto: ## (legacy) End-to-end GKE deploy (preflight -> storage -> dns -> app -> verify) via scripts/deploy-cloud-auto.sh
	@scripts/deploy-cloud-auto.sh

gke-preflight: ## Run GKE preflight checks
	@scripts/gke-preflight.sh

gke-storage: ## Provision/verify GCNV-native NAS/SAN Trident backends/storage classes
	@scripts/gke-provision-gcnv-native.sh

gke-dns: ## Deploy/verify ExternalDNS for Cloud DNS
	@scripts/gke-deploy-externaldns.sh

gke-verify: ## Run post-deploy validations
	@scripts/gke-postcheck.sh

