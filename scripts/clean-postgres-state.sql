-- SQL script to clean PostgreSQL database state
-- This script provides SQL commands for different cleanup scenarios
-- 
-- Note: Both Helm deployments and source code now default to database name "nemo"
-- 
-- Usage:
--   psql -h <host> -U <user> -d <database> -f clean-postgres-state.sql
--   Or with kubectl:
--   kubectl exec -n database <postgres-pod> -- psql -U postgres -d nemo -f - < clean-postgres-state.sql

-- ==========================================
-- OPTION 1: Drop and Recreate Database
-- ==========================================
-- Connect to 'postgres' database first, then run:
-- 
-- DROP DATABASE IF EXISTS nemo;
-- CREATE DATABASE nemo;
-- 
-- Note: You'll need to reconnect to the new database after this

-- ==========================================
-- OPTION 2: Drop All Tables (Keep Database)
-- ==========================================
-- This drops all tables, sequences, and custom types (enums) in the public schema

DO $$ DECLARE
    r RECORD;
BEGIN
    -- Drop all tables
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        RAISE NOTICE 'Dropped table: %', r.tablename;
    END LOOP;
    
    -- Drop all sequences
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
        EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.sequence_name) || ' CASCADE';
        RAISE NOTICE 'Dropped sequence: %', r.sequence_name;
    END LOOP;
    
    -- Drop all custom types (enums)
    FOR r IN (
        SELECT typname 
        FROM pg_type 
        WHERE typtype = 'e' 
        AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ) LOOP
        EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
        RAISE NOTICE 'Dropped type: %', r.typname;
    END LOOP;
END $$;

-- ==========================================
-- OPTION 3: Truncate All Tables (Keep Schema)
-- ==========================================
-- This removes all data but keeps the schema intact
-- Uncomment the section below to use this option instead of Option 2

/*
DO $$ DECLARE
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
END $$;
*/

-- ==========================================
-- OPTION 4: List All Tables (For Verification)
-- ==========================================
-- Uncomment to see what tables exist before/after cleanup

/*
SELECT 
    schemaname,
    tablename,
    tableowner
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY tablename;
*/

-- ==========================================
-- OPTION 5: Terminate Active Connections
-- ==========================================
-- Use this if you need to drop the database but have active connections
-- Run this from the 'postgres' database:

/*
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'nemo' AND pid <> pg_backend_pid();
*/

