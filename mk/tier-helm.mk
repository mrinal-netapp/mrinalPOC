# mk/tier-helm.mk -- canned recipe for the per-tier Helm upgrades.
#
# Collapses the 15 helm-<tier>-upgrade-<cloud> recipe bodies (5 tiers
# x 3 clouds) into one parameterised helm_upgrade_tier macro. Each
# per-tier-per-cloud wrapper (mk/cloud/<cloud>.mk) is now a 3-line
# stub that supplies
#   1. cloud-specific image/endpoint --set string  (*_TIER_SET)
#   2. tier+cloud-specific helm overrides           (*_<TIER>_EXTRA)
# and delegates to this macro.
#
# Adding a new cloud (e.g. EKS) means defining EKS_TIER_SET +
# EKS_<TIER>_EXTRA blocks here and wiring per-tier wrappers in
# mk/cloud/eks.mk -- no edits to the macro itself.
#
# Adding a new tier means defining <CLOUD>_<NEWTIER>_EXTRA (often
# empty) and creating one wrapper per supported cloud.

# ── Cloud-specific Helm --set strings ─────────────────────────────────────
# Each cloud emits the per-tier image repo + tag overrides that
# every chart needs. AKS adds FORCE_PULL; GKE/EKS/local add the endpoint
# overrides because their tier values.yaml hardcodes
# `agentstudio.local` and the chart is not re-templated at deploy.
# Kept as recursively-expanded variables (=) so changes to
# CONTAINER_IMAGE_REPO / IMAGE_TAG / FORCE_PULL / ENDPOINT in the
# calling environment flow through to the emitted Helm command lines.
#
# All four TIER_SETs pass `--set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT)`
# so URL-emitting helpers (nemo.gatewayHttpsPort + gui.workspacePublicPort)
# see one consistent value: 443 cloud / 8443 local. --set-string is required
# because chart values store the key as a string.
#
# Local previously only set imageRepository — a regression that silently
# ignored `make deploy CLOUD=local IMAGE_TAG=…` / `FORCE_PULL=1` /
# `ENDPOINT=…`. Aligned with AKS/GKE/EKS below so the same flag set
# applies uniformly. See docs/deployment/env-propagation-matrix.md.
LOCAL_TIER_SET = --set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
	$(if $(IMAGE_TAG),--set global.imageTag=$(IMAGE_TAG),) \
	$(if $(FORCE_PULL),--set global.imagePullPolicy=Always,) \
	--set global.endpoint=$(strip $(ENDPOINT)) \
	--set endpoint=$(strip $(ENDPOINT)) \
	--set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT)

AKS_TIER_SET = --set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
	$(if $(IMAGE_TAG),--set global.imageTag=$(IMAGE_TAG),) \
	$(if $(FORCE_PULL),--set global.imagePullPolicy=Always,) \
	--set global.endpoint=$(strip $(ENDPOINT)) \
	--set endpoint=$(strip $(ENDPOINT)) \
	--set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT)

# $(strip ...) on ENDPOINT defends against trailing whitespace from
# inline-comment defaults (`ENDPOINT ?= agentstudio.local  # ...`).
GKE_TIER_SET = --set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
	$(if $(IMAGE_TAG),--set global.imageTag=$(IMAGE_TAG),) \
	$(if $(FORCE_PULL),--set global.imagePullPolicy=Always,) \
	--set global.endpoint=$(strip $(ENDPOINT)) \
	--set endpoint=$(strip $(ENDPOINT)) \
	--set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT)

# EKS mirrors GKE -- node IAM/IRSA-free, FSx Trident RWX overlays, real
# endpoint baked in. Same global.endpoint / endpoint pair so the chart's
# nemo.endpoint helper resolves consistently regardless of which key the
# template reads.
EKS_TIER_SET = --set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
	$(if $(IMAGE_TAG),--set global.imageTag=$(IMAGE_TAG),) \
	$(if $(FORCE_PULL),--set global.imagePullPolicy=Always,) \
	--set global.endpoint=$(strip $(ENDPOINT)) \
	--set endpoint=$(strip $(ENDPOINT)) \
	--set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT)

# ── Tier+cloud-specific extras ───────────────────────────────────────────
# Empty entries are explicit (rather than implicit-empty) so a future
# reader can see at a glance which (tier, cloud) combos legitimately
# have zero extras and which were accidentally omitted.

# Platform: lakekeeper is a third-party subchart whose values can't be
# rendered through `global.endpoint` — they're consumed verbatim from
# values.yaml/values-local.yaml. When the operator deploys against a
# real public hostname (ENDPOINT != agentstudio.local), the OIDC URL
# env vars baked into deployments/helm/platform/values.yaml must be
# patched at --set time so:
#
#   token.iss (from Keycloak KC_HOSTNAME, public) ∈ lakekeeper's accepted
#     issuer list — otherwise every API call returns 401.
#
# Positional indices into lakekeeper.catalog.extraEnv (KEEP IN SYNC
# with deployments/helm/platform/values.yaml AND the post-deploy guard
# in .github/workflows/deploy-reusable.yml):
#
#   [5]  LAKEKEEPER__UI__LAKEKEEPER_URL          → catalog UI base URL
#   [6]  LAKEKEEPER__OPENID_PROVIDER_URI         → in-cluster Keycloak DNS
#                                                  (do NOT override — needed
#                                                   for the in-cluster
#                                                   discovery fetch, returns
#                                                   internal issuer that
#                                                   token aud-validation
#                                                   doesn't depend on)
#   [10] LAKEKEEPER__UI__OPENID_PROVIDER_URI     → browser-facing auth URL
#   [12] LAKEKEEPER__OPENID_ADDITIONAL_ISSUERS   → extra accepted iss claims
#
# DRY: every cloud target needs the same overrides whenever ENDPOINT is
# set to a non-default value (i.e., not the literal "agentstudio.local"
# kind-dev fallback). Capture that once in PLATFORM_OIDC_EXTRA below and
# splice it into all four PLATFORM_EXTRA blocks. The conditional is
# `$(if X,...,)` rather than always-on so a default `make deploy-local`
# (no ENDPOINT) keeps the chart's static values, matching the legacy
# behaviour and not breaking single-host /etc/hosts setups.
#
# URL port suffix mirroring nemo.gatewayPortSuffix: ":N" when port != 443,
# empty otherwise — so cloud (443) gets bare URLs and local (8443) keeps
# the port. Replaces the previous hardcoded ":8443" in PLATFORM_OIDC_EXTRA.
gateway_port_suffix = $(if $(filter-out 443,$(GATEWAY_HTTPS_PORT)),:$(GATEWAY_HTTPS_PORT))

