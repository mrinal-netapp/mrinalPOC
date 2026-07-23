# mk/cloud/aks.mk -- per-tier wrappers + orchestrator + AKS-specific
# helpers (CSI driver, ANF NFS shared default-bucket).
#
# Collects everything that only runs against an AKS cluster. Tier
# wrappers each delegate to helm_upgrade_tier (mk/tier-helm.mk);
# orchestrator + provisioning live here because they hard-code AKS
# specifics (Workload Identity flow, ANF NFS via Trident,
# aks-ss-csi-driver-upgrade, etc.).

# ─── Per-tier install / upgrade targets ──────────────────────────────────────

# The former helm-<tier>-upgrade-aks wrappers are now the generic
# helm-<tier>-upgrade targets (mk/cloud/deploy-orchestrator.mk), invoked with
# CLOUD=aks. deploy-all-tiers-aks below calls them that way.
#
# Lakekeeper OIDC note (AKS_PLATFORM_EXTRA lives in mk/tier-helm.mk): the
# browser-facing OIDC URLs are repointed to the real endpoint via --set-string
# on positional catalog.extraEnv indices [5]/[10]/[12]; if that list in
# deployments/helm/platform/values.yaml is reordered, update those indices AND
# the post-deploy guard in .github/workflows/deploy-reusable.yml.

# Render-time smoke test for all AKS tier charts.
# Catches Go-template / missing-value errors BEFORE any cluster mutation.
# helm_template_all_tiers (mk/tier-helm.mk) handles `helm dependency update`
# per tier inline -- no need to pre-walk the chart list here.
helm-tier-template-aks: ## Smoke-test all AKS tier charts via helm template (no cluster contact)
	@echo "Smoke-testing tier charts..."
	@# helm_template_all_tiers runs a (sentinel-aware) `helm dependency update`
	@# per tier inline, so no pre-walk is needed here. Tiers that vendor their
	@# charts (platform: redis/lakekeeper) carry .helm-skip-dep-update and are
	@# skipped, avoiding the rate-limited charts.bitnami.com / Docker Hub pull.
	$(call helm_template_all_tiers,aks,$(AKS_TIER_SET))
	@echo "All tier charts rendered successfully."

# ─── AKS orchestrator ────────────────────────────────────────────────────────
# deploy-all-tiers-aks is now a thin alias to the generic deploy-all-tiers
# (mk/cloud/deploy-orchestrator.mk) with the AKS-specific pre-workers prep in
# aks-deploy-foundation and the post-deploy Phoenix gate in aks-deploy-postgate.
ALLOW_PENDING_RELEASE_UNINSTALL ?= false

deploy-all-tiers-aks: ## Deploy all AKS tiers (alias for `deploy-all-tiers CLOUD=aks`). OBSERVABILITY=1 for monitoring. CERT_MANAGER_GATEWAY_TLS=1 for cert-manager TLS.
	$(MAKE) deploy-all-tiers CLOUD=aks

