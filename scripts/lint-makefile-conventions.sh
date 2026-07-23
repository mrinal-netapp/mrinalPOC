#!/usr/bin/env bash
# scripts/lint-makefile-conventions.sh -- enforce Makefile target naming
# conventions across Makefile + mk/*.mk + mk/cloud/*.mk.
#
# See docs/deployment/makefile-target-conventions.md for the full
# rule definitions; this script is the mechanical enforcement.
#
# Exit codes:
#   0 = clean
#   1 = at least one violation
#
# Usage:
#   bash scripts/lint-makefile-conventions.sh
#   make lint-makefile     # convenience wrapper

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
# Cluster names that may appear as a cloud token.
CLOUDS=("local" "aks" "gke" "eks")

# Cloud-platform names that MUST NOT appear as a target's cloud token
# (use the cluster name instead). R3.
FORBIDDEN_PLATFORM_TOKENS=("azure" "aws" "gcp")

# Cross-cutting tier surface in mk/cloud/<cloud>.mk that's allowed to NOT
# start with `<cloud>-`. R2 allowlist.
#   helm-<tier>-upgrade-<cloud>          (Layer 2)
#   helm-tier-template-<cloud>           (Layer 2 smoke test)
#   deploy-all-tiers-<cloud>             (Layer 3)
#   deploy-<cloud>                       (Layer 3 pre-wrapper, e.g. deploy-gke)
#   deploy-<cloud>-auto                  (legacy script-driven, e.g. deploy-gke-auto)
# Plus a legacy allowlist for local-cluster targets that pre-date the convention:
LEGACY_LOCAL_TARGETS=(
  "deploy-local"
  "deploy-local-bootstrap-fresh"
  "undeploy-local"
  "load-images-local"
  "ensure-local-shared-default-bucket"
  "purge-local-shared-default-bucket"
  "deploy-cloud-auto"   # legacy cross-cloud dispatcher in gke.mk
)

# ── Helpers ────────────────────────────────────────────────────────────────
RED=$'\033[1;31m'
YELLOW=$'\033[1;33m'
GREEN=$'\033[1;32m'
RESET=$'\033[0m'

violations=0
checks=0

log_violation() {
  printf "${RED}VIOLATION${RESET} %s:%s: %s\n" "$1" "$2" "$3" >&2
  violations=$((violations + 1))
}

log_check() {
  checks=$((checks + 1))
}

is_cross_cutting_tier_surface() {
  # $1 = target name, $2 = cloud token (one of CLOUDS)
  local target="$1" cloud="$2"
  case "$target" in
    helm-*-upgrade-"$cloud")             return 0 ;;
    helm-tier-template-"$cloud")         return 0 ;;
    helm-identity-install-"$cloud")      return 0 ;;
    helm-identity-upgrade-"$cloud")      return 0 ;;
    helm-identity-template-"$cloud")     return 0 ;;
    deploy-all-tiers-"$cloud")           return 0 ;;
    deploy-"$cloud")                     return 0 ;;
    deploy-"$cloud"-auto)                return 0 ;;
  esac
  for legacy in "${LEGACY_LOCAL_TARGETS[@]}"; do
    [[ "$target" == "$legacy" ]] && return 0
  done
  return 1
}