_ENDPOINT_OVERRIDE = $(strip $(if $(ENDPOINT),$(filter-out agentstudio.local,$(ENDPOINT)),))
PLATFORM_OIDC_EXTRA = $(if $(_ENDPOINT_OVERRIDE),\
	--set-string lakekeeper.catalog.extraEnv[5].value=https://catalog.$(_ENDPOINT_OVERRIDE)$(gateway_port_suffix) \
	--set-string lakekeeper.catalog.extraEnv[10].value=https://auth.$(_ENDPOINT_OVERRIDE)$(gateway_port_suffix)/realms/nemo \
	--set-string lakekeeper.catalog.extraEnv[12].value=https://auth.$(_ENDPOINT_OVERRIDE)$(gateway_port_suffix)/realms/nemo,)

LOCAL_PLATFORM_EXTRA = \
	--set-string lakekeeper.catalog.extraInitContainers[0].image=$(INIT_TOOLS_IMAGE) \
	--set lakekeeper.secretBackend.postgres.encryptionKeySecret=lakekeeper-postgres-encryption \
	$(PLATFORM_OIDC_EXTRA)

AKS_PLATFORM_EXTRA = \
	--set-string lakekeeper.catalog.extraInitContainers[0].image=$(INIT_TOOLS_IMAGE) \
	--set lakekeeper.secretBackend.postgres.encryptionKeySecret=lakekeeper-postgres-encryption \
	$(PLATFORM_OIDC_EXTRA)

GKE_PLATFORM_EXTRA = \
	--set-string lakekeeper.catalog.extraInitContainers[0].image=$(INIT_TOOLS_IMAGE) \
	--set lakekeeper.secretBackend.postgres.encryptionKeySecret=lakekeeper-postgres-encryption \
	$(PLATFORM_OIDC_EXTRA)

# EKS: same lakekeeper OIDC discipline as everyone else, plus the
# init-container image override and encryption-key pin. keycloak.setup.image.tag
# follows IMAGE_TAG so the post-install Job uses the matching service image.
EKS_PLATFORM_EXTRA = \
	--set-string lakekeeper.catalog.extraInitContainers[0].image=$(INIT_TOOLS_IMAGE) \
	$(if $(IMAGE_TAG),--set keycloak.setup.image.tag=$(IMAGE_TAG),) \
	--set lakekeeper.secretBackend.postgres.encryptionKeySecret=lakekeeper-postgres-encryption \
	$(PLATFORM_OIDC_EXTRA)

# Workers: server-side apply + --force-conflicts on every cloud so Helm
# wins field-manager conflicts (e.g. prior `kubectl set` on serviceAccountName).
# AKS also injects shared-bucket PV volumeNames from aks-ensure-shared-default-bucket.
LOCAL_WORKERS_EXTRA = --server-side=true --force-conflicts

AKS_WORKERS_EXTRA = --server-side=true --force-conflicts \
	$(if $(S3GW_PV_DEFAULT_BUCKET),--set s3gateway.defaultBucket.volumeName=$(S3GW_PV_DEFAULT_BUCKET),)

GKE_WORKERS_EXTRA = --server-side=true --force-conflicts

# EKS: keycloak.setup + s3gateway image tags need to follow IMAGE_TAG.
# (The chart's global.imageTag covers the rest of the workers tier; these
# two subcharts read their own tags.) Storage is FSx Trident RWX via
# values-eks.yaml, so no PV-name pinning is needed here.
EKS_WORKERS_EXTRA = --server-side=true --force-conflicts \
	$(if $(IMAGE_TAG),--set keycloak.setup.image.tag=$(IMAGE_TAG),) \
	$(if $(IMAGE_TAG),--set s3gateway.image.tag=$(IMAGE_TAG),)

# Services: server-side merge for Gateway HTTPRoute ownership transfers and
# for reclaiming fields previously patched outside Helm (kubectl-set, etc.).
# AKS also binds the sibling PV for the shared default-bucket.
LOCAL_SERVICES_EXTRA = --server-side=true --force-conflicts

AKS_SERVICES_EXTRA = --server-side=true --force-conflicts \
	$(if $(SERVICES_PV_DEFAULT_BUCKET),--set defaultBucketPvc.volumeName=$(SERVICES_PV_DEFAULT_BUCKET),)

GKE_SERVICES_EXTRA = --server-side=true --force-conflicts

# EKS: chart-side overlay (values-eks.yaml) handles the FSx Trident RWX
# PVC + internet-facing NLB gateway annotations.
EKS_SERVICES_EXTRA = --server-side=true --force-conflicts

# Console: server-side apply + force-conflicts so Helm wins over out-of-band
# edits (e.g. k9s changing agent-studio-ui Deployment image). Same pairing
# as workers/services/edge; no per-cloud --set beyond this.
LOCAL_CONSOLE_EXTRA = --server-side=true --force-conflicts
AKS_CONSOLE_EXTRA   = --server-side=true --force-conflicts
GKE_CONSOLE_EXTRA   = --server-side=true --force-conflicts
EKS_CONSOLE_EXTRA   = --server-side=true --force-conflicts

# Edge: Gateway API CRDs are large schemas; helm-managed re-apply needs
# server-side merge so the apiserver reconciles the CRD-instance without
# a partial-ownership rejection (`Apply failed with ... managedFields`).
# `--force-conflicts` is paired so a cross-tier ownership transfer
# (e.g. recreating the Gateway after an NGF -> Istio cutover) doesn't
# fail on residual managedFields entries from the previous owner.
#
# `gateway.provider` is wired through here (not on the services tier
# anymore) so an operator override `GATEWAY_PROVIDER=istio` lights up
# at the edge tier upgrade with no chart edit.
LOCAL_EDGE_EXTRA = --server-side=true --force-conflicts \
	$(if $(GATEWAY_PROVIDER),--set gateway.provider=$(GATEWAY_PROVIDER),)
AKS_EDGE_EXTRA   = --server-side=true --force-conflicts \
	$(if $(GATEWAY_PROVIDER),--set gateway.provider=$(GATEWAY_PROVIDER),)
GKE_EDGE_EXTRA   = --server-side=true --force-conflicts \
	$(if $(GATEWAY_PROVIDER),--set gateway.provider=$(GATEWAY_PROVIDER),) \
	$(if $(filter 1,$(OBSERVABILITY)),,--set observability.enabled=false)
EKS_EDGE_EXTRA   = --server-side=true --force-conflicts \
	$(if $(GATEWAY_PROVIDER),--set gateway.provider=$(GATEWAY_PROVIDER),)

# llm-gateway: bifrost subchart ships a ServiceMonitor (Prometheus operator
# CRD) by default. Disable it on cloud tiers unless observability is
# guaranteed to be installed first (avoids llm-gateway helm failures when
# the ServiceMonitor CRD is absent). fixPermissions toggles a chown init
# container the chart needs on root-owned CSI mounts; AKS sets it in
# values-aks.yaml, GKE/EKS via --set below.
LOCAL_LLM_GATEWAY_EXTRA =
AKS_LLM_GATEWAY_EXTRA   = --set bifrost.metrics.serviceMonitor.enabled=false
GKE_LLM_GATEWAY_EXTRA   = --set bifrost.metrics.serviceMonitor.enabled=false \
	--set bifrost.persistence.fixPermissions=true

# EKS: same as GKE -- ServiceMonitor disabled and root-chown init container
# so bifrost on FSx-mounted /app/data writes as UID 1000.
EKS_LLM_GATEWAY_EXTRA = --set bifrost.metrics.serviceMonitor.enabled=false \
	--set bifrost.persistence.fixPermissions=true

# Observability: local applies values-local.yaml (inline dev secrets, local
# hostnames/issuers). AKS/GKE/EKS inject grafana-proxy runtime endpoints and
# pre-created existingSecret references; secrets are synced in the pre-hook
# (helm-observability-upgrade-aks / helm-observability-upgrade-gke /
# helm-observability-upgrade-eks) before helm runs.
LOCAL_OBSERVABILITY_EXTRA = \
	-f $(HELM_ROOT)/observability/values-local.yaml

AKS_OBSERVABILITY_EXTRA = \
	-f $(OBSERVABILITY_CHART)/values-aks.yaml \
	--set grafana-proxy.hostname=grafana.$(ENDPOINT) \
	--set grafana-proxy.keycloak.issuer=http://keycloak.$(HELM_NS_IDENTITY).svc.cluster.local:8080/realms/nemo \
	--set grafana-proxy.keycloak.publicIssuer=https://auth.$(ENDPOINT)/realms/nemo

# GKE: same production overlay shape as AKS (PostgreSQL Phoenix, pre-created
# grafana-proxy session/token secrets, GCNV SAN RWO PVCs). Hostname/issuer
# wiring is applied at deploy time via --set (see helm-observability-upgrade-gke).
GKE_OBSERVABILITY_EXTRA = \
	-f $(OBSERVABILITY_CHART)/values-gke.yaml \
	--set grafana-proxy.hostname=grafana.$(ENDPOINT) \
	--set grafana-proxy.keycloak.issuer=http://keycloak.$(HELM_NS_IDENTITY).svc.cluster.local:8080/realms/nemo \
	--set grafana-proxy.keycloak.publicIssuer=https://auth.$(ENDPOINT)/realms/nemo

# EKS: same production overlay shape as AKS/GKE (PostgreSQL Phoenix, pre-created
# grafana-proxy session/token secrets, cluster-default RWO PVCs). Hostname/issuer
# wiring is applied at deploy time via --set (see helm-observability-upgrade-eks).
EKS_OBSERVABILITY_EXTRA = \
	-f $(OBSERVABILITY_CHART)/values-eks.yaml \
	--set grafana-proxy.hostname=grafana.$(ENDPOINT) \
	--set grafana-proxy.keycloak.issuer=http://keycloak.$(HELM_NS_IDENTITY).svc.cluster.local:8080/realms/nemo \
	--set grafana-proxy.keycloak.publicIssuer=https://auth.$(ENDPOINT)/realms/nemo

# ── Macros ───────────────────────────────────────────────────────────────

# Idempotent: ensure namespace exists, annotate with the Helm release
# metadata so `helm upgrade --install` adopts pre-existing namespaces
# without conflict, and label managed-by=Helm. Used by every per-tier
# wrapper as the first step of the upgrade flow.
#
# $1 = release name
# $2 = namespace
define ensure_tier_namespace
	@kubectl create namespace $(2) --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null || true
	@kubectl annotate namespace $(2) \
	  "meta.helm.sh/release-name=$(1)" \
	  "meta.helm.sh/release-namespace=$(2)" --overwrite >/dev/null 2>&1 || true
	@kubectl label namespace $(2) "app.kubernetes.io/managed-by=Helm" --overwrite >/dev/null 2>&1 || true
endef

# Pre-hook for the platform tier (every cloud): shared-secret sync,
# secret-ownership annotation, and lakekeeper encryption key
# preservation. Identical body across local/aks/gke; lifted out so each
# wrapper stays a 3-line dispatch.
#
# Why annotate the synced secrets here? sync-shared-secrets copies
# pre-existing secrets from other namespaces; without
# meta.helm.sh/release-name they would not adopt under the platform
# release on first `helm upgrade` and would surface as "secret already
# exists" errors during chart upgrades. Idempotent: the annotation is
# `--overwrite` and `2>/dev/null || true`-guarded so a re-run never fails.
define platform_pre_hook
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_PLATFORM)
	@for s in shared-postgresql-secret keycloak-oidc-secrets nemo-s3gateway-credentials netapp-ca-certs-secret; do \
	  kubectl annotate secret $$s -n $(HELM_NS_PLATFORM) \
	    "meta.helm.sh/release-name=$(HELM_RELEASE_PLATFORM)" \
	    "meta.helm.sh/release-namespace=$(HELM_NS_PLATFORM)" --overwrite 2>/dev/null || true; \
	  kubectl label secret $$s -n $(HELM_NS_PLATFORM) \
	    "app.kubernetes.io/managed-by=Helm" --overwrite 2>/dev/null || true; \
	done
	$(MAKE) ensure-lakekeeper-encryption-key NS=$(HELM_NS_PLATFORM)
endef

# label-secrets-for-helm: Add Helm ownership metadata to synced secrets so
# Helm can adopt them during install/upgrade. Called after sync-shared-secrets
# for tiers that don't have custom pre-hooks.
# Usage: $(call label-secrets-for-helm,release-name,namespace)
define label-secrets-for-helm
	@for s in shared-postgresql-secret keycloak-oidc-secrets nemo-s3gateway-credentials netapp-ca-certs-secret keycloak-bootstrap-admin; do \
	  if kubectl get secret $$s -n $(2) >/dev/null 2>&1; then \
	    kubectl annotate secret $$s -n $(2) \
	      "meta.helm.sh/release-name=$(1)" \
	      "meta.helm.sh/release-namespace=$(2)" --overwrite; \
	    kubectl label secret $$s -n $(2) \
	      "app.kubernetes.io/managed-by=Helm" --overwrite; \
	  fi; \
	done
