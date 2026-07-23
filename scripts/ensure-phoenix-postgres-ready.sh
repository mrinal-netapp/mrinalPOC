#!/usr/bin/env bash
# Ensure Phoenix PostgreSQL schema is initialized after shared DB provisioning.
#
# PR #269 created the empty `phoenix` database idempotently, but an already-
# running Phoenix pod does not re-run Alembic migrations. This script detects
# a PostgreSQL-backed Phoenix deployment whose database lacks Alembic state,
# rollout-restarts Phoenix (so init containers + app migrations run), waits for
# readiness, and fails the deploy if schema is still missing.
#
# Usage (from deploy-all-tiers-aks after ensure-shared-databases.sh):
#   OBSERVABILITY=1 make ensure-phoenix-postgres-ready
#
# Environment:
#   OBSERVABILITY_NAMESPACE   Phoenix deployment namespace (default: monitoring)
#   DATABASE_NAMESPACE        Shared PostgreSQL namespace (default: database)
#   POSTGRES_PASSWORD         If unset, read from shared-postgresql-secret in DATABASE_NAMESPACE
#   POSTGRES_USER             Default: postgres
#   POSTGRES_POD              Default: shared-postgresql-0
#   POSTGRES_CONTAINER        Bitnami primary container name (default: postgresql)
#   POSTGRES_READY_TIMEOUT    kubectl wait timeout before psql (default: 300s)
#   PHOENIX_DB                Default: phoenix
#   PHOENIX_ROLLOUT_TIMEOUT   kubectl rollout wait (default: 600s)

set -euo pipefail

OBSERVABILITY_NAMESPACE="${OBSERVABILITY_NAMESPACE:-monitoring}"
DATABASE_NAMESPACE="${DATABASE_NAMESPACE:-database}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_POD="${POSTGRES_POD:-shared-postgresql-0}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-postgresql}"
POSTGRES_READY_TIMEOUT="${POSTGRES_READY_TIMEOUT:-300s}"

# Prefer an explicitly supplied password; fall back to reading the K8s secret.
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  POSTGRES_PASSWORD="$(
    kubectl get secret shared-postgresql-secret -n "${DATABASE_NAMESPACE}" \
      -o jsonpath='{.data.postgres-password}' | base64 -d
  )"
fi
PHOENIX_DB="${PHOENIX_DB:-phoenix}"
PHOENIX_ROLLOUT_TIMEOUT="${PHOENIX_ROLLOUT_TIMEOUT:-600s}"

# Run psql inside the shared PostgreSQL pod (database namespace). Surfaces
# kubectl/psql failures instead of misreporting them as missing databases.
psql_in_postgres() {
  local db="$1"
  local query="$2"
  local output=""
  local rc=0

  output="$(
    kubectl exec -n "${DATABASE_NAMESPACE}" "${POSTGRES_POD}" -c "${POSTGRES_CONTAINER}" -- \
      env PGPASSWORD="${POSTGRES_PASSWORD}" \
      psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${db}" -tAc "${query}" 2>&1
  )" || rc=$?

  if [ "${rc}" -ne 0 ]; then
    echo "ERROR: psql failed in ${DATABASE_NAMESPACE}/${POSTGRES_POD} (container ${POSTGRES_CONTAINER})." >&2
    echo "${output}" >&2
    echo "Ensure the pod is Ready: kubectl wait --for=condition=Ready pod/${POSTGRES_POD} -n ${DATABASE_NAMESPACE}" >&2
    return "${rc}"
  fi

  printf '%s' "${output}"
}

psql_in_phoenix_db() {
  psql_in_postgres "${PHOENIX_DB}" "$1"
}

phoenix_uses_postgresql() {
  local url
  url="$(
    kubectl get deployment phoenix -n "${OBSERVABILITY_NAMESPACE}" \
      -o jsonpath='{.spec.template.spec.containers[?(@.name=="phoenix")].env[?(@.name=="PHOENIX_SQL_DATABASE_URL")].value}' \
      2>/dev/null || true
  )"
  case "${url}" in
    postgresql://*|postgresql+asyncpg://*) return 0 ;;
    *) return 1 ;;
  esac
}

