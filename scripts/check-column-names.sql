-- Script to check actual column names in the database
-- This helps identify if columns are camelCase or snake_case

SELECT 
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'workspaces',
    'data_set_manifests',
    'data_set_manifest_files',
    'analytics_sessions'
  )
  AND (
    column_name LIKE '%Id%' OR
    column_name LIKE '%At%' OR
    column_name LIKE '%Name%'
  )
ORDER BY table_name, column_name;

