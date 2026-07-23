# mk/validate.mk — offline Helm values parity + render gate.
#
# Provides the following public targets:
#
#   helm-validate          Full gate: lint-values + helm template ×4 clouds.
#                          Suitable for CI "- run: make helm-validate".
#                          No cluster contact needed.
#
#   helm-validate-local    Render the gate tiers with local overlay.
#   helm-validate-aks      Render the gate tiers with AKS overlay.
#   helm-validate-gke      Render the gate tiers with GKE overlay.
#   helm-validate-eks      Render the gate tiers with EKS overlay.
#
#   "Gate tiers" = platform, llm-gateway, services, console, workers, edge.
#   The identity tier is parity-linted but rendered separately via
#   helm-identity-template-<cloud> (it needs a hostname), so it is not
#   render-validated by these targets.
#
#   lint-values            Cross-cloud values parity + orphan-key linter.
#                          Reports DRIFT (key in some overlays but not all)
#                          and ORPHAN (key not in base values.yaml).
#
#   lint-values-tier       Same as lint-values but for one tier.
#                          Usage:  make lint-values-tier TIER=services
#
# Design rationale:
#   helm-validate-<cloud> delegates to the existing helm-tier-template-<cloud>
#   targets (mk/cloud/*.mk) which already handle helm dependency update,
#   overlay selection, the vendor-skip sentinel, and all --set flags. This
#   file adds only the preflight check, flanking log lines, and the aggregate
#   target — no duplication of render logic.
#
# See docs/deployment/values-convergence-strategy.md for the full design.

# ── Tool preflight helpers ────────────────────────────────────────────────────

define check-helm-available
	@command -v helm >/dev/null 2>&1 || { \
	  echo "ERROR: helm not found in PATH."; \
	  echo "       Install helm >= 4.2 to run helm-validate targets."; \
	  exit 1; }
endef

define check-python3-yaml
	@command -v python3 >/dev/null 2>&1 || { \
	  echo "ERROR: python3 not found in PATH."; \
	  echo "       Install python3 to run lint-values targets."; \
	  exit 1; }
	@python3 -c "import yaml" 2>/dev/null || { \
	  echo "ERROR: PyYAML not installed (required by lint-values-parity.py)."; \
	  echo "       Run: pip3 install pyyaml"; \
	  exit 1; }
endef

# ── Per-cloud render targets ──────────────────────────────────────────────────
# Each target delegates to helm-tier-template-<cloud> from mk/cloud/<cloud>.mk.
# That target runs helm dependency update per tier (honoring the vendor sentinel)
# and calls helm template with the correct overlay + --set flags — no cluster
# contact, pure offline rendering.

helm-validate-local: ## Render the gate tiers with local overlay (offline, no cluster; excludes identity)
	$(call check-helm-available)
	@printf '\n$(COLOR_CYAN)  ▶  helm-validate-local: rendering gate tiers (local overlay)$(COLOR_RESET)\n'
	$(MAKE) helm-tier-template-local
	@printf '$(COLOR_GREEN)  ✔  local render OK$(COLOR_RESET)\n'

helm-validate-aks: ## Render the gate tiers with AKS overlay (offline, no cluster; excludes identity)
	$(call check-helm-available)
	@printf '\n$(COLOR_CYAN)  ▶  helm-validate-aks: rendering gate tiers (aks overlay)$(COLOR_RESET)\n'
	$(MAKE) helm-tier-template-aks
	@printf '$(COLOR_GREEN)  ✔  aks render OK$(COLOR_RESET)\n'

helm-validate-gke: ## Render the gate tiers with GKE overlay (offline, no cluster; excludes identity)
	$(call check-helm-available)
	@printf '\n$(COLOR_CYAN)  ▶  helm-validate-gke: rendering gate tiers (gke overlay)$(COLOR_RESET)\n'
	$(MAKE) helm-tier-template-gke
	@printf '$(COLOR_GREEN)  ✔  gke render OK$(COLOR_RESET)\n'

helm-validate-eks: ## Render the gate tiers with EKS overlay (offline, no cluster; excludes identity)
	$(call check-helm-available)
	@printf '\n$(COLOR_CYAN)  ▶  helm-validate-eks: rendering gate tiers (eks overlay)$(COLOR_RESET)\n'
	$(MAKE) helm-tier-template-eks
	@printf '$(COLOR_GREEN)  ✔  eks render OK$(COLOR_RESET)\n'

# ── Parity + orphan-key linter ────────────────────────────────────────────────

lint-values: ## Cross-cloud values parity + orphan-key linter (all tiers, no cluster)
	$(call check-python3-yaml)
	@printf '\n$(COLOR_CYAN)  ▶  lint-values: checking all tiers for cross-cloud drift$(COLOR_RESET)\n'
	@python3 $(SCRIPTS_DIR)/lint-values-parity.py $(HELM_ROOT)
	@printf '$(COLOR_GREEN)  ✔  lint-values OK$(COLOR_RESET)\n'

lint-values-tier: ## Parity linter for a single tier. Usage: make lint-values-tier TIER=services
	@test -n "$(TIER)" || { \
	  echo "ERROR: TIER is not set. Example: make lint-values-tier TIER=services"; exit 1; }
	$(call check-python3-yaml)
	@printf '\n$(COLOR_CYAN)  ▶  lint-values-tier: checking $(TIER) tier$(COLOR_RESET)\n'
	@python3 $(SCRIPTS_DIR)/lint-values-parity.py $(HELM_ROOT) $(TIER)

# ── Aggregate offline gate ────────────────────────────────────────────────────
# Order:
#   1. lint-values  (fast, static — catches typos/drift before spending time on
#                    helm template + dep-update which pull from the network)
#   2. helm-validate-local
#   3. helm-validate-aks
#   4. helm-validate-gke
#   5. helm-validate-eks
#
# Each helm-validate-<cloud> re-runs helm-tier-template-<cloud> which handles
# dep-update inline per tier. Nothing contacts a Kubernetes cluster.

helm-validate: ## Full offline gate: values parity + helm template ×4 clouds. No cluster.
	$(call check-helm-available)
	$(call check-python3-yaml)
	@printf '\n$(COLOR_CYAN)$(SEPARATOR)\n'
	@printf '  helm-validate — offline values parity + render gate\n'
	@printf '$(SEPARATOR)$(COLOR_RESET)\n'
	$(MAKE) lint-values
	$(MAKE) helm-validate-local
	$(MAKE) helm-validate-aks
	$(MAKE) helm-validate-gke
	$(MAKE) helm-validate-eks
	@printf '\n$(COLOR_GREEN)$(SEPARATOR)\n'
	@printf '  ✔  helm-validate: all checks passed\n'
	@printf '$(SEPARATOR)$(COLOR_RESET)\n'

.PHONY: \
  helm-validate \
  helm-validate-local \
  helm-validate-aks \
  helm-validate-gke \
  helm-validate-eks \
  lint-values \
  lint-values-tier
