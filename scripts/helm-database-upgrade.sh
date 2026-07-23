#!/usr/bin/env bash
# Helm upgrade for the database tier with auto-recovery on immutable
# StatefulSet spec drift.
#
# Extracted from mk/tier-helm.mk into a standalone script because the
# original inline-recipe form (nested `if ... then ... fi` joined with
# backslash-newline) is fragile across GNU Make versions and shells: a
# CRLF in the checkout, a stray trailing space, or a Make 4.x backslash-
# handling quirk silently truncated the recipe before bash could see the
# closing `fi`, producing "bash: -c: line 8: syntax error: unexpected
# end of file". Calling out to a script keeps the recipe to one line
# and isolates all the shell logic in one syntactically-checkable file.
#
# Usage (called from `helm-database-upgrade` recipe):
#   scripts/helm-database-upgrade.sh
#
# Required Make vars (passed via env from the Makefile):
#   HELM_RELEASE_DATABASE  release name (e.g. "database")
#   DATABASE_CHART         chart path (e.g. "deployments/helm/database")
#   DATABASE_NAMESPACE     namespace (e.g. "database")
#   HELM_EXTRA_ARGS        operator-supplied extra `--set` etc. (may be empty)
#   ENDPOINT, SERVICES_NAMESPACE, KEYCLOAK_NAMESPACE,
#     CONTAINER_IMAGE_REPO, IMAGE_TAG  — forwarded to build_helm_set_args
#   DATABASE_FORCE_RECREATE_DONE  "1" if helm-database-upgrade-force has
#     already run this invocation; prevents infinite recovery loops.
#   HELPER_SCRIPT          path to scripts/helm-common.sh (sourced for
#     build_helm_set_args).

set -euo pipefail

# Required vars — fail fast with a clear message if the Makefile didn't
# export them. This is much easier to diagnose than "undefined var in
# shell expansion" mid-script.
: "${HELM_RELEASE_DATABASE:?helm-database-upgrade.sh: HELM_RELEASE_DATABASE not set}"
: "${DATABASE_CHART:?helm-database-upgrade.sh: DATABASE_CHART not set}"
: "${DATABASE_NAMESPACE:?helm-database-upgrade.sh: DATABASE_NAMESPACE not set}"
: "${HELPER_SCRIPT:?helm-database-upgrade.sh: HELPER_SCRIPT not set}"

# Optional vars — default to empty so the recipe stays compact.
HELM_EXTRA_ARGS="${HELM_EXTRA_ARGS:-}"
ENDPOINT="${ENDPOINT:-}"
SERVICES_NAMESPACE="${SERVICES_NAMESPACE:-}"
KEYCLOAK_NAMESPACE="${KEYCLOAK_NAMESPACE:-}"
CONTAINER_IMAGE_REPO="${CONTAINER_IMAGE_REPO:-}"
IMAGE_TAG="${IMAGE_TAG:-}"
DATABASE_FORCE_RECREATE_DONE="${DATABASE_FORCE_RECREATE_DONE:-0}"

# Strip whitespace defensively (e.g., trailing-comment leak in `?= value  # ...`).
ENDPOINT="$(echo "$ENDPOINT" | xargs)"
SERVICES_NAMESPACE="$(echo "$SERVICES_NAMESPACE" | xargs)"
KEYCLOAK_NAMESPACE="$(echo "$KEYCLOAK_NAMESPACE" | xargs)"
CONTAINER_IMAGE_REPO="$(echo "$CONTAINER_IMAGE_REPO" | xargs)"
IMAGE_TAG="$(echo "$IMAGE_TAG" | xargs)"

# shellcheck source=helm-common.sh
source "$HELPER_SCRIPT"

# build_helm_set_args reads ENDPOINT/*_NAMESPACE from env; pass them through.
HELM_SET_ARGS="$(
  ENDPOINT="$ENDPOINT" \
  SERVICES_NAMESPACE="$SERVICES_NAMESPACE" \
  KEYCLOAK_NAMESPACE="$KEYCLOAK_NAMESPACE" \
  build_helm_set_args "$CONTAINER_IMAGE_REPO" "$IMAGE_TAG" database
)"

LOG_FILE="$(mktemp -t helm-database-upgrade.XXXXXX.log)"
trap 'rm -f "$LOG_FILE"' EXIT

set -o pipefail
# shellcheck disable=SC2086 # HELM_SET_ARGS and HELM_EXTRA_ARGS are intentionally word-split
if ! helm upgrade --install "$HELM_RELEASE_DATABASE" "$DATABASE_CHART" \
    --namespace "$DATABASE_NAMESPACE" \
    --create-namespace \
    $HELM_SET_ARGS \
    $HELM_EXTRA_ARGS 2>&1 | tee "$LOG_FILE"; then
  if grep -q "StatefulSet.apps .* is invalid: spec: Forbidden: updates to statefulset spec" "$LOG_FILE" 2>/dev/null; then
    echo ""
    if [ "$DATABASE_FORCE_RECREATE_DONE" = "1" ]; then
      echo "ERROR: Database upgrade still failed after StatefulSet recreation attempt."
      exit 1
    fi
    echo "Detected immutable StatefulSet spec drift; attempting automatic force upgrade..."
    # HELM_EXTRA_ARGS flows through to the sub-make via the env it already
    # inherited (`export` in mk/common.mk); passing it as a command-line
    # arg would re-introduce the single-quote-in-value fragility.
    # DATABASE_FORCE_RECREATE_DONE must be a command-line override so it
    # beats the env-inherited value when the recursive helm-database-upgrade
    # checks `?= 0`.
    exec "${MAKE:-make}" helm-database-upgrade-force DATABASE_FORCE_RECREATE_DONE=1
  else
    exit 1
  fi
fi

# Post-install: GHCR pull-secret bridge. Tolerate failure (see helm-common.sh).
setup_ghcr_credentials_post "$DATABASE_NAMESPACE" "$CONTAINER_IMAGE_REPO" || true
echo "Helm upgrade completed successfully!"
echo "Checking deployment status..."
sleep 2
kubectl get deployments -n "$DATABASE_NAMESPACE" 2>/dev/null || echo "Warning: Could not check deployments"
kubectl get pods -n "$DATABASE_NAMESPACE" 2>/dev/null || echo "Warning: Could not check pods"