phoenix_schema_ready() {
  local alembic_table alembic_rev traces_table
  alembic_table="$(psql_in_phoenix_db "SELECT to_regclass('public.alembic_version')")"
  alembic_table="${alembic_table//[[:space:]]/}"
  if [ -n "${alembic_table}" ]; then
    alembic_rev="$(psql_in_phoenix_db "SELECT version_num FROM alembic_version LIMIT 1")"
    alembic_rev="${alembic_rev//[[:space:]]/}"
    if [ -n "${alembic_rev}" ]; then
      return 0
    fi
  fi
  traces_table="$(psql_in_phoenix_db "SELECT to_regclass('public.traces')")"
  traces_table="${traces_table//[[:space:]]/}"
  [ -n "${traces_table}" ]
}

echo "Checking Phoenix PostgreSQL schema (Phoenix: ${OBSERVABILITY_NAMESPACE}/phoenix; PostgreSQL: ${DATABASE_NAMESPACE}/${POSTGRES_POD})..."

if ! kubectl get deployment phoenix -n "${OBSERVABILITY_NAMESPACE}" >/dev/null 2>&1; then
  echo "Phoenix deployment not found in namespace ${OBSERVABILITY_NAMESPACE} — skipping."
  exit 0
fi

if ! phoenix_uses_postgresql; then
  echo "Phoenix in ${OBSERVABILITY_NAMESPACE} is not configured for PostgreSQL — skipping."
  exit 0
fi

if ! kubectl get pod "${POSTGRES_POD}" -n "${DATABASE_NAMESPACE}" >/dev/null 2>&1; then
  echo "ERROR: PostgreSQL pod ${POSTGRES_POD} not found in namespace ${DATABASE_NAMESPACE}."
  exit 1
fi

echo "Waiting for PostgreSQL pod ${POSTGRES_POD} in namespace ${DATABASE_NAMESPACE}..."
kubectl wait --for=condition=Ready "pod/${POSTGRES_POD}" -n "${DATABASE_NAMESPACE}" --timeout="${POSTGRES_READY_TIMEOUT}"

db_exists="$(psql_in_postgres postgres "SELECT 1 FROM pg_database WHERE datname='${PHOENIX_DB}'")"
db_exists="${db_exists//[[:space:]]/}"
if [ "${db_exists}" != "1" ]; then
  echo "ERROR: PostgreSQL database '${PHOENIX_DB}' does not exist in ${DATABASE_NAMESPACE}/${POSTGRES_POD}."
  echo "Run scripts/ensure-shared-databases.sh (or redeploy the database tier) first."
  exit 1
fi

if phoenix_schema_ready; then
  echo "Phoenix PostgreSQL schema is initialized in ${DATABASE_NAMESPACE}/${PHOENIX_DB} — no restart needed."
  exit 0
fi

echo "Database '${PHOENIX_DB}' exists in ${DATABASE_NAMESPACE} but schema is uninitialized — restarting Phoenix in ${OBSERVABILITY_NAMESPACE}..."
kubectl rollout restart deployment/phoenix -n "${OBSERVABILITY_NAMESPACE}"
kubectl rollout status deployment/phoenix -n "${OBSERVABILITY_NAMESPACE}" --timeout="${PHOENIX_ROLLOUT_TIMEOUT}"

if phoenix_schema_ready; then
  echo "Phoenix PostgreSQL schema verified in ${DATABASE_NAMESPACE}/${PHOENIX_DB} after restart."
  exit 0
fi

echo "ERROR: Phoenix PostgreSQL schema is still missing in ${DATABASE_NAMESPACE}/${PHOENIX_DB} after rollout restart."
echo "Check Phoenix init container and app logs in ${OBSERVABILITY_NAMESPACE}:"
echo "  kubectl logs -n ${OBSERVABILITY_NAMESPACE} deploy/phoenix -c ensure-phoenix-database"
echo "  kubectl logs -n ${OBSERVABILITY_NAMESPACE} deploy/phoenix -c migration-guard"
echo "  kubectl logs -n ${OBSERVABILITY_NAMESPACE} deploy/phoenix -c phoenix"
exit 1
