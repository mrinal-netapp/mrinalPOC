#!/usr/bin/env bash
# Ensure shared PostgreSQL databases exist (idempotent).
#
# Bitnami initdb scripts run only on an empty PVC. Re-running deploy-foundation
# or upgrading Postgres without wiping the volume leaves databases missing unless
# we create them explicitly.
#
# Usage (from Makefile deploy-foundation after Postgres is Ready):
#   DATABASE_NAMESPACE=database POSTGRES_PASSWORD=agentstudio-postgres-password \
#     scripts/ensure-shared-databases.sh
#
# Environment:
#   DATABASE_NAMESPACE      Kubernetes namespace (default: database)
#   POSTGRES_PASSWORD       Must match deployments/helm/database/values.yaml
#   POSTGRES_USER           Default: postgres
#   POSTGRES_POD              Optional override (default: shared-postgresql-0)
#   POSTGRES_READY_TIMEOUT  kubectl wait timeout (default: 300s; matches helm-wait-database)

set -euo pipefail

DATABASE_NAMESPACE="${DATABASE_NAMESPACE:-database}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agentstudio-postgres-password}"
POSTGRES_POD="${POSTGRES_POD:-shared-postgresql-0}"
POSTGRES_READY_TIMEOUT="${POSTGRES_READY_TIMEOUT:-300s}"

# Keep in sync with deployments/helm/database/values.yaml initdb create-databases.sh
DATABASES=(
  nemo
  keycloak
  lakekeeper
  temporal
  temporal_visibility
  bifrost
  phoenix
)

psql_query() {
  kubectl exec -n "${DATABASE_NAMESPACE}" "${POSTGRES_POD}" -c postgresql -- \
    env PGPASSWORD="${POSTGRES_PASSWORD}" \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d postgres -tAc "$1"
}

psql_exec() {
  kubectl exec -n "${DATABASE_NAMESPACE}" "${POSTGRES_POD}" -c postgresql -- \
    env PGPASSWORD="${POSTGRES_PASSWORD}" \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d postgres -c "$1"
}

echo "Waiting for PostgreSQL pod ${POSTGRES_POD} in namespace ${DATABASE_NAMESPACE}..."
kubectl wait --for=condition=Ready "pod/${POSTGRES_POD}" -n "${DATABASE_NAMESPACE}" --timeout="${POSTGRES_READY_TIMEOUT}"

echo "Checking PostgreSQL connectivity..."
psql_query "SELECT 1;" >/dev/null

for db in "${DATABASES[@]}"; do
  echo -n "Ensuring database '${db}'... "
  if [ "$(psql_query "SELECT 1 FROM pg_database WHERE datname = '${db}'")" = "1" ]; then
    echo "already exists"
  else
    psql_exec "CREATE DATABASE \"${db}\";"
    echo "created"
  fi
done

echo "All shared databases ensured."
