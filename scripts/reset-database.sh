#!/bin/bash
# Script to reset PostgreSQL databases used by AgentStudio services
# Supports resetting individual databases or all databases
#
# Usage:
#   ./scripts/reset-database.sh                    # Reset all databases
#   ./scripts/reset-database.sh nemo               # Reset only nemo database
#   ./scripts/reset-database.sh nemo lakekeeper    # Reset multiple databases
#   ./scripts/reset-database.sh --list             # List all databases
#   ./scripts/reset-database.sh --help            # Show help

set -e

# Default values
NAMESPACE="${DATABASE_NAMESPACE:-database}"
POSTGRES_HOST="${POSTGRES_HOST:-shared-postgresql.database.svc.cluster.local}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agentstudio-postgres-password}"
RESET_MODE="${RESET_MODE:-drop}"  # Options: drop, truncate, list

# Databases used by AgentStudio services
DATABASES=(
    "nemo"           # Config service database
    "lakekeeper"     # Lakekeeper catalog database
    "temporal"       # Temporal workflow database
    "keycloak"       # Keycloak authentication database
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to show help
show_help() {
    cat << EOF
Reset PostgreSQL Database Script

This script resets one or more PostgreSQL databases used by AgentStudio services.

Usage:
    $0 [OPTIONS] [DATABASE_NAMES...]

Options:
    --list              List all databases and exit
    --mode MODE         Reset mode: drop (default), truncate, or list
    --help              Show this help message

Database Names:
    nemo                Config service database (default: all databases)
    lakekeeper          Lakekeeper catalog database
    temporal            Temporal workflow database
    keycloak            Keycloak authentication database

Environment Variables:
    DATABASE_NAMESPACE  Kubernetes namespace for database (default: database)
    POSTGRES_HOST       PostgreSQL host (default: shared-postgresql.database.svc.cluster.local)
    POSTGRES_PORT        PostgreSQL port (default: 5432)
    POSTGRES_USER        PostgreSQL user (default: postgres)
    POSTGRES_PASSWORD    PostgreSQL password (default: agentstudio-postgres-password). Required to match
                         the database chart secret when using kubectl exec (otherwise psql prompts and fails).
    RESET_MODE           Reset mode: drop, truncate, or list (default: drop)

Examples:
    # Reset all databases (drop and recreate)
    $0

    # Reset only nemo database
    $0 nemo

    # Reset multiple databases
    $0 nemo lakekeeper

    # Truncate all tables in nemo database (keep schema)
    $0 --mode truncate nemo

    # List all databases
    $0 --list

Reset Modes:
    drop       Drop and recreate the database (removes all data and schema)
    truncate   Truncate all tables (removes all data but keeps schema)
    list       List databases and tables (no changes made)

WARNING: This will permanently delete data. Use with caution!
EOF
}

# Function to check if PostgreSQL is accessible
check_postgres_connection() {
    print_info "Checking PostgreSQL connection..."
    
    if command -v kubectl &> /dev/null; then
        # Try to connect via kubectl exec
        POSTGRES_POD=$(kubectl get pod -n "$NAMESPACE" -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
        
        if [ -n "$POSTGRES_POD" ]; then
            if kubectl exec -n "$NAMESPACE" "$POSTGRES_POD" -- \
                env PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d postgres -c "SELECT 1;" &>/dev/null; then
                print_info "Found PostgreSQL pod: $POSTGRES_POD (kubectl exec + psql OK)"
                CONNECTION_METHOD="kubectl"
                return 0
            fi
            print_warn "PostgreSQL pod $POSTGRES_POD found but psql auth failed (set POSTGRES_PASSWORD to match the cluster secret?)"
        fi
    fi
    
    # Try direct connection
    if command -v psql &> /dev/null; then
        if PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -c "SELECT 1;" &> /dev/null; then
            print_info "PostgreSQL connection successful via direct connection"
            CONNECTION_METHOD="direct"
            return 0
        fi
    fi
    
    print_error "Cannot connect to PostgreSQL"
    print_error "Please ensure PostgreSQL is accessible and credentials are correct"
    exit 1
}

# Function to execute SQL command
execute_sql() {
    local sql="$1"
    local database="${2:-postgres}"
    
    if [ "$CONNECTION_METHOD" = "kubectl" ]; then
        kubectl exec -n "$NAMESPACE" "$POSTGRES_POD" -- \
            env PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$POSTGRES_USER" -d "$database" -c "$sql"
    else
        PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$database" -c "$sql"
    fi
}

# Function to list databases
list_databases() {
    print_info "Listing databases..."
    execute_sql "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;" postgres
}

# Function to list tables in a database
list_tables() {
    local db_name="$1"
    print_info "Listing tables in database: $db_name"
    execute_sql "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;" "$db_name"
}

# Function to drop and recreate database
reset_database_drop() {
    local db_name="$1"
    print_warn "Dropping and recreating database: $db_name"
    
    # Terminate active connections
    print_info "Terminating active connections to $db_name..."
    execute_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db_name' AND pid <> pg_backend_pid();" postgres 2>/dev/null || true
    
    # Drop database
    print_info "Dropping database: $db_name..."
    execute_sql "DROP DATABASE IF EXISTS \"$db_name\";" postgres
    
    # Create database
    print_info "Creating database: $db_name..."
    execute_sql "CREATE DATABASE \"$db_name\";" postgres
    
    print_info "Database $db_name has been reset (dropped and recreated)"
}

# Function to truncate all tables in database
reset_database_truncate() {
    local db_name="$1"
    print_warn "Truncating all tables in database: $db_name"
    
    # Generate truncate commands
    local truncate_sql=$(cat <<EOF
DO \$\$ DECLARE
    r RECORD;
BEGIN
    -- Truncate all tables
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
        RAISE NOTICE 'Truncated table: %', r.tablename;
    END LOOP;
    
    -- Reset all sequences
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
        EXECUTE 'ALTER SEQUENCE ' || quote_ident(r.sequence_name) || ' RESTART WITH 1';
        RAISE NOTICE 'Reset sequence: %', r.sequence_name;
    END LOOP;
END \$\$;
EOF
)
    
    execute_sql "$truncate_sql" "$db_name"
    print_info "Database $db_name has been reset (all tables truncated)"
}

# Function to reset a database
reset_database() {
    local db_name="$1"
    local mode="$2"
    
    # Check if database exists
    local db_exists=$(execute_sql "SELECT 1 FROM pg_database WHERE datname = '$db_name';" postgres | grep -q "1" && echo "yes" || echo "no")
    
    if [ "$db_exists" = "no" ]; then
        print_warn "Database $db_name does not exist. Creating it..."
        execute_sql "CREATE DATABASE \"$db_name\";" postgres
        print_info "Database $db_name created"
        return 0
    fi
    
    case "$mode" in
        drop)
            reset_database_drop "$db_name"
            ;;
        truncate)
            reset_database_truncate "$db_name"
            ;;
        list)
            list_tables "$db_name"
            ;;
        *)
            print_error "Unknown reset mode: $mode"
            exit 1
            ;;
    esac
}

