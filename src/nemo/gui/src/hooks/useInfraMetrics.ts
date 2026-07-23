import { usePrometheusQuery, usePrometheusRangeQuery, type TimeRange } from './usePrometheusQuery'

export function usePostgresMetrics() {
  const up = usePrometheusQuery('pg_up')
  const activeConnections = usePrometheusQuery(
    'sum(pg_stat_activity_count)',
  )
  const maxConnections = usePrometheusQuery('pg_settings_max_connections')
  const dbSize = usePrometheusQuery('sum(pg_database_size_bytes)')
  const txRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_xact_commit[5m]))',
  )
  const deadlocks = usePrometheusQuery(
    'sum(rate(pg_stat_database_deadlocks[5m]))',
  )
  const cacheHitRatio = usePrometheusQuery(
    'sum(pg_stat_database_blks_hit) / (sum(pg_stat_database_blks_hit) + sum(pg_stat_database_blks_read))',
  )
  const rollbackRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_xact_rollback[5m]))',
  )
  const tupInsertRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_tup_inserted[5m]))',
  )
  const tupUpdateRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_tup_updated[5m]))',
  )
  const tupDeleteRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_tup_deleted[5m]))',
  )
  const tupFetchedRate = usePrometheusQuery(
    'sum(rate(pg_stat_database_tup_fetched[5m]))',
  )
  const tempBytes = usePrometheusQuery(
    'sum(rate(pg_stat_database_temp_bytes[5m]))',
  )
  const conflicts = usePrometheusQuery(
    'sum(rate(pg_stat_database_conflicts[5m]))',
  )

  return {
    up,
    activeConnections,
    maxConnections,
    dbSize,
    txRate,
    deadlocks,
    cacheHitRatio,
    rollbackRate,
    tupInsertRate,
    tupUpdateRate,
    tupDeleteRate,
    tupFetchedRate,
    tempBytes,
    conflicts,
    loading:
      up.loading ||
      activeConnections.loading ||
      maxConnections.loading ||
      dbSize.loading ||
      txRate.loading ||
      deadlocks.loading,
  }
}

export function useRedisMetrics() {
  const up = usePrometheusQuery('redis_up')
  const connectedClients = usePrometheusQuery('redis_connected_clients')
  const usedMemory = usePrometheusQuery('redis_used_memory_bytes')
  const commandsPerSec = usePrometheusQuery(
    'rate(redis_commands_processed_total[5m])',
  )
  const cacheHitRatio = usePrometheusQuery(
    'rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))',
  )
  const blockedClients = usePrometheusQuery('redis_blocked_clients')
  const evictedKeys = usePrometheusQuery(
    'rate(redis_evicted_keys_total[5m])',
  )

  return {
    up,
    connectedClients,
    usedMemory,
    commandsPerSec,
    cacheHitRatio,
    blockedClients,
    evictedKeys,
    loading:
      up.loading ||
      connectedClients.loading ||
      usedMemory.loading ||
      commandsPerSec.loading ||
      cacheHitRatio.loading ||
      blockedClients.loading ||
      evictedKeys.loading,
  }
}

export function useTemporalMetrics() {
  const requestRate = usePrometheusQuery(
    'sum(rate(service_requests[5m]))',
  )
  const p95Latency = usePrometheusQuery(
    'histogram_quantile(0.95, sum(rate(service_latency_bucket[5m])) by (le)) / 1000',
  )
  const persistenceRate = usePrometheusQuery(
    'sum(rate(persistence_requests[5m]))',
  )
  const errorRate = usePrometheusQuery(
    'sum(rate(service_errors[5m]))',
  )
  const p95PersistenceLatency = usePrometheusQuery(
    'histogram_quantile(0.95, sum(rate(persistence_latency_bucket[5m])) by (le)) / 1000',
  )
  const workflowStartedRate = usePrometheusQuery(
    'sum(rate(workflow_success[5m]))',
  )
  const workflowFailedRate = usePrometheusQuery(
    'sum(rate(workflow_failed[5m]))',
  )
  const workflowCanceledRate = usePrometheusQuery(
    'sum(rate(workflow_cancel[5m]))',
  )
  const p95ScheduleToStart = usePrometheusQuery(
    'histogram_quantile(0.95, sum(rate(schedule_to_start_latency_bucket[5m])) by (le)) / 1000',
  )

  return {
    requestRate,
    p95Latency,
    persistenceRate,
    errorRate,
    p95PersistenceLatency,
    workflowStartedRate,
    workflowFailedRate,
    workflowCanceledRate,
    p95ScheduleToStart,
    loading:
      requestRate.loading || p95Latency.loading || persistenceRate.loading,
  }
}

export function useInfraRangeQueries(timeRange: TimeRange) {
  const pgConnections = usePrometheusRangeQuery(
    'sum(pg_stat_activity_count)',
    timeRange,
  )
  const pgTxRate = usePrometheusRangeQuery(
    'sum(rate(pg_stat_database_xact_commit[5m]))',
    timeRange,
  )

  const redisMemory = usePrometheusRangeQuery(
    'redis_used_memory_bytes',
    timeRange,
  )
  const redisCommandsPerSec = usePrometheusRangeQuery(
    'rate(redis_commands_processed_total[5m])',
    timeRange,
  )
  const redisCacheHitRatio = usePrometheusRangeQuery(
    'rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m]))',
    timeRange,
  )

  const pgCacheHitRatio = usePrometheusRangeQuery(
    'sum(pg_stat_database_blks_hit) / (sum(pg_stat_database_blks_hit) + sum(pg_stat_database_blks_read))',
    timeRange,
  )
  const pgTupleOps = usePrometheusRangeQuery(
    'sum(rate(pg_stat_database_tup_fetched[5m]))',
    timeRange,
  )
  const pgRollbackRate = usePrometheusRangeQuery(
    'sum(rate(pg_stat_database_xact_rollback[5m]))',
    timeRange,
  )
  const pgTempBytes = usePrometheusRangeQuery(
    'sum(rate(pg_stat_database_temp_bytes[5m]))',
    timeRange,
  )

  const temporalRequestRate = usePrometheusRangeQuery(
    'sum(rate(service_requests[5m]))',
    timeRange,
  )
  const temporalLatency = usePrometheusRangeQuery(
    'histogram_quantile(0.95, sum(rate(service_latency_bucket[5m])) by (le)) / 1000',
    timeRange,
  )
  const temporalErrors = usePrometheusRangeQuery(
    'sum(rate(service_errors[5m]))',
    timeRange,
  )
  const temporalPersistenceLatency = usePrometheusRangeQuery(
    'histogram_quantile(0.95, sum(rate(persistence_latency_bucket[5m])) by (le)) / 1000',
    timeRange,
  )
  const temporalWorkflowRate = usePrometheusRangeQuery(
    'sum(rate(workflow_success[5m]))',
    timeRange,
  )
  const temporalScheduleToStart = usePrometheusRangeQuery(
    'histogram_quantile(0.95, sum(rate(schedule_to_start_latency_bucket[5m])) by (le)) / 1000',
    timeRange,
  )

  return {
    pgConnections,
    pgTxRate,
    pgCacheHitRatio,
    pgTupleOps,
    pgRollbackRate,
    pgTempBytes,
    redisMemory,
    redisCommandsPerSec,
    redisCacheHitRatio,
    temporalRequestRate,
    temporalLatency,
    temporalErrors,
    temporalPersistenceLatency,
    temporalWorkflowRate,
    temporalScheduleToStart,
  }
}
