#!/bin/bash
# Script to create the lakekeeper database in the shared PostgreSQL instance
# Usage: ./scripts/create-lakekeeper-db.sh

set -e

POSTGRES_HOST="${POSTGRES_HOST:-shared-postgresql.database.svc.cluster.local}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-agentstudio-postgres-password}"
POSTGRES_DB="${POSTGRES_DB:-lakekeeper}"

echo "Creating database '$POSTGRES_DB' in PostgreSQL at $POSTGRES_HOST:$POSTGRES_PORT..."

# Check if database exists
DB_EXISTS=$(PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q 1 && echo "yes" || echo "no")

if [ "$DB_EXISTS" = "yes" ]; then
    echo "Database '$POSTGRES_DB' already exists."
    exit 0
fi

# Create database
echo "Creating database '$POSTGRES_DB'..."
PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE \"$POSTGRES_DB\";"

if [ $? -eq 0 ]; then
    echo "Database '$POSTGRES_DB' created successfully!"
else
    echo "Error: Failed to create database '$POSTGRES_DB'"
    exit 1
fi