# Parse command line arguments
TARGET_DATABASES=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --list)
            RESET_MODE="list"
            shift
            ;;
        --mode)
            RESET_MODE="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        -*)
            print_error "Unknown option: $1"
            show_help
            exit 1
            ;;
        *)
            TARGET_DATABASES+=("$1")
            shift
            ;;
    esac
done

# Main execution
print_info "PostgreSQL Database Reset Script"
print_info "================================="

# Check connection
check_postgres_connection

# If list mode and no specific databases, list all databases
if [ "$RESET_MODE" = "list" ] && [ ${#TARGET_DATABASES[@]} -eq 0 ]; then
    list_databases
    exit 0
fi

# Determine which databases to reset
if [ ${#TARGET_DATABASES[@]} -eq 0 ]; then
    # Reset all databases
    TARGET_DATABASES=("${DATABASES[@]}")
    print_info "No specific databases provided, will reset all databases: ${TARGET_DATABASES[*]}"
else
    # Validate database names
    for db in "${TARGET_DATABASES[@]}"; do
        if [[ ! " ${DATABASES[@]} " =~ " ${db} " ]]; then
            print_warn "Unknown database: $db (will attempt to reset anyway)"
        fi
    done
fi

# Confirm before proceeding (unless in list mode)
if [ "$RESET_MODE" != "list" ]; then
    print_warn "WARNING: This will permanently delete data in the following databases:"
    for db in "${TARGET_DATABASES[@]}"; do
        echo "  - $db"
    done
    echo ""
    read -p "Are you sure you want to continue? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        print_info "Operation cancelled"
        exit 0
    fi
    echo ""
fi

# Reset each database
for db_name in "${TARGET_DATABASES[@]}"; do
    echo ""
    print_info "Processing database: $db_name"
    reset_database "$db_name" "$RESET_MODE"
done

echo ""
print_info "Database reset operation completed!"