# AKS foundation: CSI provider, database, identity, observability, gateway TLS,
# and the shared ANF default-bucket discovery. Runs (from deploy-all-tiers) after
# the common preamble (namespaces + istio + rollback) and before the tier tail.
aks-deploy-foundation: ## (internal) AKS pre-workers prep: CSI + DB + identity + observability + gateway TLS + shared-bucket
	$(MAKE) aks-ss-csi-driver-upgrade
	$(MAKE) helm-database-upgrade
	$(MAKE) helm-wait-database
	@echo "Ensuring shared PostgreSQL databases exist (idempotent; initdb runs only on empty PVC)..."
	@DATABASE_NAMESPACE=$(DATABASE_NAMESPACE) POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-agentstudio-postgres-password} \
	  scripts/ensure-shared-databases.sh
	@# Keycloak's DB password is a single source of truth: copy the DB tier's
	@# shared-postgresql-secret into the identity namespace so Keycloak consumes
	@# it via postgres.auth.existingSecret (values-aks.yaml).
	$(MAKE) keycloak-db-secret-sync KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Bootstrap admin single source of truth: create keycloak-bootstrap-admin
	@# create-if-absent (fresh cluster -> random password that seeds Keycloak's
	@# first-boot admin; existing cluster -> left untouched so it keeps matching
	@# the admin already stored in the long-lived DB). values-aks.yaml points
	@# keycloak.bootstrapAdmin.existingSecret at it, so the chart never re-renders
	@# (and thus never drifts) the admin credential.
	$(MAKE) keycloak-admin-secret KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-identity-install-aks KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	$(MAKE) helm-wait-keycloak KEYCLOAK_NAMESPACE=$(HELM_NS_IDENTITY)
	@# Observability runs AFTER identity so keycloak-oidc-secrets (synced into
	@# monitoring) already has the KC-generated grafana-proxy-client-secret.
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "=== Phase 0: Observability (AKS) ===" && $(MAKE) helm-observability-upgrade-aks \
	    || { echo "FAILED at Phase 0 (Observability). Re-run: make deploy CLOUD=aks ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	  echo "=== Phase 0: Ensuring Phoenix PostgreSQL schema (restart if empty DB) ==="; \
	  $(MAKE) ensure-phoenix-postgres-ready \
	    || { echo "FAILED: Phoenix PostgreSQL schema not initialized. Re-run make deploy CLOUD=aks ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	fi
	@# Prepare Gateway TLS secret in the edge namespace (fallback when the NetApp
	@# provisioning-service hasn't already written nemo-gateway-tls; no-op if present).
	@ENDPOINT="$(ENDPOINT)" NAMESPACE=$(HELM_NS_EDGE) CERT_MANAGER_GATEWAY_TLS="$(CERT_MANAGER_GATEWAY_TLS)" $(SCRIPTS_DIR)/prepare-nemo-gateway.sh || true
	@# Discover (or provision) the shared ANF default-bucket PVs so workers and
	@# services bind to the SAME underlying NFS volume. Writes $(SHARED_PVS_ENV),
	@# which the generic tier tail sources for the workers/services PV --set.
	$(MAKE) aks-ensure-shared-default-bucket

# AKS post-deploy gate: re-check the Phoenix PostgreSQL schema after all tiers.
aks-deploy-postgate: ## (internal) AKS end-of-deploy Phoenix schema gate (OBSERVABILITY=1)
	@if [ "$(OBSERVABILITY)" = "1" ]; then \
	  echo "=== Post-deploy gate: Phoenix PostgreSQL schema ==="; \
	  $(MAKE) ensure-phoenix-postgres-ready \
	    || { echo "FAILED post-deploy Phoenix schema gate. Re-run make deploy CLOUD=aks ENV=<env> OBSERVABILITY=1"; exit 1; }; \
	fi

# State file holding discovered PV names for the shared default-bucket. Written
# by aks-ensure-shared-default-bucket; sourced by the generic tier tail.
SHARED_PVS_ENV ?= .aks-shared-pvs.env

# ─── Fresh AKS deploy: provision shared ANF NFS default-bucket volume ─────────
# Use this before deploy-all-tiers-aks on a brand-new cluster.
# Creates one ANF volume via a temporary PVC (Trident dynamic provisioning), then
# creates a sibling Kubernetes PV so both workers and services namespaces can bind
# to the same NFS export — without touching each other's PVC namespaces.
#
# Outputs S3GW_PV_DEFAULT_BUCKET and SERVICES_PV_DEFAULT_BUCKET — pass to deploy-all-tiers-aks.
# Idempotent: re-run safely if interrupted.
#
# Naming: <cloud>-<verb>-<resource> matches the Layer 5 convention in
# docs/deployment/makefile-target-conventions.md and the existing
# gke-ensure-filestore-rwx pattern.
aks-provision-shared-default-bucket: ## Pre-provision shared ANF NFS default-bucket PVs for workers + services (AKS only, call before deploy-all-tiers-aks)
	@CTX=$$(kubectl config current-context 2>/dev/null || true); \
	case "$$CTX" in \
	  kind-*|docker-desktop|minikube|k3d-*|rancher-desktop|orbstack) \
	    echo "ERROR: aks-provision-shared-default-bucket is for AKS clusters only. Current context: $$CTX"; \
	    exit 1 ;; \
	esac
	@echo "════════════════════════════════════════════════════════════════"; \
	echo " PROVISION SHARED ANF NFS DEFAULT-BUCKET"; \
	echo " Workers NS  : $(HELM_NS_WORKERS)   Services NS : $(HELM_NS_SERVICES)"; \
	echo " StorageClass: $(ANF_STORAGE_CLASS)   Size: $(DEFAULT_BUCKET_SIZE)"; \
	echo "════════════════════════════════════════════════════════════════"; \
	\
	kubectl create namespace $(HELM_NS_WORKERS) --dry-run=client -o yaml | kubectl apply -f -; \
	\
	TMP_PVC="nemo-default-bucket-provision-tmp"; \
	\
	echo "--- Step A: provision ANF volume via temporary PVC ---"; \
	EXISTING_TMP=$$(kubectl get pvc "$$TMP_PVC" -n $(HELM_NS_WORKERS) --no-headers 2>/dev/null | awk '{print $$1}'); \
	if [ -z "$$EXISTING_TMP" ]; then \
	  printf '%s\n' \
	    'apiVersion: v1' \
	    'kind: PersistentVolumeClaim' \
	    'metadata:' \
	    "  name: $$TMP_PVC" \
	    '  namespace: $(HELM_NS_WORKERS)' \
	    '  labels:' \
	    '    app.kubernetes.io/managed-by: agentstudio-provision' \
	    'spec:' \
	    '  accessModes: [ReadWriteMany]' \
	    '  storageClassName: $(ANF_STORAGE_CLASS)' \
	    '  resources:' \
	    '    requests:' \
	    '      storage: $(DEFAULT_BUCKET_SIZE)' | kubectl apply -f -; \
	  echo "  Waiting for $$TMP_PVC to bind (Trident provisioning ANF volume) ..."; \
	  kubectl wait pvc "$$TMP_PVC" -n $(HELM_NS_WORKERS) \
	    --for=jsonpath='{.status.phase}'=Bound --timeout=300s; \
	else \
	  echo "  Temp PVC $$TMP_PVC already exists — reusing"; \
	fi; \
	\
	S3GW_PV_DEFAULT_BUCKET=$$(kubectl get pvc "$$TMP_PVC" -n $(HELM_NS_WORKERS) \
	  -o jsonpath='{.spec.volumeName}' 2>/dev/null); \
	if [ -z "$$S3GW_PV_DEFAULT_BUCKET" ]; then \
	  echo "ERROR: could not read volumeName from PVC $$TMP_PVC"; exit 1; \
	fi; \
	echo "  ANF PV: $$S3GW_PV_DEFAULT_BUCKET"; \
	\
	echo "--- Step B: patch reclaimPolicy=Retain and release PV ---"; \
	kubectl patch pv "$$S3GW_PV_DEFAULT_BUCKET" \
	  -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}' 2>/dev/null || true; \
	kubectl delete pvc "$$TMP_PVC" -n $(HELM_NS_WORKERS) 2>/dev/null || true; \
	echo "  Waiting for PV $$S3GW_PV_DEFAULT_BUCKET to reach Released ..."; \
	for i in $$(seq 1 30); do \
	  PHASE=$$(kubectl get pv "$$S3GW_PV_DEFAULT_BUCKET" -o jsonpath='{.status.phase}' 2>/dev/null); \
	  if [ "$$PHASE" = "Released" ] || [ "$$PHASE" = "Available" ]; then break; fi; \
	  sleep 5; \
	done; \
	PHASE=$$(kubectl get pv "$$S3GW_PV_DEFAULT_BUCKET" -o jsonpath='{.status.phase}' 2>/dev/null); \
	if [ "$$PHASE" = "Released" ]; then \
	  kubectl patch pv "$$S3GW_PV_DEFAULT_BUCKET" --type=json \
	    -p='[{"op":"remove","path":"/spec/claimRef"}]'; \
	  echo "  PV $$S3GW_PV_DEFAULT_BUCKET is now Available"; \
	elif [ "$$PHASE" = "Available" ]; then \
	  echo "  PV $$S3GW_PV_DEFAULT_BUCKET already Available"; \
	else \
	  echo "ERROR: PV $$S3GW_PV_DEFAULT_BUCKET stuck in phase $$PHASE"; exit 1; \
	fi; \
	\
	echo "--- Step C: create sibling PV for services namespace (same underlying volume) ---"; \
	SIBLING_PV="$$S3GW_PV_DEFAULT_BUCKET-services"; \
	EXISTING_SIBLING=$$(kubectl get pv "$$SIBLING_PV" --no-headers 2>/dev/null | awk '{print $$1}'); \
	if [ -n "$$EXISTING_SIBLING" ]; then \
	  echo "  Sibling PV $$SIBLING_PV already exists — skipping"; \
	else \
	  SC_OVERRIDE="$(SIBLING_STORAGE_CLASS)"; \
	  kubectl get pv "$$S3GW_PV_DEFAULT_BUCKET" -o json | python3 -c " \
import json, sys, os; \
pv = json.load(sys.stdin); \
meta = pv['metadata']; \
[meta.pop(f, None) for f in ['uid','resourceVersion','creationTimestamp','generation','managedFields','annotations']]; \
pv['spec'].pop('claimRef', None); \
pv.pop('status', None); \
meta['name'] = meta['name'] + '-services'; \
sc = os.environ.get('SIBLING_SC_OVERRIDE', '').strip(); \
pv['spec']['storageClassName'] = sc or pv['spec'].get('storageClassName', ''); \
print(json.dumps(pv)) \
" SIBLING_SC_OVERRIDE="$$SC_OVERRIDE" | kubectl apply -f -; \
	  echo "  Created sibling PV $$SIBLING_PV (same volume path/handle as $$S3GW_PV_DEFAULT_BUCKET)"; \
	fi; \
	SERVICES_PV_DEFAULT_BUCKET="$$SIBLING_PV"; \
	\
	echo ""; \
	echo "════════════════════════════════════════════════════════════════"; \
	echo " Done. Pass these to deploy-all-tiers-aks:"; \
	echo "   S3GW_PV_DEFAULT_BUCKET=$$S3GW_PV_DEFAULT_BUCKET"; \
	echo "   SERVICES_PV_DEFAULT_BUCKET=$$SERVICES_PV_DEFAULT_BUCKET"; \
	echo ""; \
	echo " State file written: $(SHARED_PVS_ENV) (auto-sourced by deploy-all-tiers-aks)"; \
	echo "════════════════════════════════════════════════════════════════"; \
	{ echo "S3GW_PV_DEFAULT_BUCKET=$$S3GW_PV_DEFAULT_BUCKET"; \
	  echo "SERVICES_PV_DEFAULT_BUCKET=$$SERVICES_PV_DEFAULT_BUCKET"; } > $(SHARED_PVS_ENV)