# ── R3: forbid cloud-platform-name target tokens ───────────────────────────
# Target must use the cluster name (aks/gke/eks) not the cloud-platform name
# (azure/gcp/aws).
check_r3_no_platform_tokens() {
  log_check
  local file
  for file in Makefile mk/*.mk mk/cloud/*.mk; do
    [[ -f "$file" ]] || continue
    while IFS= read -r line; do
      # Match: lineno:target: ## doc...
      [[ "$line" =~ ^([0-9]+):([a-z][a-z0-9_-]*):.*## ]] || continue
      local lineno="${BASH_REMATCH[1]}" target="${BASH_REMATCH[2]}"
      for token in "${FORBIDDEN_PLATFORM_TOKENS[@]}"; do
        if [[ "$target" == *"-$token-"* ]] || [[ "$target" == "$token-"* ]] || [[ "$target" == *"-$token" ]]; then
          log_violation "$file" "$lineno" \
            "R3 target '$target' uses cloud-platform name '$token'. Use the cluster name (aks/gke/eks) instead. See docs/deployment/makefile-target-conventions.md#layer-5."
        fi
      done
    done < <(grep -nE '^[a-z][a-z0-9_-]*:.*##' "$file" 2>/dev/null || true)
  done
}

# ── R4: forbid cloud-as-suffix in mk/cloud/<cloud>.mk ──────────────────────
# Targets in mk/cloud/<cloud>.mk that match `<verb>-<noun>-<cloud>`
# (cloud as suffix) must be renamed to `<cloud>-<verb>-<noun>`. Exception:
# the cross-cutting tier surface (helm-<tier>-upgrade-<cloud>,
# deploy-all-tiers-<cloud>, etc).
check_r4_no_cloud_suffix() {
  log_check
  local cloud
  for cloud in "${CLOUDS[@]}"; do
    local file="mk/cloud/${cloud}.mk"
    [[ -f "$file" ]] || continue
    while IFS= read -r line; do
      [[ "$line" =~ ^([0-9]+):([a-z][a-z0-9_-]*):.*## ]] || continue
      local lineno="${BASH_REMATCH[1]}" target="${BASH_REMATCH[2]}"
      is_cross_cutting_tier_surface "$target" "$cloud" && continue
      # Cloud as suffix: target ends with `-<cloud>` AND doesn't start with `<cloud>-`
      if [[ "$target" == *"-$cloud" && "$target" != "$cloud-"* ]]; then
        local suggested
        # Rough rename suggestion: strip `-<cloud>` and prefix `<cloud>-`
        suggested="${cloud}-${target%-${cloud}}"
        log_violation "$file" "$lineno" \
          "R4 target '$target' uses cloud-as-suffix. Rename to '$suggested' (cloud-as-prefix). See docs/deployment/makefile-target-conventions.md#layer-5."
      fi
    done < <(grep -nE '^[a-z][a-z0-9_-]*:.*##' "$file" 2>/dev/null || true)
  done
}

# ── R2: targets in mk/cloud/<cloud>.mk MUST start with `<cloud>-` (or be allowlisted) ──
check_r2_cloud_prefix() {
  log_check
  local cloud
  for cloud in "${CLOUDS[@]}"; do
    local file="mk/cloud/${cloud}.mk"
    [[ -f "$file" ]] || continue
    while IFS= read -r line; do
      [[ "$line" =~ ^([0-9]+):([a-z][a-z0-9_-]*):.*## ]] || continue
      local lineno="${BASH_REMATCH[1]}" target="${BASH_REMATCH[2]}"
      # If the target is on the cross-cutting tier surface, it's allowed.
      is_cross_cutting_tier_surface "$target" "$cloud" && continue
      # Otherwise it MUST start with `<cloud>-`.
      if [[ "$target" != "$cloud-"* ]]; then
        log_violation "$file" "$lineno" \
          "R2 target '$target' lives in $file but does not start with '$cloud-'. Either rename to '$cloud-...' or move to a cross-cutting file (mk/tier-helm.mk / mk/common.mk). See docs/deployment/makefile-target-conventions.md#layer-5."
      fi
    done < <(grep -nE '^[a-z][a-z0-9_-]*:.*##' "$file" 2>/dev/null || true)
  done
}

# ── R5: every Layer 2 wrapper calls helm_upgrade_tier ──────────────────────
# helm-<tier>-upgrade-<cloud> recipes must call $(call helm_upgrade_tier,...)
# (otherwise they're inlining what should be parameterised).
check_r5_tier_wrappers_use_macro() {
  log_check
  local cloud
  for cloud in "${CLOUDS[@]}"; do
    local file="mk/cloud/${cloud}.mk"
    [[ -f "$file" ]] || continue
    while IFS=: read -r lineno line; do
      [[ "$line" =~ ^(helm-[a-z-]+-upgrade-${cloud}): ]] || continue
      local target="${BASH_REMATCH[1]}"
      # Read the recipe body (lines after the target until the next blank/target line, max 10)
      local body
      body=$(awk -v start="$lineno" 'NR>start && /^[a-zA-Z]/ {exit} NR>start && NR<=start+10 {print}' "$file")
      if ! echo "$body" | grep -q "helm_upgrade_tier"; then
        log_violation "$file" "$lineno" \
          "R5 tier wrapper '$target' does not call \$(call helm_upgrade_tier,...). Use the canonical macro from mk/tier-helm.mk; do not inline the helm upgrade body. See docs/deployment/makefile-target-conventions.md#layer-2."
      fi
    done < <(grep -nE "^helm-[a-z-]+-upgrade-${cloud}:" "$file" 2>/dev/null || true)
  done
}

# ── R6: help-<cloud> regex contains the <cloud>-[a-z-]+ catchall ───────────
# Without the catchall, every Layer 5 helper has to be added by name.
check_r6_help_catchall() {
  log_check
  local file="mk/dispatch.mk"
  [[ -f "$file" ]] || return 0
  local cloud
  for cloud in "${CLOUDS[@]}"; do
    # Find the help-<cloud> target's awk regex line
    local awk_line
    awk_line=$(awk -v t="help-${cloud}:" '
      $0 ~ "^"t {found=1; next}
      found && /awk -F/ {print; exit}
      found && /^[a-zA-Z]/ {exit}
    ' "$file")
    [[ -n "$awk_line" ]] || continue
    if [[ "$awk_line" != *"${cloud}-[a-z-]+"* ]]; then
      log_violation "$file" "?" \
        "R6 help-${cloud} regex missing the '${cloud}-[a-z-]+' catchall. Without it, every new ${cloud}-* helper must be added by name. See docs/deployment/makefile-target-conventions.md#layer-7."
    fi
  done
}

# ── Run all checks ─────────────────────────────────────────────────────────
echo "Linting Makefile target naming conventions..."
echo ""

check_r2_cloud_prefix
check_r3_no_platform_tokens
check_r4_no_cloud_suffix
check_r5_tier_wrappers_use_macro
check_r6_help_catchall

echo ""
if [[ $violations -eq 0 ]]; then
  printf "${GREEN}OK${RESET}  %d rule groups passed; no violations.\n" "$checks"
  exit 0
else
  printf "${RED}FAIL${RESET}  %d violation(s) across %d rule groups.\n" "$violations" "$checks"
  printf "${YELLOW}HINT${RESET}  See docs/deployment/makefile-target-conventions.md for the full rules.\n"
  exit 1
fi