endef

# The canned tier upgrade. Replaces ~30 lines per (tier, cloud) recipe
# body. Cloud-specific image/endpoint flags come from $5 (a *_TIER_SET);
# tier+cloud overrides come from $6 (a *_<TIER>_EXTRA). Both are
# variable references so the wrapper stays terse.
#
# values-<cloud>.yaml is included only if the file exists, so charts
# without a per-cloud overlay (database, observability, and several GKE
# tiers) just use the chart-baseline values.yaml. $(HELM_EXTRA_ARGS) is
# always last so operator overrides win (helm `--set` is last-write).
#
# $1 = chart directory under HELM_ROOT (also the values-<cloud>.yaml lookup key)
# $2 = release name
# $3 = namespace
# $4 = cloud (local|aks|gke|eks)
# $5 = cloud-specific tier set (--set image repo + tag + endpoint)
# $6 = tier+cloud-specific extra args (--set lakekeeper, bifrost, etc)
define helm_upgrade_tier
	@echo "Deploying $(1) tier ($(4)) → $(3) ..."
	$(call ensure_tier_namespace,$(2),$(3))
	@# Skip dep-update for tiers that vendor their charts locally (lakekeeper in platform).
	@# Remote dep-update would overwrite the patched vendored chart with the upstream .tgz.
	@if [ -f "$(HELM_ROOT)/$(1)/.helm-skip-dep-update" ]; then \
	  echo "  (skipping helm dependency update — .helm-skip-dep-update present)"; \
	else \
	  helm dependency update $(HELM_ROOT)/$(1); \
	fi
	@cloud_edge_sets=(); \
	if [ "$(1)" = "edge" ]; then \
	  _edge_endpoint="$(strip $(ENDPOINT))"; \
	  _edge_env_file="$(DEPLOY_ENV_FILE)"; \
	  case "$(4)" in \
	    aks) \
	      _edge_sets_script="$(AZURE_SCRIPTS_DIR)/aks-edge-helm-sets.sh"; \
	      if [ ! -f "$$_edge_sets_script" ]; then \
	        echo "ERROR: $$_edge_sets_script is missing (required for AKS edge deploys)."; \
	        echo "       values-aks.yaml dev defaults would be applied without it."; \
	        exit 1; \
	      fi; \
	      while IFS= read -r _line; do \
	        [ -n "$$_line" ] && cloud_edge_sets+=("$$_line"); \
	      done < <(ENDPOINT="$$_edge_endpoint" DEPLOY_ENV_FILE="$$_edge_env_file" \
	        bash "$$_edge_sets_script"); \
	      ;; \
	    eks) \
	      _edge_sets_script="$(AWS_SCRIPTS_DIR)/eks-edge-helm-sets.sh"; \
	      if [ ! -f "$$_edge_sets_script" ]; then \
	        echo "ERROR: $$_edge_sets_script is missing (required for EKS edge deploys)."; \
	        exit 1; \
	      fi; \
	      while IFS= read -r _line; do \
	        [ -n "$$_line" ] && cloud_edge_sets+=("$$_line"); \
	      done < <(ENDPOINT="$$_edge_endpoint" DEPLOY_ENV_FILE="$$_edge_env_file" \
	        bash "$$_edge_sets_script"); \
	      ;; \
	    gke) \
	      _edge_sets_script="$(GCP_SCRIPTS_DIR)/gke-edge-helm-sets.sh"; \
	      if [ ! -f "$$_edge_sets_script" ]; then \
	        echo "ERROR: $$_edge_sets_script is missing (required for GKE edge deploys)."; \
	        exit 1; \
	      fi; \
	      while IFS= read -r _line; do \
	        [ -n "$$_line" ] && cloud_edge_sets+=("$$_line"); \
	      done < <(ENDPOINT="$$_edge_endpoint" DEPLOY_ENV_FILE="$$_edge_env_file" \
	        bash "$$_edge_sets_script"); \
	      ;; \
	  esac; \
	  if [ -n "$$_edge_env_file" ] && [ $${#cloud_edge_sets[@]} -eq 0 ]; then \
	    echo "ERROR: DEPLOY_ENV_FILE=$$_edge_env_file but $(4) edge helm overrides are empty."; \
	    echo "       Check edge.gatewayPipName (azure) / edge.gatewayAddressName (gcp) in the env yaml."; \
	    exit 1; \
	  fi; \
	  if [ -n "$$_edge_endpoint" ] && [ "$$_edge_endpoint" != "agentstudio.local" ] \
	      && [ $${#cloud_edge_sets[@]} -lt 2 ]; then \
	    echo "ERROR: ENDPOINT=$$_edge_endpoint but no JWT issuer override from $(4) edge helm sets."; \
	    exit 1; \
	  fi; \
	  if [ $${#cloud_edge_sets[@]} -gt 0 ]; then \
	    echo "  $(4) edge env overrides: $${#cloud_edge_sets[@]} helm token(s) (DEPLOY_ENV_FILE=$$_edge_env_file, ENDPOINT=$$_edge_endpoint)"; \
	  fi; \
	fi; \
	helm upgrade --install $(2) $(HELM_ROOT)/$(1) \
		--namespace $(3) \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		-f $(HELM_ROOT)/$(1)/values.yaml \
		$(if $(wildcard $(HELM_ROOT)/$(1)/values-$(4).yaml),-f $(HELM_ROOT)/$(1)/values-$(4).yaml) \
		$(5) \
		$(6) \
		"$${cloud_edge_sets[@]}" \
		$(HELM_EXTRA_ARGS)
endef

# Smoke-test (helm template, no cluster contact) for all five
# upgrade-able tiers under a given cloud overlay. Used by
# helm-tier-template-{local,aks,gke,eks}; kept as a macro so the body
# stays in lock-step with helm_upgrade_tier (same -f order, same
# *_TIER_SET, same *_<TIER>_EXTRA semantics).
#
# `helm dependency update` runs once per tier *inside* the loop because
# `helm template` aborts with "found in Chart.yaml, but missing in
# charts/ directory" when a chart's remote dependencies (e.g. platform's
# lakekeeper + redis) have not been fetched. --quiet falls back to a
# loud run on older helm builds that don't accept the flag, mirroring
# the AKS pattern this collapses.
#
# --api-versions monitoring.coreos.com/v1 is injected so ServiceMonitor
# templates (guarded on that CRD via .Capabilities.APIVersions.Has) still
# render offline and keep smoke-test coverage. Real deploys don't pass it —
# the guard reads the target cluster's actual CRDs, so ServiceMonitors are
# skipped on clusters without the Prometheus operator (e.g. local without
# OBSERVABILITY=1) instead of failing the install on an unknown kind.
#
# $1 = cloud (local|aks|gke|eks)
# $2 = cloud-specific tier set (e.g. $(LOCAL_TIER_SET))
define helm_template_all_tiers
	@for tier in platform llm-gateway services console workers edge; do \
	  echo "  helm template: $$tier"; \
	  if [ -f "$(HELM_ROOT)/$$tier/.helm-skip-dep-update" ]; then \
	    echo "    (skipping dep-update — vendored charts in $$tier/charts)"; \
	  else \
	    helm dependency update "$(HELM_ROOT)/$$tier" --quiet 2>/dev/null \
	      || helm dependency update "$(HELM_ROOT)/$$tier" \
	      || { echo "ERROR: $$tier helm dependency update failed"; exit 1; }; \
	  fi; \
	  extra=""; \
	  if [ -f "$(HELM_ROOT)/$$tier/values-$(1).yaml" ]; then \
	    extra="-f $(HELM_ROOT)/$$tier/values-$(1).yaml"; \
	  fi; \
	  provider_set=""; \
	  if [ -n "$(GATEWAY_PROVIDER)" ] && [ "$$tier" = "edge" ]; then \
	    provider_set="--set gateway.provider=$(GATEWAY_PROVIDER)"; \
	  fi; \
	  helm template "$$tier-smoke" $(HELM_ROOT)/$$tier \
	    -f $(HELM_ROOT)/$$tier/values.yaml \
	    $$extra \
	    $(2) \
	    $$provider_set \
	    --api-versions monitoring.coreos.com/v1 \
	    --set-string lakekeeper.catalog.extraInitContainers[0].image=$(INIT_TOOLS_IMAGE) \
	    > /dev/null || { echo "ERROR: $$tier chart failed to render"; exit 1; }; \
	done
endef

# Refresh the platform tier's VENDORED chart dependencies (redis, lakekeeper).
# Run this after bumping a dependency version in platform/Chart.yaml. This is the
# ONLY command that intentionally pulls from charts.bitnami.com / Docker Hub OCI;
# the resulting charts/*.tgz + Chart.lock are committed so that deploys (which
# carry platform/.helm-skip-dep-update) never hit the rate-limited registry.
# The file:// temporal subchart is sourced from charts/temporal/, so its
# build-time .tgz is discarded to avoid committing source as a duplicate binary.
vendor-platform-deps: ## Re-fetch & vendor platform deps (redis, lakekeeper) after a version bump in platform/Chart.yaml
	@# Redirect HELM_*_HOME and scrub any chart-local helm cache dirs so the
	@# refresh can't write cache/config bloat into the chart dir (same hardening
	@# as helm-deps-update in mk/common.mk). We intentionally do NOT reuse that
	@# macro here: it honors .helm-skip-dep-update, which platform carries, so it
	@# would skip the very update this target exists to perform.
	@rm -rf "$(HELM_ROOT)/platform/.cache" "$(HELM_ROOT)/platform/.config" "$(HELM_ROOT)/platform/.helm" 2>/dev/null || true
	@mkdir -p "$(HELM_CACHE_DIR)" "$(HELM_CONFIG_DIR)" "$(HELM_DATA_DIR)"
	HELM_CACHE_HOME="$(HELM_CACHE_DIR)" HELM_CONFIG_HOME="$(HELM_CONFIG_DIR)" HELM_DATA_HOME="$(HELM_DATA_DIR)" \
		helm dependency update "$(HELM_ROOT)/platform"
	@rm -f $(HELM_ROOT)/platform/charts/temporal-*.tgz
	@rm -rf "$(HELM_ROOT)/platform/.cache" "$(HELM_ROOT)/platform/.config" "$(HELM_ROOT)/platform/.helm" 2>/dev/null || true
	@echo "Vendored platform deps:"; ls -1 $(HELM_ROOT)/platform/charts/*.tgz

# Refresh the vendored postgresql dep after bumping its pinned version in database/Chart.yaml.
vendor-database-deps: ## Re-fetch & vendor the postgresql dep after a version bump in database/Chart.yaml
	@rm -rf "$(HELM_ROOT)/database/.cache" "$(HELM_ROOT)/database/.config" "$(HELM_ROOT)/database/.helm" 2>/dev/null || true
	@rm -f $(HELM_ROOT)/database/charts/postgresql-*.tgz $(HELM_ROOT)/database/charts/postgresql-*.tgz.bak
	@mkdir -p "$(HELM_CACHE_DIR)" "$(HELM_CONFIG_DIR)" "$(HELM_DATA_DIR)"
	HELM_CACHE_HOME="$(HELM_CACHE_DIR)" HELM_CONFIG_HOME="$(HELM_CONFIG_DIR)" HELM_DATA_HOME="$(HELM_DATA_DIR)" \
		helm dependency update "$(HELM_ROOT)/database"
	@rm -rf "$(HELM_ROOT)/database/.cache" "$(HELM_ROOT)/database/.config" "$(HELM_ROOT)/database/.helm" 2>/dev/null || true
	@echo "Vendored database deps:"; ls -1 $(HELM_ROOT)/database/charts/*.tgz

# ============================================================================
# Cross-tier infrastructure: namespaces, foundation, identity-wait,
# secret-sync, lakekeeper encryption-key, gateway-api, CSI driver, etc.
# Shared by every cloud orchestrator (deploy-local / deploy-all-tiers-aks /
# deploy-all-tiers-gke).
# ============================================================================

# Create all tier namespaces idempotently and set Helm ownership annotations
# so `helm upgrade --install` can adopt pre-existing namespaces without conflict.
# Names match the namespace defaults in each tier's values.yaml.
helm-tier-namespaces: ## Create all tier namespaces (idempotent)
	@for ns in \
	  $(HELM_NS_SERVICES) \
	  $(HELM_NS_CONSOLE) \
	  $(HELM_NS_WORKERS) \
	  $(HELM_NS_LLM_GATEWAY) \
	  $(HELM_NS_PLATFORM) \
	  $(HELM_NS_IDENTITY) \
	  $(HELM_NS_DATABASE) \
	  $(HELM_NS_OBSERVABILITY) \
	  $(HELM_NS_EDGE); do \
	  kubectl create namespace $$ns --dry-run=client -o yaml | kubectl apply -f -; \
	done
	@kubectl annotate namespace $(HELM_NS_PLATFORM)     "meta.helm.sh/release-name=$(HELM_RELEASE_PLATFORM)"     "meta.helm.sh/release-namespace=$(HELM_NS_PLATFORM)"     --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(HELM_NS_LLM_GATEWAY)  "meta.helm.sh/release-name=$(HELM_RELEASE_LLM_GATEWAY)"  "meta.helm.sh/release-namespace=$(HELM_NS_LLM_GATEWAY)"  --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(HELM_NS_SERVICES)     "meta.helm.sh/release-name=$(HELM_RELEASE_SERVICES)"     "meta.helm.sh/release-namespace=$(HELM_NS_SERVICES)"     --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(HELM_NS_CONSOLE)         "meta.helm.sh/release-name=$(HELM_RELEASE_CONSOLE)"         "meta.helm.sh/release-namespace=$(HELM_NS_CONSOLE)"         --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(HELM_NS_WORKERS)      "meta.helm.sh/release-name=$(HELM_RELEASE_WORKERS)"      "meta.helm.sh/release-namespace=$(HELM_NS_WORKERS)"      --overwrite 2>/dev/null || true
	@kubectl annotate namespace $(HELM_NS_EDGE)         "meta.helm.sh/release-name=$(HELM_RELEASE_EDGE)"         "meta.helm.sh/release-namespace=$(HELM_NS_EDGE)"         --overwrite 2>/dev/null || true
	@kubectl label namespace $(HELM_NS_PLATFORM) $(HELM_NS_LLM_GATEWAY) $(HELM_NS_SERVICES) $(HELM_NS_CONSOLE) $(HELM_NS_WORKERS) $(HELM_NS_EDGE) $(HELM_NS_IDENTITY) $(HELM_NS_OBSERVABILITY) \
	  "app.kubernetes.io/managed-by=Helm" --overwrite 2>/dev/null || true
	@kubectl label namespace $(HELM_NS_PLATFORM) $(HELM_NS_LLM_GATEWAY) $(HELM_NS_SERVICES) $(HELM_NS_CONSOLE) $(HELM_NS_WORKERS) $(HELM_NS_EDGE) $(HELM_NS_IDENTITY) $(HELM_NS_OBSERVABILITY) \
	  "istio-injection=enabled" --overwrite 2>/dev/null || true

# Note: the Secrets Store CSI driver install is split by cloud-neutrality:
#   helm-ss-csi-driver-upgrade  (mk/common.mk)     — base CSI driver DaemonSet
#   aks-ss-csi-driver-upgrade   (mk/cloud/aks.mk)  — adds the Azure KV provider
# deploy-local invokes the cloud-neutral target; deploy-all-tiers-aks
# invokes the AKS target, which prereq-depends on the base driver so a
# single `make aks-ss-csi-driver-upgrade` brings up the whole bundle.

# Cloud-agnostic — same script runs against KIND / AKS / GKE / EKS. The
# upstream Gateway API standard-channel CRDs are version-stable; the bundle
# version pin lives in scripts/install-gateway-api.sh and is kept in
# lockstep with scripts/verify-istio-gateway.sh's EXPECTED_GW_API_BUNDLE.
# NGF is skipped by default (SKIP_NGF_INSTALL=1 in mk/common.mk). Pass
# SKIP_NGF_INSTALL=0 for the legacy NGF rollback path.
install-gateway-api: ## Apply upstream Gateway API standard-channel CRDs (+ optional NGF). Same on KIND / AKS / GKE / EKS. Idempotent. SKIP_NGF_INSTALL=0 to install NGF.
	@echo "Installing upstream Gateway API CRDs (and optionally NGINX Gateway Fabric)..."
	@SKIP_NGF_INSTALL=$(SKIP_NGF_INSTALL) $(SCRIPTS_DIR)/install-gateway-api.sh

# Self-managed Istio control-plane install. Cloud-agnostic — `helm install
# istio-base + istiod` runs identically on AKS / GKE / EKS / KIND. Pin via
# ISTIO_VERSION (default 1.30.0). Idempotent (helm upgrade --install).
# Cluster-admin one-time prereq; not part of any deploy-all-tiers-<cloud>
# orchestrator.
helm-istio-install: ## Install/upgrade self-managed Istio (istio-base + istiod) into istio-system. ISTIO_VERSION pins. Idempotent.
	@$(SCRIPTS_DIR)/install-istio.sh

# Pre-deploy gate for the gateway.provider=istio path. Asserts istiod
# readiness, GatewayClass acceptance, Gateway API CRD bundle version, and
# the TLS Secret in agentstudio-edge. Cloud-agnostic — same assertions on
# every cloud under self-managed Istio. Called from CI before helm upgrade
# in the istio path; safe to run standalone.
verify-istio-gateway: ## Verify Istio + Gateway API + edge TLS prereqs (cloud-agnostic). Pre-deploy gate when GATEWAY_PROVIDER=istio.
	@EDGE_NAMESPACE=$(HELM_NS_EDGE) $(SCRIPTS_DIR)/verify-istio-gateway.sh

# ─── Istio migration helpers (cloud-agnostic) ────────────────────────────
# Used by deploy-all-tiers-{aks,gke,eks} when GATEWAY_PROVIDER=istio so the
# NGF -> Istio cutover is a single `make deploy CLOUD=...` invocation:
#
#   istio-prereq                 — installs CRDs (NGF skipped) + istiod and
#                                  ensures $(HELM_NS_EDGE)/nemo-gateway-tls
#                                  exists (bridge from legacy NGF location,
#                                  or self-signed fallback). Runs BEFORE
#                                  verify-istio-gateway.
#   migrate-ngf-tls-to-edge      — copies nemo-gateway-tls from
#                                  $(HELM_NS_SERVICES) -> $(HELM_NS_EDGE)
#                                  when the canonical TLS pipeline has not
#                                  been repointed yet. Idempotent.
#   wait-istio-gateway-programmed — blocks until the new edge Gateway is
#                                  Programmed=True (the LB-rebind gate).
#   ngf-uninstall                 — tears down the old NGF helm release +
#                                  `nginx` GatewayClass post-cutover.
#                                  Idempotent.

# One-shot fallback: copy nemo-gateway-tls from the legacy NGF location
# (HELM_NS_SERVICES) into the new edge namespace (HELM_NS_EDGE) when the
# canonical provisioning pipeline (provisioning-service / cert-manager
# Issuer / KeyVault CSI) has not been repointed yet. Idempotent and gated
# on (a) missing nemo-gateway-tls in HELM_NS_EDGE and (b) present in
# HELM_NS_SERVICES — no-op once the canonical pipeline writes directly
# to HELM_NS_EDGE.
migrate-ngf-tls-to-edge: ## Bridge nemo-gateway-tls from $(HELM_NS_SERVICES) -> $(HELM_NS_EDGE) (idempotent; no-op once provisioning-service repoints).
	@if kubectl -n $(HELM_NS_EDGE) get secret nemo-gateway-tls >/dev/null 2>&1; then \
	  echo "  migrate-ngf-tls-to-edge: $(HELM_NS_EDGE)/nemo-gateway-tls already present; nothing to do."; \
	elif kubectl -n $(HELM_NS_SERVICES) get secret nemo-gateway-tls >/dev/null 2>&1; then \
	  echo "  migrate-ngf-tls-to-edge: copying $(HELM_NS_SERVICES)/nemo-gateway-tls -> $(HELM_NS_EDGE)/nemo-gateway-tls"; \
	  kubectl create namespace $(HELM_NS_EDGE) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(HELM_NS_SERVICES) get secret nemo-gateway-tls -o json \
	    | python3 -c "import sys, json; s = json.load(sys.stdin); s['metadata'] = {'name': 'nemo-gateway-tls', 'namespace': '$(HELM_NS_EDGE)'}; print(json.dumps(s))" \
	    | kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  migrate-ngf-tls-to-edge: no nemo-gateway-tls in $(HELM_NS_SERVICES) either; istio-prereq will run the prepare-nemo-gateway.sh fallback."; \
	fi

# Cloud-agnostic preflight for GATEWAY_PROVIDER=istio: install Gateway API
# CRDs + istiod, bridge the legacy TLS secret if needed, then fall back to
# the prepare-nemo-gateway.sh self-signed flow when neither the canonical
# TLS pipeline nor the legacy services-ns location has populated
# $(HELM_NS_EDGE)/nemo-gateway-tls. Idempotent end-to-end. Each cloud
# orchestrator invokes this BEFORE verify-istio-gateway when
# GATEWAY_PROVIDER=istio so a single CD run can migrate an NGF cluster.
istio-prereq: ## Idempotent istio prereqs (Gateway API CRDs + istiod + TLS bridge). Called by each cloud orchestrator when GATEWAY_PROVIDER=istio.
	@echo "=== istio-prereq: Gateway API CRDs (NGF skipped) + istiod (idempotent) ==="
	$(MAKE) install-gateway-api
	$(MAKE) helm-istio-install
	$(MAKE) migrate-ngf-tls-to-edge
	@# TLS Secret fallback: when neither the canonical provisioning-service
	@# pipeline NOR the legacy NGF location populated nemo-gateway-tls, run
	@# the self-signed openssl path. FORCE_LEGACY_TLS_PREP=1 bypasses the
	@# cert-manager auto-skip so the secret is always materialised (this is
	@# the same fallback each cloud orchestrator used to call later in the
	@# deploy; pulled forward into istio-prereq so verify-istio-gateway can
	@# pass on its very first CD run).
	@#
	@# NOTE: NOT wrapped in `|| true`. If the script fails (e.g. CI runner
	@# missing openssl, kubectl auth issue), fail HERE with a real error
	@# rather than letting verify-istio-gateway's generic "Secret not found"
	@# surface a misleading symptom 30 seconds later.
	@if ! kubectl -n $(HELM_NS_EDGE) get secret nemo-gateway-tls >/dev/null 2>&1; then \
	  echo "  istio-prereq: no nemo-gateway-tls in $(HELM_NS_EDGE); running prepare-nemo-gateway.sh fallback"; \
	  ENDPOINT="$(strip $(ENDPOINT))" NAMESPACE=$(HELM_NS_EDGE) \
	    CERT_MANAGER_GATEWAY_TLS="$(CERT_MANAGER_GATEWAY_TLS)" \
	    FORCE_LEGACY_TLS_PREP=1 \
	    $(SCRIPTS_DIR)/prepare-nemo-gateway.sh; \
	  if ! kubectl -n $(HELM_NS_EDGE) get secret nemo-gateway-tls >/dev/null 2>&1; then \
	    echo ""; \
	    echo "ERROR: prepare-nemo-gateway.sh completed but Secret $(HELM_NS_EDGE)/nemo-gateway-tls is still missing."; \
	    echo "       Common causes:"; \
	    echo "         - CI runner is missing openssl (apt-get install -y openssl)"; \
	    echo "         - cert-manager is installed AND CERT_MANAGER_GATEWAY_TLS != 1 (chart will own the cert; this is expected on production AKS -- run with CERT_MANAGER_GATEWAY_TLS=1 OR pre-write the Secret via provisioning-service)"; \
	    echo "         - kubectl context does not have permission to create Secrets in $(HELM_NS_EDGE)"; \
	    exit 1; \
	  fi; \
	  echo "  istio-prereq: $(HELM_NS_EDGE)/nemo-gateway-tls created by fallback (type: $$(kubectl -n $(HELM_NS_EDGE) get secret nemo-gateway-tls -o jsonpath='{.type}'))"; \
	fi

# Wait for the edge Istio Gateway to reach Programmed=True before we tear
# down the previous data plane. Default 5min covers Azure/AWS/GCP LB
# provisioning + (on AKS) the static-PIP rebind window; extend via
# ISTIO_GATEWAY_WAIT_TIMEOUT for slower clusters.
ISTIO_GATEWAY_WAIT_TIMEOUT ?= 5m
wait-istio-gateway-programmed: ## Block until Gateway/agentstudio-gateway in HELM_NS_EDGE is Programmed=True. Auto-breaks the single-IP-MetalLB deadlock (NGF holds the only IP) if detected.
	@echo "  Waiting for Gateway/agentstudio-gateway in $(HELM_NS_EDGE) to be Programmed=True (timeout=$(ISTIO_GATEWAY_WAIT_TIMEOUT))..."
	@# First attempt — fast path for clusters with multi-IP MetalLB pools
	@# (AKS/GKE/EKS), where Istio's LB Service grabs a free IP immediately.
	@# 30s is enough on those clouds.
	@if kubectl -n $(HELM_NS_EDGE) wait gateway/agentstudio-gateway \
	   --for=condition=Programmed --timeout=30s 2>/dev/null; then \
	  echo "  Gateway is Programmed=True."; \
	else \
	  reason=$$(kubectl -n $(HELM_NS_EDGE) get gateway agentstudio-gateway \
	    -o jsonpath='{.status.conditions[?(@.type=="Programmed")].reason}' 2>/dev/null); \
	  if [ "$$reason" = "AddressNotAssigned" ] && \
	     helm list -n nginx-gateway -q 2>/dev/null | grep -qx ngf; then \
	    printf "$(COLOR_CYAN)  Gateway stuck on AddressNotAssigned and NGF is still up.\n  This is the single-IP-MetalLB deadlock: NGF holds the only LB IP so\n  MetalLB cannot assign one to Istio. Auto-tearing down NGF to free it.$(COLOR_RESET)\n"; \
	    $(MAKE) ngf-uninstall || true; \
	    echo "  Re-waiting for Gateway/agentstudio-gateway to be Programmed=True (timeout=$(ISTIO_GATEWAY_WAIT_TIMEOUT))..."; \
	    kubectl -n $(HELM_NS_EDGE) wait gateway/agentstudio-gateway \
	      --for=condition=Programmed --timeout=$(ISTIO_GATEWAY_WAIT_TIMEOUT); \
	  else \
	    echo "  Gateway not Programmed (reason=$${reason:-Unknown}). Continuing the wait..."; \
	    kubectl -n $(HELM_NS_EDGE) wait gateway/agentstudio-gateway \
	      --for=condition=Programmed --timeout=$(ISTIO_GATEWAY_WAIT_TIMEOUT); \
	  fi; \
	fi

# Cloud-agnostic NGF teardown for post-cutover cleanup. Removes the NGF
# helm release in nginx-gateway and the nginx GatewayClass it created.
# Idempotent — re-runs against an already-cleaned cluster are no-ops.
# DELETE_NGF_NAMESPACE=1 also deletes the nginx-gateway namespace itself.
ngf-uninstall: ## Tear down NGF controller + nginx GatewayClass (post-istio-cutover, idempotent). DELETE_NGF_NAMESPACE=1 to remove the namespace.
	@if helm list -n nginx-gateway -q 2>/dev/null | grep -qx ngf; then \
	  echo "  ngf-uninstall: removing helm release 'ngf' from nginx-gateway"; \
	  helm uninstall ngf -n nginx-gateway || true; \
	else \
	  echo "  ngf-uninstall: no 'ngf' release in nginx-gateway (already torn down)"; \
	fi
	@kubectl delete gatewayclass nginx --ignore-not-found
	@if [ "$(DELETE_NGF_NAMESPACE)" = "1" ]; then \
	  echo "  ngf-uninstall: deleting namespace nginx-gateway (DELETE_NGF_NAMESPACE=1)"; \
	  kubectl delete namespace nginx-gateway --ignore-not-found; \
	fi

helm-mesh-policies-install: ## Install/upgrade Istio mesh policies (PeerAuth STRICT, AuthzPolicy, injection labels). Idempotent. Must run after helm-istio-install.
	@printf "\n$(COLOR_CYAN)$(SEPARATOR)\n  Istio — mesh policies (PeerAuth, AuthzPolicy, injection labels)\n$(SEPARATOR)$(COLOR_RESET)\n\n"
	@# Wait for istiod validation webhook to be reachable (may take a few seconds after fresh install).
	@for i in $$(seq 1 20); do \
	  kubectl -n $(HELM_NS_ISTIO) get endpoints istiod -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q '\.' && break; \
	  echo "  Waiting for istiod webhook endpoint ($$i/20)..."; sleep 3; \
	done
	@# Adopt the keycloak-jwt-mesh RequestAuthentication + mesh-require-jwt
	@# AuthorizationPolicy that the `edge` release owned before commit 9105d8e9
	@# moved them into this chart. This chart installs BEFORE edge, so on
	@# upgraded clusters Helm would abort with an ownership conflict. Re-stamp
	@# Helm ownership onto this release so it adopts them instead (idempotent;
	@# zero enforcement gap, unlike deleting). Mirrors the namespace-adoption
	@# pattern used elsewhere in this file.
	@for ns in $(MESH_JWT_ADOPT_NAMESPACES); do \
	  for res in requestauthentication/keycloak-jwt-mesh authorizationpolicy/mesh-require-jwt; do \
	    kubectl -n "$$ns" get "$$res" >/dev/null 2>&1 || continue; \
	    owner=$$(kubectl -n "$$ns" get "$$res" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}' 2>/dev/null || true); \
	    [ "$$owner" = "$(HELM_RELEASE_ISTIO_POLICIES)" ] && continue; \
	    echo "  adopting $$ns/$$res into release '$(HELM_RELEASE_ISTIO_POLICIES)' (was '$${owner:-<none>}')"; \
	    kubectl -n "$$ns" annotate "$$res" \
	      meta.helm.sh/release-name=$(HELM_RELEASE_ISTIO_POLICIES) \
	      meta.helm.sh/release-namespace=$(HELM_NS_ISTIO) --overwrite >/dev/null 2>&1 || true; \
	    kubectl -n "$$ns" label "$$res" \
	      app.kubernetes.io/managed-by=Helm --overwrite >/dev/null 2>&1 || true; \
	  done; \
	done
	helm upgrade --install $(HELM_RELEASE_ISTIO_POLICIES) $(MESH_POLICIES_CHART_DIR) \
	  --namespace $(HELM_NS_ISTIO) \
	  --create-namespace \
	  -f $(MESH_POLICIES_CHART_DIR)/values.yaml \
	  --set global.endpoint=$(ENDPOINT) \
	  --set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT) \
	  --wait \
	  --timeout $(HELM_UPGRADE_TIMEOUT) \
	  $(HELM_EXTRA_ARGS)
	@printf "\n$(COLOR_GREEN)  ✔  Mesh policies installed — STRICT mTLS + allow-list active\n$(COLOR_RESET)\n\n"

# Cloud-agnostic idempotent Istio injection labelling. Adds
# `istio-injection=enabled` to every app namespace in ISTIO_APP_NAMESPACES.
# Cloud orchestrators create namespaces per-tier via ensure_tier_namespace and
# never call helm-tier-namespaces, so this target is the cloud path for
# enabling sidecar injection before the tier upgrades run.
istio-label-namespaces: ## Label all mesh-target namespaces with istio-injection=enabled (idempotent).
	@printf "\n$(COLOR_CYAN)  Istio — labelling namespaces for sidecar injection\n$(COLOR_RESET)\n"
	@for ns in $(ISTIO_APP_NAMESPACES); do \
	  kubectl label namespace $$ns istio-injection=enabled --overwrite 2>/dev/null \
	    && echo "  labelled: $$ns" \
	    || echo "  ($$ns not found — will be labelled on first helm-tier-namespaces / ensure_tier_namespace)"; \
	done
	@printf "$(COLOR_GREEN)  ✔  Injection labels applied\n$(COLOR_RESET)\n\n"

configure-ontap-storage: ## Configure cluster for ONTAP or FSxN storage (Trident). Use CONFIG_FILE=path for multi-backend, or env vars for single-backend. See deployments/storage/README.md.
	@$(SCRIPTS_DIR)/configure-ontap-storage.sh

optimize-gateway-nginx: ## Optimize Gateway NGINX controller for better performance
	@echo "Optimizing Gateway NGINX controller..."
	@$(SCRIPTS_DIR)/optimize-gateway-nginx.sh 2>/dev/null || echo "Note: optimize-gateway-nginx.sh not found, configure via GatewayClass or controller ConfigMap"

helm-worker-hpa-preflight: ## Run worker HPA preflight checks (metrics APIs and custom metrics discovery)
	@NAMESPACE=$(HELM_NS_WORKERS) $(SCRIPTS_DIR)/worker-hpa-preflight.sh

# ============================================================================
# Phased Deployment Targets
# Phase 0: Observability (optional)   — make deploy-observability      (or OBSERVABILITY=1 on full-stack targets)
# Phase 1: Foundation (GW + PG)       — make deploy-foundation
# Phase 2: Identity (Keycloak)        — make deploy-identity
# Full AKS stack:   make deploy-all-tiers-aks [OBSERVABILITY=1] [CERT_MANAGER_GATEWAY_TLS=1]
# Full local stack: make deploy-local         [OBSERVABILITY=1] [CERT_MANAGER_GATEWAY_TLS=1]
# See docs/deployment/deployment-design.md for the full deployment architecture.
# ============================================================================

deploy-foundation: ## Phase 1: Gateway API + PostgreSQL (idempotent, safe to re-run). Pass HELM_EXTRA_ARGS for overlays (e.g. -f deployments/helm/database/values-trident.yaml).
	$(MAKE) install-gateway-api
	@OBS_SETS=""; \
	if kubectl get crd servicemonitors.monitoring.coreos.com >/dev/null 2>&1; then \
	  echo "Observability detected -- enabling PostgreSQL metrics"; \
	  OBS_SETS="--set postgresql.metrics.enabled=true --set postgresql.metrics.serviceMonitor.enabled=true"; \
	fi; \
	$(MAKE) helm-database-upgrade HELM_EXTRA_ARGS="$$OBS_SETS $(HELM_EXTRA_ARGS)"
	@echo "Waiting for PostgreSQL readiness..."
	@kubectl rollout status statefulset/shared-postgresql -n $(DATABASE_NAMESPACE) --timeout=300s
	@echo "Ensuring shared PostgreSQL databases exist (idempotent; initdb runs only on empty PVC)..."
	@DATABASE_NAMESPACE=$(DATABASE_NAMESPACE) POSTGRES_PASSWORD=$${POSTGRES_PASSWORD:-agentstudio-postgres-password} \
	  scripts/ensure-shared-databases.sh

deploy-identity: ## Phase 2: Keycloak (idempotent, safe to re-run). Uses values-local.yaml; override KEYCLOAK_DEPLOY_TARGET=helm-identity-install-aks for AKS installs.
	$(MAKE) $(KEYCLOAK_DEPLOY_TARGET)
	$(MAKE) helm-wait-keycloak

# Default deploy-identity target -- override on AKS via:
#   make deploy-identity KEYCLOAK_DEPLOY_TARGET=helm-identity-install-aks \
#     KEYCLOAK_HOSTNAME=https://auth.<endpoint> ...
KEYCLOAK_DEPLOY_TARGET ?= helm-identity-install-local

deploy-observability: ## Phase 0: Prometheus + Grafana (optional, independent) — base target, no env overlay
	@echo "Syncing shared secrets into $(OBSERVABILITY_NAMESPACE)..."
	$(MAKE) sync-shared-secrets TARGET_NS=$(OBSERVABILITY_NAMESPACE)
	$(MAKE) helm-observability-upgrade

deploy-observability-local: ## Phase 0: Prometheus + Grafana on local cluster (applies values-local.yaml)
	$(MAKE) helm-observability-upgrade-local

# Wait for Keycloak to be ready so Lakekeeper init container can reach OIDC discovery.
helm-wait-keycloak: ## Wait for Keycloak deployment/statefulset to be ready (used by deploy-identity)
	@echo "Waiting for Keycloak to be ready..."
	@kubectl rollout status deployment/keycloak -n $(KEYCLOAK_NAMESPACE) --timeout=300s 2>/dev/null || \
	 kubectl rollout status statefulset/keycloak -n $(KEYCLOAK_NAMESPACE) --timeout=300s 2>/dev/null || \
	 echo "Warning: Keycloak wait skipped or timed out; Lakekeeper init will retry."

helm-wait-s3gateway: ## Wait for s3gateway deployment (workers namespace) to be ready — call after helm-workers-upgrade-local
	@echo "Waiting for s3gateway to be ready in $(HELM_NS_WORKERS)..."
	@kubectl rollout status deployment/s3gateway -n $(HELM_NS_WORKERS) --timeout=300s 2>/dev/null || \
	 echo "Warning: s3gateway wait skipped or timed out."

helm-wait-database: ## Wait for shared-postgresql to be Ready before deploying dependent tiers
	@echo "Waiting for shared-postgresql to be ready..."
	@kubectl rollout status statefulset/shared-postgresql -n $(DATABASE_NAMESPACE) --timeout=300s
	@kubectl wait --for=condition=Ready pod/shared-postgresql-0 -n $(DATABASE_NAMESPACE) --timeout=300s

ensure-phoenix-postgres-ready: ## Restart Phoenix when PostgreSQL schema is missing; fail deploy if still uninitialized
	@OBSERVABILITY_NAMESPACE=$(OBSERVABILITY_NAMESPACE) DATABASE_NAMESPACE=$(DATABASE_NAMESPACE) \
	  scripts/ensure-phoenix-postgres-ready.sh

ensure-shared-postgresql-secret: ## Ensure shared-postgresql-secret exists in database namespace (alias from Bitnami shared-postgresql secret)
	@echo "Ensuring shared-postgresql-secret exists in $(DATABASE_NAMESPACE)..."
	@PG_B64=$$(kubectl get secret shared-postgresql-secret -n $(DATABASE_NAMESPACE) -o jsonpath='{.data.postgres-password}' 2>/dev/null || true); \
	if [ -z "$$PG_B64" ]; then \
	  PG_B64=$$(kubectl get secret shared-postgresql -n $(DATABASE_NAMESPACE) -o jsonpath='{.data.postgres-password}' 2>/dev/null || true); \
	fi; \
	if [ -z "$$PG_B64" ]; then \
	  echo "ERROR: Could not find postgres-password in either secret/shared-postgresql-secret or secret/shared-postgresql in $(DATABASE_NAMESPACE)."; \
	  exit 1; \
	fi; \
	printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: shared-postgresql-secret\n  namespace: %s\ntype: Opaque\ndata:\n  postgres-password: %s\n' "$(DATABASE_NAMESPACE)" "$$PG_B64" | kubectl apply -f - >/dev/null
	@echo "shared-postgresql-secret is present in $(DATABASE_NAMESPACE)."

# Idempotently ensure the Lakekeeper postgres encryption-key secret exists in NS.
# Generates a fresh 40-char random key on first call; subsequent calls are no-ops.
# The chart-level --set lakekeeper.secretBackend.postgres.encryptionKeySecret=<name>
# pins the Lakekeeper subchart to consume this pre-existing secret instead of
# auto-generating one (which is incompatible with helm uninstall + namespace
# teardown when the DB is preserved). On a fresh install this secret is
# generated here on first call; the encryption key (and therefore all
# encrypted rows in the lakekeeper DB) is preserved across helm uninstall
# via helm.sh/resource-policy=keep.
ensure-lakekeeper-encryption-key:
	@if [ -z "$(NS)" ]; then echo "ensure-lakekeeper-encryption-key: NS is required"; exit 1; fi
	@kubectl create namespace $(NS) --dry-run=client -o yaml | kubectl apply -f - >/dev/null
	@if kubectl get secret lakekeeper-postgres-encryption -n $(NS) >/dev/null 2>&1; then \
	  echo "  lakekeeper-postgres-encryption already exists in $(NS) — reusing"; \
	 else \
	  echo "  Creating lakekeeper-postgres-encryption in $(NS)"; \
	  KEY=$$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40); \
	  kubectl create secret generic lakekeeper-postgres-encryption \
	    -n $(NS) \
	    --from-literal=encryptionKey="$$KEY"; \
	  kubectl annotate secret lakekeeper-postgres-encryption -n $(NS) --overwrite \
	    "helm.sh/resource-policy=keep" \
	    "meta.helm.sh/release-name=$(HELM_RELEASE_PLATFORM)" \
	    "meta.helm.sh/release-namespace=$(NS)" >/dev/null; \
	  kubectl label secret lakekeeper-postgres-encryption -n $(NS) --overwrite \
	    "app.kubernetes.io/managed-by=Helm" >/dev/null; \
	 fi

# ============================================================================
# Database Helm Commands
# ============================================================================

helm-database-install: ## Install Database Helm chart
	$(call helm-install,$(HELM_RELEASE_DATABASE),$(DATABASE_CHART),database,$(DATABASE_NAMESPACE))

helm-database-uninstall: ## Uninstall Database Helm chart
	@echo "Uninstalling Database Helm chart..."
	@helm uninstall $(HELM_RELEASE_DATABASE) --namespace $(DATABASE_NAMESPACE) || (echo "Warning: Release may not exist" && exit 0)
	@echo "Helm chart uninstalled successfully!"

helm-database-upgrade: ## Upgrade/Install Database Helm chart (auto-detects immutable StatefulSet spec drift)
	@echo "Upgrading/Installing Database Helm chart..."
	@echo "Updating Helm dependencies..."
	$(call helm-deps-update,$(DATABASE_CHART))
	@source $(HELPER_SCRIPT) && ensure_namespace $(DATABASE_NAMESPACE) $(DATABASE_NAMESPACE) || true
	@# Logic lives in scripts/helm-database-upgrade.sh. Make's `export`
	@# directive (see mk/common.mk) plus this single-line recipe means the
	@# script receives all required vars through the OS env — no shell
	@# quoting, no backslash-newline gauntlet, no recipe-line-limit issues.
	@bash $(SCRIPTS_DIR)/helm-database-upgrade.sh

helm-database-upgrade-force: ## Force upgrade DB by recreating StatefulSet object (preserves PVCs)
	@echo "Force upgrading database - recreating StatefulSet object to handle immutable spec changes..."
	@echo "WARNING: This causes brief PostgreSQL downtime while pods are recreated."
	@echo "Deleting StatefulSet with --cascade=orphan so PVCs and pods are preserved..."
	@kubectl delete statefulset -n $(DATABASE_NAMESPACE) shared-postgresql --cascade=orphan 2>/dev/null || \
	echo "StatefulSet may not exist yet; continuing..."
	@echo "Waiting briefly before re-applying Helm release..."
	@sleep 3
	@# HELM_EXTRA_ARGS flows through via env (`export` in mk/common.mk),
	@# so no inline-quoted pass-through is needed — that pattern was prone
	@# to "unmatched single quote" failures when a user-supplied value
	@# contained an apostrophe. DATABASE_FORCE_RECREATE_DONE is passed as
	@# an explicit override so it beats the env-inherited value (`?= 0`).
	@$(MAKE) helm-database-upgrade DATABASE_FORCE_RECREATE_DONE=1

helm-database-dependency-update: ## Update Database Helm chart dependencies (delegates to vendor-database-deps; the dep is pinned/vendored, so helm-deps-update alone would skip it)
	@$(MAKE) vendor-database-deps
	@cd $(DATABASE_CHART) && helm dependency list

helm-database-template: ## Template Database Helm chart to verify it renders correctly
	$(call helm-template,$(HELM_RELEASE_DATABASE),$(DATABASE_CHART),database)

helm-database-status: ## Check status of Database Helm release and pods
	$(call helm-status,$(HELM_RELEASE_DATABASE))

helm-database-debug: ## Debug why Database pods aren't starting
	$(call helm-debug,$(HELM_RELEASE_DATABASE))

# ============================================================================
# Observability Stack Helm Commands
# Phase 0 in deployment order (optional). Use: make deploy-observability
# ============================================================================

# Alias to HELM_NS_OBSERVABILITY (same as DATABASE_NAMESPACE → HELM_NS_DATABASE).
OBSERVABILITY_NAMESPACE ?= $(HELM_NS_OBSERVABILITY)

helm-observability-upgrade-local: ## Upgrade/Install observability stack on local cluster (applies values-local.yaml)
	@echo "Syncing shared secrets into $(OBSERVABILITY_NAMESPACE)..."
	$(MAKE) sync-shared-secrets TARGET_NS=$(OBSERVABILITY_NAMESPACE)
	$(MAKE) helm-observability-upgrade \
		HELM_EXTRA_ARGS="$(LOCAL_OBSERVABILITY_EXTRA) $(HELM_EXTRA_ARGS)"

helm-observability-upgrade-aks: ## Upgrade/Install observability stack on AKS (grafana-proxy + prometheus-proxy enabled). Pre-flight: run aks-keycloak-grafana-proxy-secrets.
	@echo "Syncing shared secrets into $(OBSERVABILITY_NAMESPACE)..."
	$(MAKE) sync-shared-secrets TARGET_NS=$(OBSERVABILITY_NAMESPACE)
	@# grafana-proxy session/token secrets are created directly in $(OBSERVABILITY_NAMESPACE)
	@# by `make aks-keycloak-grafana-proxy-secrets` (no cross-namespace sync needed).
	$(MAKE) aks-keycloak-grafana-proxy-secrets
	$(MAKE) helm-observability-upgrade \
		HELM_EXTRA_ARGS="$(AKS_OBSERVABILITY_EXTRA) $(HELM_EXTRA_ARGS)"

helm-observability-upgrade-gke: ## Upgrade/Install observability stack on GKE (grafana-proxy + prometheus-proxy enabled). Pre-flight: run gke-keycloak-grafana-proxy-secrets.
	@echo "Syncing shared secrets into $(OBSERVABILITY_NAMESPACE)..."
	$(MAKE) sync-shared-secrets TARGET_NS=$(OBSERVABILITY_NAMESPACE)
	@# grafana-proxy session/token secrets are created directly in $(OBSERVABILITY_NAMESPACE)
	@# by `make gke-keycloak-grafana-proxy-secrets` (no cross-namespace sync needed).
	$(MAKE) gke-keycloak-grafana-proxy-secrets
	$(MAKE) helm-observability-upgrade \
		HELM_EXTRA_ARGS="$(GKE_OBSERVABILITY_EXTRA) $(HELM_EXTRA_ARGS)"

helm-observability-upgrade-eks: ## Upgrade/Install observability stack on EKS (grafana-proxy + prometheus-proxy enabled). Pre-flight: run eks-keycloak-grafana-proxy-secrets.
	@echo "Syncing shared secrets into $(OBSERVABILITY_NAMESPACE)..."
	$(MAKE) sync-shared-secrets TARGET_NS=$(OBSERVABILITY_NAMESPACE)
	@# grafana-proxy session/token secrets are created directly in $(OBSERVABILITY_NAMESPACE)
	@# by `make eks-keycloak-grafana-proxy-secrets` (no cross-namespace sync needed).
	$(MAKE) eks-keycloak-grafana-proxy-secrets
	$(MAKE) helm-observability-upgrade \
		HELM_EXTRA_ARGS="$(EKS_OBSERVABILITY_EXTRA) $(HELM_EXTRA_ARGS)"

helm-observability-upgrade: ## Upgrade/Install observability stack (Prometheus, Grafana, optional Jaeger) into the monitoring namespace
	$(call ensure_tier_namespace,observability,$(OBSERVABILITY_NAMESPACE))
	@echo "Updating observability chart dependencies..."
	$(call helm-deps-update,$(OBSERVABILITY_CHART))
	@echo "Deploying observability stack to namespace $(OBSERVABILITY_NAMESPACE)..."
	@helm upgrade --install observability $(OBSERVABILITY_CHART) \
		--namespace $(OBSERVABILITY_NAMESPACE) \
		--create-namespace \
		--set global.imageRepository=$(CONTAINER_IMAGE_REPO) \
		$(if $(IMAGE_TAG),--set global.imageTag=$(IMAGE_TAG),) \
		--set servicesNamespace=$(SERVICES_NAMESPACE) \
		--set phoenix.database.initImage=$(INIT_TOOLS_IMAGE) \
		$(HELM_EXTRA_ARGS)
	@echo "Observability stack deployed!"
	@echo "Waiting for critical observability workloads..."
	@kubectl rollout status deployment/observability-otel-collector -n $(OBSERVABILITY_NAMESPACE) --timeout=180s 2>/dev/null \
	  || echo "Warning: otel-collector rollout not ready (check logs: kubectl logs -n $(OBSERVABILITY_NAMESPACE) -l app.kubernetes.io/name=otel-collector)"
	@PHX_AVAIL=$$(kubectl get deployment phoenix -n $(OBSERVABILITY_NAMESPACE) -o jsonpath='{.status.availableReplicas}' 2>/dev/null || echo 0); \
	if [ "$${PHX_AVAIL:-0}" -ge 1 ] 2>/dev/null; then \
	  echo "Phoenix has $${PHX_AVAIL} available replica(s) (skipping strict rollout wait on large image upgrades)."; \
	else \
	  kubectl rollout status deployment/phoenix -n $(OBSERVABILITY_NAMESPACE) --timeout=600s 2>/dev/null \
	    || echo "Warning: phoenix rollout not ready (check: kubectl get pods -n $(OBSERVABILITY_NAMESPACE) -l app.kubernetes.io/name=phoenix). On small clusters use HELM_EXTRA_ARGS=\"-f $(OBSERVABILITY_CHART)/values-resource-constrained.yaml\""; \
	fi
	@echo "Checking deployment status..."
	@sleep 2
	@kubectl get deployments -n $(OBSERVABILITY_NAMESPACE) 2>/dev/null || echo "Warning: Could not check deployments"
	@kubectl get pods -n $(OBSERVABILITY_NAMESPACE) 2>/dev/null || echo "Warning: Could not check pods"
	@echo ""
	@echo "To enable ServiceMonitor scraping, re-deploy tier charts with HELM_EXTRA_ARGS pointing at the observability overlay for each tier."

helm-observability-uninstall: ## Uninstall observability stack
	@echo "Uninstalling observability stack..."
	@helm uninstall observability --namespace $(OBSERVABILITY_NAMESPACE) || echo "Warning: Release may not exist"
	@echo "Observability stack uninstalled."

helm-observability-status: ## Check observability stack status
	@echo "=== Observability Helm Release Status ==="
	@helm status observability --namespace $(OBSERVABILITY_NAMESPACE) 2>/dev/null || echo "Release not found"
	@echo ""
	@echo "=== Pods ==="
	@kubectl get pods -n $(OBSERVABILITY_NAMESPACE) 2>/dev/null || echo "No pods found"
	@echo ""
	@echo "=== Services ==="
	@kubectl get svc -n $(OBSERVABILITY_NAMESPACE) 2>/dev/null || echo "No services found"

# ============================================================================
# Cross-namespace secret sync
# ============================================================================
# Syncs secrets created in one tier into consumer tier namespaces.
# Identity and Platform must be deployed first. Run before upgrading services/workers/console.
#
# Required: TARGET_NS (destination namespace)
sync-shared-secrets: ## Sync keycloak-oidc-secrets + s3gateway creds + ca-cert + pg secret into TARGET_NS
	@test -n "$(TARGET_NS)" || { echo "ERROR: set TARGET_NS"; exit 1; }
	@# Ensure the destination namespace exists before any secret write.
	@# Each per-tier wrapper (helm-{platform,workers,services,console,llm-gateway}-upgrade-*)
	@# calls this target BEFORE `helm_upgrade_tier`, where `ensure_tier_namespace`
	@# would normally create the namespace. On first-deploy / fresh-cluster runs
	@# the namespace doesn't exist yet, so `kubectl apply` into it fails with
	@# `namespaces "<ns>" not found`. Creating it here is idempotent and harmless
	@# when it already exists.
	@kubectl create namespace "$(TARGET_NS)" --dry-run=client -o yaml | kubectl apply -f - >/dev/null 2>&1 || true
	@echo "  Syncing keycloak-oidc-secrets → $(TARGET_NS)"
	@if kubectl get secret keycloak-oidc-secrets -n $(HELM_NS_IDENTITY) >/dev/null 2>&1; then \
	  kubectl get secret keycloak-oidc-secrets -n $(HELM_NS_IDENTITY) -o json | \
	    python3 -c "import sys,json; d=json.load(sys.stdin); d['metadata']={'name':'keycloak-oidc-secrets','namespace':'$(TARGET_NS)'}; print(json.dumps(d))" | \
	    kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  Warning: keycloak-oidc-secrets not found in $(HELM_NS_IDENTITY); skipping."; \
	fi
	@echo "  Syncing nemo-s3gateway-credentials → $(TARGET_NS)"
	@if [ "$(TARGET_NS)" = "$(HELM_NS_WORKERS)" ]; then \
	  echo "  Skipping nemo-s3gateway-credentials for workers (s3gateway owns it in this namespace)"; \
	elif kubectl get secret nemo-s3gateway-credentials -n $(HELM_NS_PLATFORM) >/dev/null 2>&1; then \
	  kubectl get secret nemo-s3gateway-credentials -n $(HELM_NS_PLATFORM) -o json | \
	    python3 -c "import sys,json; d=json.load(sys.stdin); d['metadata']={'name':'nemo-s3gateway-credentials','namespace':'$(TARGET_NS)'}; print(json.dumps(d))" | \
	    kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  Warning: nemo-s3gateway-credentials not found in $(HELM_NS_PLATFORM); skipping."; \
	fi
	@echo "  Syncing shared-postgresql-secret → $(TARGET_NS)"
	@$(MAKE) ensure-shared-postgresql-secret >/dev/null
	@PG_B64=$$(kubectl get secret shared-postgresql-secret -n $(DATABASE_NAMESPACE) -o jsonpath='{.data.postgres-password}' 2>/dev/null || true); \
	if [ -n "$$PG_B64" ]; then \
	  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: shared-postgresql-secret\n  namespace: %s\ntype: Opaque\ndata:\n  postgres-password: %s\n' "$(TARGET_NS)" "$$PG_B64" | kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  Warning: shared-postgresql-secret not available in $(DATABASE_NAMESPACE); skipping."; \
	fi
	@echo "  Syncing netapp-ca-certs-secret → $(TARGET_NS)"
	@# Source the canonical PEM bundle from the bifrost chart (same file
	@# the llm-gateway tier's netapp-ca-certs-secret.yaml template loads).
	@# A previous version of this recipe created an empty placeholder when
	@# the secret did not exist, which left config-service (and any other
	@# consumer that sets NODE_EXTRA_CA_CERTS to this file) with a 0-byte
	@# trust bundle — outbound TLS to NetApp-internal endpoints then
	@# fails with "self-signed certificate in certificate chain".
	@CA_PEM="$(HELM_ROOT)/llm-gateway/charts/bifrost/files/netapp-ca-cert.pem"; \
	if [ -s "$$CA_PEM" ]; then \
	  kubectl create secret generic netapp-ca-certs-secret -n $(TARGET_NS) \
	    --from-file=netapp-ca-cert.pem="$$CA_PEM" \
	    --dry-run=client -o yaml \
	    | kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  Warning: $$CA_PEM not found or empty; leaving netapp-ca-certs-secret untouched."; \
	  kubectl get secret netapp-ca-certs-secret -n $(TARGET_NS) >/dev/null 2>&1 \
	    || kubectl create secret generic netapp-ca-certs-secret -n $(TARGET_NS) \
	         --from-literal=netapp-ca-cert.pem="" >/dev/null 2>&1 || true; \
	fi
	@echo "  Syncing keycloak-bootstrap-admin → $(TARGET_NS)"
	@if kubectl get secret keycloak-bootstrap-admin -n $(HELM_NS_IDENTITY) >/dev/null 2>&1; then \
	  kubectl get secret keycloak-bootstrap-admin -n $(HELM_NS_IDENTITY) -o json | \
	    python3 -c "import sys,json; d=json.load(sys.stdin); d['metadata']={'name':'keycloak-bootstrap-admin','namespace':'$(TARGET_NS)'}; print(json.dumps(d))" | \
	    kubectl apply --server-side --force-conflicts -f - >/dev/null; \
	else \
	  echo "  Warning: keycloak-bootstrap-admin not found in $(HELM_NS_IDENTITY); skipping (local dev install or pre-flight secret not yet created)."; \
	fi

# Sync to all consumer namespaces (identity + platform must already be deployed)
sync-all-shared-secrets: ## Sync shared secrets to all consumer tier namespaces at once
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_SERVICES)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_WORKERS)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_CONSOLE)
	$(MAKE) sync-shared-secrets TARGET_NS=$(HELM_NS_PLATFORM)