aks-ensure-shared-default-bucket: ## Discover (or provision) shared default-bucket PVs and write $(SHARED_PVS_ENV)
	@CTX=$$(kubectl config current-context 2>/dev/null || true); \
	case "$$CTX" in \
	  kind-*|docker-desktop|minikube|k3d-*|rancher-desktop|orbstack) \
	    echo "  aks-ensure-shared-default-bucket: skipping on local context $$CTX"; \
	    : > $(SHARED_PVS_ENV); exit 0 ;; \
	esac; \
	WPV=$$(kubectl get pvc -n $(HELM_NS_WORKERS) s3gateway-default-bucket -o jsonpath='{.spec.volumeName}' 2>/dev/null || true); \
	SPV=$$(kubectl get pvc -n $(HELM_NS_SERVICES) s3gateway-default-bucket -o jsonpath='{.spec.volumeName}' 2>/dev/null || true); \
	if [ -n "$$WPV" ] && [ -n "$$SPV" ]; then \
	  echo "  Discovered existing shared default-bucket PVs:"; \
	  echo "    workers  PVC -> PV: $$WPV"; \
	  echo "    services PVC -> PV: $$SPV"; \
	  { echo "S3GW_PV_DEFAULT_BUCKET=$$WPV"; \
	    echo "SERVICES_PV_DEFAULT_BUCKET=$$SPV"; } > $(SHARED_PVS_ENV); \
	  echo "  Wrote $(SHARED_PVS_ENV)"; \
	elif [ -n "$$WPV" ] && [ -z "$$SPV" ]; then \
	  SIBLING="$$WPV-services"; \
	  if kubectl get pv "$$SIBLING" >/dev/null 2>&1; then \
	    echo "  workers PVC bound to $$WPV; sibling PV $$SIBLING already exists (services PVC will bind on first install)"; \
	    { echo "S3GW_PV_DEFAULT_BUCKET=$$WPV"; \
	      echo "SERVICES_PV_DEFAULT_BUCKET=$$SIBLING"; } > $(SHARED_PVS_ENV); \
	  else \
	    echo "  workers PVC bound to $$WPV but no sibling PV found -- running aks-provision-shared-default-bucket"; \
	    $(MAKE) aks-provision-shared-default-bucket; \
	  fi; \
	else \
	  echo "  No shared default-bucket PVCs found -- running aks-provision-shared-default-bucket"; \
	  $(MAKE) aks-provision-shared-default-bucket; \
	fi

