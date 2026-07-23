-- ==========================================
-- PostgreSQL Performance Indexes for Nemo (FIXED VERSION)
-- ==========================================
-- This script creates recommended indexes to improve query performance
-- Based on analysis of TypeORM entities and query patterns
--
-- IMPORTANT: All camelCase column names MUST be quoted with double quotes
-- TypeORM preserves camelCase column names, so PostgreSQL requires quoted identifiers
--
-- Usage:
--   psql -h <host> -U <user> -d nemo -f scripts/create-performance-indexes-fixed.sql
--   Or with kubectl:
--   kubectl exec -n database <postgres-pod> -- psql -U postgres -d nemo -f - < scripts/create-performance-indexes-fixed.sql
--
-- Note: Indexes are created with IF NOT EXISTS to allow safe re-running
-- ==========================================

-- ==========================================
-- Workspaces Indexes
-- ==========================================
-- Index for status filtering (very common query pattern)
CREATE INDEX IF NOT EXISTS idx_workspaces_namespace_status 
  ON workspaces("namespaceId", status);

-- Index for template lookups
CREATE INDEX IF NOT EXISTS idx_workspaces_template_id 
  ON workspaces("templateId");

-- Index for deployment-based queries
CREATE INDEX IF NOT EXISTS idx_workspaces_deployment_id 
  ON workspaces("deploymentId") 
  WHERE "deploymentId" IS NOT NULL;

-- Index for expiration/cleanup queries
CREATE INDEX IF NOT EXISTS idx_workspaces_last_accessed 
  ON workspaces("lastAccessedAt") 
  WHERE "lastAccessedAt" IS NOT NULL;

-- ==========================================
-- Deployment Assignments Indexes
-- ==========================================
-- Index for deployment-based lookups (very common)
CREATE INDEX IF NOT EXISTS idx_deployment_assignments_deployment_id 
  ON deployment_assignments(deployment_id, status);

-- Index for bucket-based lookups (very common)
CREATE INDEX IF NOT EXISTS idx_deployment_assignments_bucket 
  ON deployment_assignments(namespace_id, bucket_name, status);

-- Index for priority-based ordering
CREATE INDEX IF NOT EXISTS idx_deployment_assignments_priority 
  ON deployment_assignments(namespace_id, bucket_name, priority);

-- ==========================================
-- Metrics Indexes
-- ==========================================
-- Index for time-range queries (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_metrics_deployment_timestamp 
  ON metrics(deployment_id, timestamp DESC);

-- Index for recent metrics queries
CREATE INDEX IF NOT EXISTS idx_metrics_timestamp 
  ON metrics(timestamp DESC);

-- ==========================================
-- Health Reports Indexes
-- ==========================================
-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_health_reports_deployment_timestamp 
  ON health_reports(deployment_id, timestamp DESC);

-- Index for health status filtering
CREATE INDEX IF NOT EXISTS idx_health_reports_healthy 
  ON health_reports(deployment_id, healthy, timestamp DESC);

-- ==========================================
-- Bucket Health Indexes
-- ==========================================
-- Index for time-based queries (get latest health for bucket+deployment)
CREATE INDEX IF NOT EXISTS idx_bucket_health_timestamp 
  ON bucket_health(namespace_id, bucket_name, deployment_id, timestamp DESC);

-- ==========================================
-- Data Set Manifests Indexes
-- ==========================================
-- Index for status filtering (very common - finding draft manifests)
CREATE INDEX IF NOT EXISTS idx_manifests_dataset_status 
  ON data_set_manifests("dataSetId", status);

-- Index for latest manifest queries
CREATE INDEX IF NOT EXISTS idx_manifests_dataset_created 
  ON data_set_manifests("dataSetId", "createdAt" DESC);

-- ==========================================
-- Data Set Manifest Files Indexes
-- ==========================================
-- Index for manifest file lookups (very common)
CREATE INDEX IF NOT EXISTS idx_manifest_files_manifest_id 
  ON data_set_manifest_files("manifestId");

-- Index for file name lookups (duplicate detection)
CREATE INDEX IF NOT EXISTS idx_manifest_files_name 
  ON data_set_manifest_files("manifestId", "fileName");

-- ==========================================
-- Analytics Sessions Indexes
-- ==========================================
-- Index for deployment-based queries
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_deployment 
  ON analytics_sessions("deploymentId") 
  WHERE "deploymentId" IS NOT NULL;

-- Index for status-based active session queries
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_active_status 
  ON analytics_sessions(status) 
  WHERE status IN ('pending', 'initializing', 'processing', 'ready');

-- Index for expiration cleanup queries
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_expires 
  ON analytics_sessions("expiresAt") 
  WHERE "expiresAt" IS NOT NULL;

-- ==========================================
-- Buckets Indexes
-- ==========================================
-- Index for region-based queries
CREATE INDEX IF NOT EXISTS idx_buckets_region 
  ON buckets(region);

-- ==========================================
-- Deployments Indexes
-- ==========================================
-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_deployments_status 
  ON deployments(status);

-- Index for region-based queries
CREATE INDEX IF NOT EXISTS idx_deployments_region 
  ON deployments(region);

-- Index for health check queries
CREATE INDEX IF NOT EXISTS idx_deployments_last_health_check 
  ON deployments(last_health_check) 
  WHERE last_health_check IS NOT NULL;

-- ==========================================
-- Verification
-- ==========================================
-- List all indexes created by this script
SELECT 
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
ORDER BY tablename, indexname;

