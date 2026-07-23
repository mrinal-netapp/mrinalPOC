# mk/common.mk -- shared variables, exports, and generic Helm macros.
#
# Holds the variables and helper macros that every other mk/ file
# depends on. Included FIRST by the root Makefile so HELM_NS_*,
# HELM_RELEASE_*, CONTAINER_IMAGE_REPO, helm-deps-update, etc. are
# defined before mk/build.mk, mk/identity.mk, mk/tier-helm.mk, or
# mk/cloud/<cloud>.mk reference them.
#
# Adding a new global var: put it here. Adding a new generic Helm
# operation that's reused by N>1 callers: define a macro here and call
# from the relevant mk/ file.

# Force bash for recipe execution (Debian /bin/sh is dash and lacks source/pipefail).
SHELL := /usr/bin/env bash

# Repo-root paths (absolute) so sub-makes and non-root cwd still resolve scripts/.
MK_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
REPO_ROOT := $(abspath $(MK_DIR)/..)
SCRIPTS_DIR := $(REPO_ROOT)/scripts
AWS_DEPLOY_DIR := $(REPO_ROOT)/deployments/aws
AZURE_DEPLOY_DIR := $(REPO_ROOT)/deployments/azure
GCP_DEPLOY_DIR := $(REPO_ROOT)/deployments/gcp
AWS_SCRIPTS_DIR := $(AWS_DEPLOY_DIR)/scripts
AZURE_SCRIPTS_DIR := $(AZURE_DEPLOY_DIR)/scripts
GCP_SCRIPTS_DIR := $(GCP_DEPLOY_DIR)/scripts
HELPER_SCRIPT := $(SCRIPTS_DIR)/helm-common.sh
DOCKER_BUILD_SCRIPT := $(SCRIPTS_DIR)/docker-build.sh

# Version can be set via VERSION env var, git tag, or defaults to dev
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
VERSION := $(shell echo $(VERSION) | sed 's/^v//' | sed 's/-dirty$$//')

# Container runtime - defaults to docker, can be overridden with podman
CONTAINER ?= docker

# User ID - defaults to USER environment variable
USER_ID ?= $(shell if [ -n "$$USER" ]; then echo $$USER; elif [ -n "$$USERNAME" ]; then echo $$USERNAME; else id -un 2>/dev/null || echo user; fi)

# Container registry repository base
CONTAINER_IMAGE_REPO ?= docker.repo.eng.netapp.com/user/$(USER_ID)
INIT_TOOLS_IMAGE ?= $(CONTAINER_IMAGE_REPO)/init-tools:latest

# Service definitions (alphabetical order)
# Note: NEMO_SERVICES lists services that are built from source code
# LakeKeeper is deployed as part of AgentStudio but uses official Docker image (lakekeeper/lakekeeper)
# so it's not included in NEMO_SERVICES for build/push operations
NEMO_SERVICES := agent-service agent-service-maf agent-studio-ui analytics-engine apigateway-service artifact-service config-service gui kb-retrieval-service storage-manager workflow-engine
ALL_SERVICES := $(NEMO_SERVICES)

# Optional comma-separated list of services to skip for build/push (e.g. SKIP_SERVICES=gui,kb-retrieval-service)
SKIP_SERVICES ?=

# Go services (don't use npm build)
GO_SERVICES := analytics-engine apigateway-service workflow-engine

# Rust services (built with cargo)
RUST_SERVICES := kb-retrieval-service

# Python services (no build step -- Docker-only)
PYTHON_SERVICES := agent-service agent-service-maf

# Observability proxy services (non-standard path: src/nemo/observability/<service>)
# All are Go modules; path is handled explicitly in scripts/docker-build.sh.
OBSERVABILITY_SERVICES := grafana-proxy prometheus-proxy