# ─── Azure Key Vault provider for Secrets Store CSI ──────────────────────────
# Installs/upgrades the csi-secrets-store-provider-azure plugin into
# $(HELM_NS_CSI). The base Secrets Store CSI driver itself is
# cloud-neutral and lives in mk/common.mk as helm-ss-csi-driver-upgrade
# — declared as a prerequisite below so a single `make
# aks-ss-csi-driver-upgrade` brings up the whole bundle in the right
# order (driver first, then provider with --set
# secrets-store-csi-driver.install=false so it doesn't try to reinstall
# the bundled subchart). Automatically invoked by deploy-all-tiers-aks
# as the first step of every AKS deploy; idempotent — safe to re-run
# after version bumps.
#
# Usage:
#   make aks-ss-csi-driver-upgrade
#   make aks-ss-csi-driver-upgrade CSI_PROVIDER_VERSION=1.8.0
aks-ss-csi-driver-upgrade: helm-ss-csi-driver-upgrade ## Install/upgrade Azure Key Vault provider for Secrets Store CSI (also installs the base driver)
	helm repo add csi-secrets-store-provider-azure \
		https://azure.github.io/secrets-store-csi-driver-provider-azure/charts --force-update
	helm repo update
	helm upgrade --install $(HELM_RELEASE_CSI_PROVIDER) \
		csi-secrets-store-provider-azure/csi-secrets-store-provider-azure \
		--namespace $(HELM_NS_CSI) \
		--create-namespace \
		--version $(CSI_PROVIDER_VERSION) \
		--values "$(HELM_ROOT)/secrets-store-csi/values-provider-azure.yaml" \
		--set secrets-store-csi-driver.install=false \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		$(HELM_WAIT_FLAG)

# Note: migrate-aks-monolith-to-tiers (one-shot tool for migrating off the
# pre-PR-#64 nemo/nemo-deps monolith) was removed once all clusters had
# completed migration. If you need to recover a pre-PR-#64 AKS cluster,
# check out the target from git history at PR #64's parent commit.