# Terminal colours for build output
COLOR_CYAN  := \033[1;36m
COLOR_GREEN := \033[1;32m
COLOR_RESET := \033[0m
SEPARATOR   := ════════════════════════════════════════════════════════════════

# Helm chart paths
DATABASE_CHART := deployments/helm/database
OBSERVABILITY_CHART := deployments/helm/observability
SERVICES_NAMESPACE ?= $(HELM_NS_SERVICES)
# Keycloak (identity phase) — dedicated namespace per the Phase 1
# Edge-Authoritative Identity Pattern. Workload Identity federation on
# AKS binds to system:serviceaccount:agentstudio-identity:keycloak.
# Aliased to HELM_NS_IDENTITY so CI only needs to pass one var.
KEYCLOAK_NAMESPACE ?= $(HELM_NS_IDENTITY)
export SERVICES_NAMESPACE
export KEYCLOAK_NAMESPACE
DATABASE_NAMESPACE ?= $(HELM_NS_DATABASE)
# Export Make vars consumed by scripts/helm-database-upgrade.sh (and any
# future helper scripts). Make's `export` makes them available to the child
# process via OS environment — no shell quoting required, so values that
# contain spaces, single quotes, newlines, or other shell metacharacters
# pass through to the helper safely. This avoids a class of "bash: -c:
# unexpected EOF while looking for matching `''" failures that the older
# inline `VAR='$(VAR)' cmd` recipe form was prone to whenever any
# interpolated Make var contained a single quote.
export DATABASE_NAMESPACE DATABASE_CHART
export CONTAINER_IMAGE_REPO IMAGE_TAG FORCE_PULL ENDPOINT DEPLOY_ENV_FILE ENV
export HELM_EXTRA_ARGS DATABASE_FORCE_RECREATE_DONE
export HELPER_SCRIPT SCRIPTS_DIR REPO_ROOT AWS_SCRIPTS_DIR AZURE_SCRIPTS_DIR GCP_SCRIPTS_DIR
# Ingress substrate: istio (default). Set GATEWAY_PROVIDER=nginx for the NGF
# legacy rollback path (also pass SKIP_NGF_INSTALL=0 on install-gateway-api).
GATEWAY_PROVIDER ?= istio
SKIP_NGF_INSTALL ?= 1
export GATEWAY_PROVIDER SKIP_NGF_INSTALL
# Identity-phase knobs that cloud wrappers (deploy-gke, deploy-eks) and the
# CD workflow set on the outer make invocation. Exporting here lets Phase 2
# (deploy-identity) inherit them without each wrapper having to re-pass them
# on every recursive $(MAKE).
export KEYCLOAK_DEPLOY_TARGET
export KEYCLOAK_HOSTNAME
export KEYCLOAK_TENANT_ID
export KEYCLOAK_ENTRA_APP_CLIENT_ID
export KEYCLOAK_ENTRA_GROUP_ADMINS_OBJECTID
export KEYCLOAK_ENTRA_GROUP_MEMBERS_OBJECTID
DATABASE_FORCE_RECREATE_DONE ?= 0
# Helm waits for Jobs that are post-install/post-upgrade hooks (e.g. keycloak-setup). Default client deadline is short; use a generous timeout.
HELM_UPGRADE_TIMEOUT ?= 30m

# Helm 4 changed the meaning of `--wait`: bare `--wait` selects the new
# "watcher" strategy, which can hang on charts whose pre-upgrade hooks use
# `helm.sh/hook-delete-policy: hook-succeeded,before-hook-creation` (e.g. the
# secrets-store-csi-driver chart). When the helm process is killed mid-watch
# the release is parked at `pending-upgrade` and every subsequent CD run
# fails until someone rolls it back manually. `--wait=legacy` restores the
# Helm 3 ready-loop semantics, which work cleanly with this hook pattern.
# `--wait=legacy` does NOT parse on Helm 3, so we feature-detect the major
# version once and pick the correct flag for everything downstream.
HELM_WAIT_FLAG := $(shell helm version --short 2>/dev/null | grep -q '^v4' && echo "--wait=legacy" || echo "--wait")

# ─── Tier namespace + release variables (multi-cloud multi-namespace layout) ─
# Each tier deploys as a separate Helm release into its own namespace.
# These defaults match the namespace names in each tier's values.yaml.
# Override any of them via environment variable or GitHub Environment variable.
HELM_NS_SERVICES     ?= agentstudio-services
HELM_NS_CONSOLE         ?= agentstudio-console
HELM_NS_WORKERS      ?= agentstudio-workers
HELM_NS_LLM_GATEWAY  ?= agentstudio-llm-gateway
HELM_NS_PLATFORM     ?= agentstudio-platform
HELM_NS_IDENTITY     ?= agentstudio-identity
HELM_NS_DATABASE     ?= database
HELM_NS_OBSERVABILITY ?= monitoring
# Edge tier (Istio gateway migration): owns the ingress Gateway resource +
# every HTTPRoute + RequestAuthentication + AuthorizationPolicy +
# EnvoyFilter + the gateway TLS Secret. See docs/design/istio-gateway-migration.md.
HELM_NS_EDGE         ?= agentstudio-edge

HELM_RELEASE_SERVICES     ?= services
HELM_RELEASE_CONSOLE         ?= console
HELM_RELEASE_WORKERS      ?= workers
HELM_RELEASE_LLM_GATEWAY  ?= llm-gateway
HELM_RELEASE_PLATFORM     ?= platform
HELM_RELEASE_IDENTITY     ?= identity
HELM_RELEASE_DATABASE     ?= database
HELM_RELEASE_EDGE         ?= edge
HELM_RELEASE_CSI_DRIVER   ?= secrets-store-csi-driver
HELM_RELEASE_CSI_PROVIDER ?= csi-secrets-store-provider-azure
# Pinned chart versions for the Secrets Store CSI driver + Azure provider.
# Bump here when upgrading; the values files in deployments/helm/secrets-store-csi/
# are the only other place that needs review.
CSI_DRIVER_VERSION   ?= 1.5.6
CSI_PROVIDER_VERSION ?= 1.8.0
HELM_NS_CSI          ?= agentstudio-ss-csi-driver

# Optional: PV names output by aks-provision-shared-default-bucket.
# When set, the respective tier charts statically bind their PVCs to these PVs
# (Helm creates fresh PVCs; no SSA conflict).
# S3GW_PV_DEFAULT_BUCKET      → workers s3gateway default-bucket PVC
# SERVICES_PV_DEFAULT_BUCKET  → services defaultBucketPvc
#   (a sibling PV with the same ANF volumeHandle as S3GW_PV_DEFAULT_BUCKET,
#    created by migration/provision so both namespaces mount the same NFS export)
# Note: metadata PVC is always dynamically provisioned (no pre-created PV).
S3GW_PV_DEFAULT_BUCKET     ?=
SERVICES_PV_DEFAULT_BUCKET ?=

# ANF NFS storage class used by Trident for dynamic provisioning.
# Used by aks-provision-shared-default-bucket to create the shared default-bucket volume.
ANF_STORAGE_CLASS   ?= anf-nfs
# PVC request size for the shared default-bucket ANF volume.
# ANF rounds up to the pool minimum (typically 100Gi) regardless of the request.
DEFAULT_BUCKET_SIZE ?= 1Ti
# StorageClass to stamp on the sibling PV created for the services namespace.
# Default: empty (copies storageClass from the original workers PV — correct for ANF).
# Override to nemo-local-shared (or any other SC) when the original PV's SC differs
# from what the services chart expects. The sibling PV's underlying volume path is
# always identical to the original; only the Kubernetes storageClassName label changes.
SIBLING_STORAGE_CLASS ?=

HELM_ROOT ?= $(shell pwd)/deployments/helm
AGENTSTUDIO_ROOT ?= $(shell pwd)

export HELM_NS_SERVICES HELM_NS_CONSOLE HELM_NS_WORKERS HELM_NS_LLM_GATEWAY
export HELM_NS_PLATFORM HELM_NS_IDENTITY HELM_NS_DATABASE HELM_NS_OBSERVABILITY HELM_NS_EDGE
# Exported so resolve_tier_namespace (scripts/helm-common.sh) can map a
# Helm release name to its namespace from the same source of truth that
# the deploy macros use. Required by helm-template / helm-status / helm-debug.
export HELM_RELEASE_SERVICES HELM_RELEASE_CONSOLE HELM_RELEASE_WORKERS HELM_RELEASE_LLM_GATEWAY
export HELM_RELEASE_PLATFORM HELM_RELEASE_IDENTITY HELM_RELEASE_DATABASE HELM_RELEASE_EDGE

# ─── Istio service mesh variables ────────────────────────────────────────────
# istio-base + istiod are installed by scripts/install-istio.sh (cluster-admin one-shot).
# Only the mesh-policies Helm chart is managed here.
HELM_NS_ISTIO               ?= istio-system
HELM_RELEASE_ISTIO_POLICIES ?= istio-mesh-policies
MESH_POLICIES_CHART_DIR     := deployments/helm/edge/istio-mesh-policies
MESH_JWT_ADOPT_NAMESPACES   ?= $(HELM_NS_SERVICES) $(HELM_NS_CONSOLE)
# Space-separated list of app namespaces that receive Istio sidecars.
# Used by istio-inject-existing (one-time migration) and istio-verify.
ISTIO_APP_NAMESPACES ?= \
  $(HELM_NS_EDGE) \
  $(HELM_NS_CONSOLE) \
  $(HELM_NS_WORKERS) \
  $(HELM_NS_LLM_GATEWAY) \
  $(HELM_NS_SERVICES) \
  $(HELM_NS_PLATFORM) \
  $(HELM_NS_IDENTITY) \
  $(HELM_NS_OBSERVABILITY) \
  $(HELM_NS_DATABASE)
export HELM_NS_ISTIO HELM_RELEASE_ISTIO_POLICIES

# Default ENDPOINT for all services (TLS certs, subdomains: auth, s3, catalog,
# workflows, ws). Keep the value on a clean line with no trailing inline
# comment — Make's `?=` retains all characters before `#` including any
# whitespace, and the trailing spaces propagate into every shell command
# that interpolates `$(ENDPOINT)` into a double-quoted string. Trailing
# whitespace was a real source of opaque "syntax error" failures in
# helm-database-upgrade until call sites adopted `$(strip ...)`.
ENDPOINT ?= agentstudio.local
DEPLOY_ENV_FILE ?=
ENV ?=

# Gateway TLS: align with ENDPOINT for Certificate dnsNames.
# When the cluster has cert-manager, prepare-nemo-gateway.sh skips mkcert/openssl unless FORCE_LEGACY_TLS_PREP=1.
# Set CERT_MANAGER_GATEWAY_TLS=1 so Helm creates a self-signed ClusterIssuer + Certificate -> Secret nemo-gateway-tls.
# Optional: GATEWAY_LB_IP=<MetalLB or LB VIP> adds an IP SAN for https://<VIP> without cert name warnings.
# Optional: GATEWAY_MATCH_ALL_HOSTS=1 so HTTPRoute matches any Host (use with care).
CERT_MANAGER_GATEWAY_TLS ?= 0
CERT_MANAGER_ISSUER_NAME ?= nemo-gateway-selfsigned
GATEWAY_LB_IP ?=
GATEWAY_MATCH_ALL_HOSTS ?= 0
export CERT_MANAGER_GATEWAY_TLS CERT_MANAGER_ISSUER_NAME GATEWAY_LB_IP GATEWAY_MATCH_ALL_HOSTS

# Public HTTPS port for the edge Gateway. Default 443; local KIND overrides
# to 8443 via mk/cloud/local.mk. Flows to charts as
# --set-string global.gatewayHttpsPort=$(GATEWAY_HTTPS_PORT) in every
# *_TIER_SET (mk/tier-helm.mk), and to Lakekeeper extraEnv URL overrides via
# the gateway_port_suffix helper. Chart-side: nemo.gatewayHttpsPort +
# nemo.gatewayPortSuffix (deployments/helm/*/templates/_helpers.tpl).
GATEWAY_HTTPS_PORT ?= 443
export GATEWAY_HTTPS_PORT

# Set OBSERVABILITY=1 to deploy Phase 0 (Prometheus + Grafana) before the main tiers.
OBSERVABILITY ?= 0
export OBSERVABILITY

# ============================================================================
# Lint
# ============================================================================

# Enforce the naming conventions documented in
# docs/deployment/makefile-target-conventions.md. Run before pushing
# Makefile / mk/* changes; CI can wire this in via `- run: make lint-makefile`.
lint-makefile: ## Enforce Makefile target naming conventions (see docs/deployment/makefile-target-conventions.md)
	@bash scripts/lint-makefile-conventions.sh

# Regression guard: render every chart × every cloud overlay (aks/gke/eks)
# and fail if any rendered VALUE contains a :8443 URL. Local overlay is
# excluded (it legitimately renders :8443). Pure `helm template` — no
# cluster contact. Wire into PR CI: `- run: make lint-no-port-leak`.
#
# Single source of truth — dep-refresh and template loops both iterate
# PORT_LINT_CHARTS so coverage cannot silently diverge. NB: deployments/
# helm/nemo is intentionally excluded: it is the legacy umbrella chart,
# now split into services/platform/workers/llm-gateway/console; no mk/
# target helm-installs it and its file:// subchart source dirs have
# been removed, so it cannot render. Its values-{aks,gke,eks}.yaml
# files are pre-split documentation, not active overlays.
PORT_LINT_CHARTS := services platform workers llm-gateway console edge identity

lint-no-port-leak: ## Assert no :8443 URL leaks in any cloud overlay render (regression guard for the port-convergence convention)
	@# Refresh subchart .tgz packages first. Stale .tgz files in <chart>/charts/
	@# shadow the unpacked source, so without this step the lint may miss
	@# template changes that haven't been re-packaged yet. Charts with no
	@# Chart.yaml deps (edge, identity) no-op silently.
	@for chart in $(PORT_LINT_CHARTS); do \
	  helm dependency update deployments/helm/$$chart --quiet 2>/dev/null \
	    || helm dependency update deployments/helm/$$chart 2>&1 | grep -v 'Unable to get an update' >&2 || true; \
	done
	@set -e; \
	fail=0; \
	for chart in $(PORT_LINT_CHARTS); do \
	  for overlay in aks gke eks; do \
	    overlay_file=deployments/helm/$$chart/values-$$overlay.yaml; \
	    [ -f $$overlay_file ] || continue; \
	    plat_extra=""; \
	    if [ "$$chart" = "platform" ]; then \
	      plat_extra='--set-string lakekeeper.catalog.extraEnv[5].value=https://catalog.lint.example.com --set-string lakekeeper.catalog.extraEnv[10].value=https://auth.lint.example.com/realms/nemo --set-string lakekeeper.catalog.extraEnv[12].value=https://auth.lint.example.com/realms/nemo'; \
	    fi; \
	    if [ "$$chart" = "identity" ]; then \
	      plat_extra='--set global.imageRepository=lint.invalid --set realmBootstrap.broker.tenantId=00000000-0000-0000-0000-000000000000 --set realmBootstrap.broker.groupAdminsObjectId=00000000-0000-0000-0000-000000000000 --set realmBootstrap.broker.groupMembersObjectId=00000000-0000-0000-0000-000000000000 --set realmBootstrap.broker.clientId=00000000-0000-0000-0000-000000000000 --set secretProviderClass.userAssignedIdentityID=00000000-0000-0000-0000-000000000000 --set secretProviderClass.tenantId=00000000-0000-0000-0000-000000000000 --set secretProviderClass.keyvaultName=lint-kv --set keycloak.hostname=https://auth.lint.example.com'; \
	    fi; \
	    if ! out=$$(helm template lint deployments/helm/$$chart \
	      -f $$overlay_file \
	      --set endpoint=lint.example.com \
	      --set global.endpoint=lint.example.com \
	      $$plat_extra); then \
	      echo "FAIL: helm template failed for chart=$$chart overlay=$$overlay (see helm error above)"; \
	      fail=1; \
	      continue; \
	    fi; \
	    leaks=$$(echo "$$out" | grep -E '^[[:space:]]+(value|url|host|endpoint)[a-zA-Z_]*:.*https?://[^[:space:]"]*:8443' || true); \
	    if [ -n "$$leaks" ]; then \
	      echo "FAIL: chart=$$chart overlay=$$overlay leaks :8443 in rendered VALUE:"; \
	      echo "$$leaks" | head -5 | sed 's/^/      /'; \
	      fail=1; \
	    fi; \
	  done; \
	done; \
	if [ "$$fail" -eq 1 ]; then \
	  echo ""; \
	  echo "Fix one of:"; \
	  echo "  - URL helpers: use nemo.gatewayPortSuffix in chart templates"; \
	  echo "    (deployments/helm/*/templates/_helpers.tpl) -- it omits :port"; \
	  echo "    when global.gatewayHttpsPort == 443."; \
	  echo "  - Lakekeeper extraEnv overrides: use $$(gateway_port_suffix) in"; \
	  echo "    mk/tier-helm.mk *_PLATFORM_EXTRA --set-string flags."; \
	  echo ""; \
	  echo "Cloud overlays MUST produce no-port URLs because Keycloak's"; \
	  echo "KC_HOSTNAME on cloud is no-port; JWT issuer string-compare in"; \
	  echo "workflow-engine / analytics-engine / apigateway-service rejects"; \
	  echo "tokens whose iss does not match the helper-emitted value exactly."; \
	  exit 1; \
	fi; \
	echo "OK: no :8443 URL leakage in any cloud overlay render ($(PORT_LINT_CHARTS) x aks/gke/eks)"

# ============================================================================
# Cross-cloud installers
# ============================================================================

# Install/upgrade the base Secrets Store CSI driver DaemonSet into
# $(HELM_NS_CSI). Cloud-neutral — every cluster that consumes a
# SecretProviderClass needs this regardless of where its secrets live.
# Pair with a cloud-specific provider plugin when the cluster needs to
# fetch secrets from a managed KV (e.g. aks-ss-csi-driver-upgrade in
# mk/cloud/aks.mk adds the Azure Key Vault provider). deploy-local
# invokes this target directly; deploy-all-tiers-aks invokes the AKS
# target which prereq-depends on this one. Idempotent — safe to re-run
# after version bumps.
#
# Usage:
#   make helm-ss-csi-driver-upgrade
#   make helm-ss-csi-driver-upgrade CSI_DRIVER_VERSION=1.5.6
helm-ss-csi-driver-upgrade: ## Install/upgrade base Secrets Store CSI driver (cloud-neutral; pair with a cloud provider for managed KVs)
	helm repo add secrets-store-csi-driver \
		https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts --force-update
	helm repo update
	helm upgrade --install $(HELM_RELEASE_CSI_DRIVER) \
		secrets-store-csi-driver/secrets-store-csi-driver \
		--namespace $(HELM_NS_CSI) \
		--create-namespace \
		--version $(CSI_DRIVER_VERSION) \
		--values "$(HELM_ROOT)/secrets-store-csi/values.yaml" \
		--timeout $(HELM_UPGRADE_TIMEOUT) \
		$(HELM_WAIT_FLAG)

# ============================================================================
# Generic Helm Functions / Templates
# ============================================================================

# Refresh a chart's `charts/` dependency directory.
#
# Two distinct hazards we defend against, both of which can balloon
# the release Secret helm writes to the cluster past the apiserver's
# 3 MiB request limit and surface as the cryptic
#   `Error: UPGRADE FAILED: create: failed to create: Request entity too large: limit is 3145728`
#
# 1. Stale subchart .tgz files. On a self-hosted runner, repeated
#    `helm dependency update` runs can leave behind an old
#    postgresql-18.6.X.tgz next to the freshly pulled one. We delete
#    `*.tgz` / `*.tgz.bak` at the chart-root `charts/` level (NOT any
#    unpacked subchart directories committed as first-party subcharts) before
#    re-running `helm dependency update`.
#
# 2. Helm 3 caching its repo indexes in the CHART directory. On a
#    runner without $HOME or $XDG_CACHE_HOME set the way helm expects,
#    `cd <chart> && helm dependency update` causes helm to fall back to
#    writing its cache under `./.cache/helm/repository/...`. The Bitnami
#    index alone is ~26 MB; once that lands inside the chart dir, the
#    next `helm upgrade` packs ALL of it into the release Secret. We
#    point HELM_CACHE_HOME / HELM_CONFIG_HOME / HELM_DATA_HOME at
#    repo-root-scoped paths and ALSO scrub any pre-existing `.cache/`
#    `.config/` `.helm/` directories inside the chart in case a prior
#    run left one behind. The .helmignore in each chart adds these to
#    its exclude list as a defence-in-depth.
#
# Both safeguards are idempotent and run on every dependency refresh.
HELM_CACHE_DIR  := $(CURDIR)/.helm-cache
HELM_CONFIG_DIR := $(CURDIR)/.helm-config
HELM_DATA_DIR   := $(CURDIR)/.helm-data
define helm-deps-update
	@if [ -f "$(1)/.helm-skip-dep-update" ]; then \
		echo "  (skipping helm dependency update — vendored charts in $(1)/charts)"; \
	else \
		if [ -d "$(1)/charts" ]; then \
			find "$(1)/charts" -maxdepth 1 -type f \( -name '*.tgz' -o -name '*.tgz.bak' \) -delete 2>/dev/null || true; \
		fi; \
		rm -rf "$(1)/.cache" "$(1)/.config" "$(1)/.helm" 2>/dev/null || true; \
		mkdir -p "$(HELM_CACHE_DIR)" "$(HELM_CONFIG_DIR)" "$(HELM_DATA_DIR)"; \
		HELM_CACHE_HOME="$(HELM_CACHE_DIR)" HELM_CONFIG_HOME="$(HELM_CONFIG_DIR)" HELM_DATA_HOME="$(HELM_DATA_DIR)" \
			helm dependency update "$(1)" || (echo "Error: Failed to update Helm dependencies" && exit 1); \
	fi
endef

# Generic function to run Helm install (uses upgrade --install so name can be reused if release exists)
#
# $1 = release name
# $2 = chart path
# $3 = chart-type tag for build_helm_set_args (e.g. "nemo", "database") -- NOT the release name
# $4 = namespace (optional; defaults to $1 to preserve the legacy
#      release-name-equals-namespace shorthand for callers that haven't
#      been migrated to pass it explicitly)
define helm-install
	@echo "Installing $(1) Helm chart..."
	@echo "Updating Helm dependencies..."
	$(call helm-deps-update,$(2))
	@source $(HELPER_SCRIPT) && ensure_namespace $(or $(4),$(1)) $(1) || true
	@HELM_SET_ARGS=$$(ENDPOINT="$(strip $(ENDPOINT))" SERVICES_NAMESPACE="$(strip $(SERVICES_NAMESPACE))" KEYCLOAK_NAMESPACE="$(strip $(KEYCLOAK_NAMESPACE))" source $(HELPER_SCRIPT) && build_helm_set_args "$(strip $(CONTAINER_IMAGE_REPO))" "$(strip $(IMAGE_TAG))" $(3)); \
	helm upgrade --install $(1) $(2) \
		--namespace $(or $(4),$(1)) \
		--create-namespace \
		$$HELM_SET_ARGS || (echo "Error: Helm install failed" && exit 1)
	@source $(HELPER_SCRIPT) && setup_ghcr_credentials_post $(or $(4),$(1)) $(CONTAINER_IMAGE_REPO) || true
	@echo "Helm install completed successfully!"
endef

# Generic function to run Helm upgrade
define helm-upgrade
	@echo "Upgrading/Installing $(1) Helm chart..."
	@echo "Updating Helm dependencies..."
	$(call helm-deps-update,$(2))
	@source $(HELPER_SCRIPT) && ensure_namespace $(1) $(1) || true
	@HELM_SET_ARGS=$$(ENDPOINT="$(strip $(ENDPOINT))" SERVICES_NAMESPACE="$(strip $(SERVICES_NAMESPACE))" KEYCLOAK_NAMESPACE="$(strip $(KEYCLOAK_NAMESPACE))" source $(HELPER_SCRIPT) && build_helm_set_args "$(strip $(CONTAINER_IMAGE_REPO))" "$(strip $(IMAGE_TAG))" $(3)); \
	helm upgrade --install $(1) $(2) \
		--namespace $(1) \
		--create-namespace \
		$$HELM_SET_ARGS \
		$(HELM_EXTRA_ARGS)
	@source $(HELPER_SCRIPT) && setup_ghcr_credentials_post $(1) $(CONTAINER_IMAGE_REPO) || true
	@echo "Helm upgrade completed successfully!"
	@echo "Checking deployment status..."
	@sleep 2
	@kubectl get deployments -n $(1) 2>/dev/null || echo "Warning: Could not check deployments"
	@kubectl get pods -n $(1) 2>/dev/null || echo "Warning: Could not check pods"
endef

# Generic function for Helm template.
# $1 = release name (also drives namespace via resolve_tier_namespace)
# $2 = chart path
# $3 = chart type for build_helm_set_args (e.g. "database", "nemo")
define helm-template
	@echo "Templating $(1) Helm chart to verify rendering..."
	$(call helm-deps-update,$(2))
	@source $(HELPER_SCRIPT); set +e; \
	TPL_NS=$$(resolve_tier_namespace "$(1)"); \
	echo "  namespace: $$TPL_NS"; \
	HELM_SET_ARGS=$$(ENDPOINT="$(strip $(ENDPOINT))" SERVICES_NAMESPACE="$(strip $(SERVICES_NAMESPACE))" KEYCLOAK_NAMESPACE="$(strip $(KEYCLOAK_NAMESPACE))" build_helm_set_args "$(strip $(CONTAINER_IMAGE_REPO))" "$(strip $(IMAGE_TAG))" $(3)); \
	HELM_OUT=$$(mktemp "$${TMPDIR:-/tmp}/helm-template.XXXXXX") || { echo "ERROR: mktemp failed" >&2; exit 1; }; \
	trap 'rm -f "$$HELM_OUT"' EXIT INT TERM HUP; \
	helm template $(1) $(2) \
		--namespace $$TPL_NS \
		$$HELM_SET_ARGS \
		$(HELM_EXTRA_ARGS) --debug > "$$HELM_OUT" 2>&1; \
	EC=$$?; \
	grep -m 20 -E "(Source:|kind:)" "$$HELM_OUT"; \
	exit $$EC
	@echo ""
	@echo "Chart rendered successfully!"
endef

# Generic function for Helm status.
# $1 = release name (drives namespace via resolve_tier_namespace)
define helm-status
	@source $(HELPER_SCRIPT); set +e; \
	STATUS_NS=$$(resolve_tier_namespace "$(1)"); \
	echo "Checking $(1) Helm release status (namespace: $$STATUS_NS)..."; \
	helm status $(1) --namespace $$STATUS_NS 2>/dev/null || echo "Release not found"; \
	echo ""; \
	echo "Checking deployments..."; \
	kubectl get deployments -n $$STATUS_NS 2>/dev/null || echo "Namespace or deployments not found"; \
	echo ""; \
	echo "Checking pods..."; \
	kubectl get pods -n $$STATUS_NS 2>/dev/null || echo "Namespace or pods not found"; \
	echo ""; \
	echo "Checking pod events..."; \
	kubectl get events -n $$STATUS_NS --sort-by='.lastTimestamp' 2>/dev/null | tail -10 || echo "No events found"
endef

# Generic function for Helm debug.
# $1 = release name (drives namespace via resolve_tier_namespace)
define helm-debug
	@source $(HELPER_SCRIPT); set +e; \
	DBG_NS=$$(resolve_tier_namespace "$(1)"); \
	echo "=== Checking Deployments ($$DBG_NS) ==="; \
	kubectl get deployments -n $$DBG_NS -o wide 2>/dev/null || echo "No deployments found"; \
	echo ""; \
	echo "=== Checking ReplicaSets ==="; \
	kubectl get replicasets -n $$DBG_NS 2>/dev/null || echo "No replicasets found"; \
	echo ""; \
	echo "=== Checking Pods ==="; \
	kubectl get pods -n $$DBG_NS -o wide 2>/dev/null || echo "No pods found"; \
	echo ""; \
	echo "=== Checking ServiceAccount ==="; \
	kubectl get serviceaccount -n $$DBG_NS 2>/dev/null || echo "No serviceaccount found"; \
	echo ""; \
	echo "=== Recent Events ==="; \
	kubectl get events -n $$DBG_NS --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || echo "No events found"; \
	echo ""; \
	echo "=== Checking Pod Details (if pods exist) ==="; \
	for pod in $$(kubectl get pods -n $$DBG_NS -o name 2>/dev/null | head -3); do \
		echo "--- Details for $$pod ---"; \
		kubectl describe $$pod -n $$DBG_NS 2>/dev/null | tail -30; \
		echo ""; \
	done || echo "No pods to describe"
endef
