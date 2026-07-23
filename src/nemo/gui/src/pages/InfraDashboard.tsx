import { useState } from 'react'
import {
  makeStyles,
  tokens,
  Text,
  Divider,
} from '@fluentui/react-components'
import { TIME_RANGES, type TimeRange } from '../hooks/usePrometheusQuery'
import {
  usePostgresMetrics,
  useRedisMetrics,
  useTemporalMetrics,
  useInfraRangeQueries,
} from '../hooks/useInfraMetrics'
import { MetricCard, TimeSeriesChart } from '../components/dashboard'

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXXL,
    maxWidth: '1400px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeSelector: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
  },
  timeButton: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground1,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  timeButtonActive: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground2,
    cursor: 'pointer',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  cardRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  chartRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
    '> *': {
      flex: '1 1 45%',
      minWidth: '400px',
    },
  },
})

function formatBytes(val: number): string {
  if (val >= 1e12) return `${(val / 1e12).toFixed(1)} TB`
  if (val >= 1e9) return `${(val / 1e9).toFixed(1)} GB`
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)} MB`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)} KB`
  return `${val.toFixed(0)} B`
}

function formatRate(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M/s`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K/s`
  if (val >= 1) return `${val.toFixed(1)}/s`
  if (val >= 0.01) return `${val.toFixed(2)}/s`
  if (val > 0) return `< 0.01/s`
  return `0/s`
}

function formatLatency(val: number): string {
  if (val < 0.001) return `${(val * 1e6).toFixed(0)}µs`
  if (val < 1) return `${(val * 1000).toFixed(0)}ms`
  return `${val.toFixed(2)}s`
}

function formatPercent(val: number): string {
  if (isNaN(val)) return '—'
  return `${(val * 100).toFixed(1)}%`
}

function formatCount(val: number): string {
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`
  return val % 1 === 0 ? val.toString() : val.toFixed(2)
}

function statusFormat(val: number): string {
  return val === 1 ? 'Up' : 'Down'
}

export default function InfraDashboard() {
  const styles = useStyles()
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[1])

  const pg = usePostgresMetrics()
  const redis = useRedisMetrics()
  const temporal = useTemporalMetrics()
  const range = useInfraRangeQueries(timeRange)

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Text size={700} weight="semibold">Infrastructure</Text>
        <div className={styles.timeSelector}>
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.label}
              className={tr.label === timeRange.label ? styles.timeButtonActive : styles.timeButton}
              onClick={() => setTimeRange(tr)}
            >
              {tr.label}
            </button>
          ))}
        </div>
      </div>

      <Divider />

      {/* PostgreSQL */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">PostgreSQL</Text>
        <div className={styles.cardRow}>
          <MetricCard
            title="Status"
            data={pg.up.data}
            loading={pg.up.loading}
            error={pg.up.error}
            format={statusFormat}
          />
          <MetricCard
            title="Active Connections"
            data={pg.activeConnections.data}
            loading={pg.activeConnections.loading}
            error={pg.activeConnections.error}
            format={formatCount}
          />
          <MetricCard
            title="Max Connections"
            data={pg.maxConnections.data}
            loading={pg.maxConnections.loading}
            error={pg.maxConnections.error}
            format={formatCount}
          />
          <MetricCard
            title="Database Size"
            data={pg.dbSize.data}
            loading={pg.dbSize.loading}
            error={pg.dbSize.error}
            format={formatBytes}
          />
          <MetricCard
            title="Cache Hit Ratio"
            data={pg.cacheHitRatio.data}
            loading={pg.cacheHitRatio.loading}
            error={pg.cacheHitRatio.error}
            format={formatPercent}
          />
          <MetricCard
            title="TX Commit Rate"
            data={pg.txRate.data}
            loading={pg.txRate.loading}
            error={pg.txRate.error}
            format={formatRate}
          />
        </div>
        <div className={styles.cardRow}>
          <MetricCard
            title="Rollback Rate"
            data={pg.rollbackRate.data}
            loading={pg.rollbackRate.loading}
            error={pg.rollbackRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Rows Fetched/s"
            data={pg.tupFetchedRate.data}
            loading={pg.tupFetchedRate.loading}
            error={pg.tupFetchedRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Rows Inserted/s"
            data={pg.tupInsertRate.data}
            loading={pg.tupInsertRate.loading}
            error={pg.tupInsertRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Rows Updated/s"
            data={pg.tupUpdateRate.data}
            loading={pg.tupUpdateRate.loading}
            error={pg.tupUpdateRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Temp Bytes Written/s"
            data={pg.tempBytes.data}
            loading={pg.tempBytes.loading}
            error={pg.tempBytes.error}
            format={formatBytes}
          />
          <MetricCard
            title="Deadlocks/s"
            data={pg.deadlocks.data}
            loading={pg.deadlocks.loading}
            error={pg.deadlocks.error}
            format={formatRate}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Active Connections"
            data={range.pgConnections.data}
            loading={range.pgConnections.loading}
            error={range.pgConnections.error}
            yAxisFormat={(v) => formatCount(v)}
          />
          <TimeSeriesChart
            title="Cache Hit Ratio"
            data={range.pgCacheHitRatio.data}
            loading={range.pgCacheHitRatio.loading}
            error={range.pgCacheHitRatio.error}
            yAxisFormat={(v) => formatPercent(v)}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Transaction Commit Rate"
            data={range.pgTxRate.data}
            loading={range.pgTxRate.loading}
            error={range.pgTxRate.error}
            yAxisFormat={(v) => formatRate(v)}
          />
          <TimeSeriesChart
            title="Rows Fetched/s"
            data={range.pgTupleOps.data}
            loading={range.pgTupleOps.loading}
            error={range.pgTupleOps.error}
            yAxisFormat={(v) => formatRate(v)}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Rollback Rate"
            data={range.pgRollbackRate.data}
            loading={range.pgRollbackRate.loading}
            error={range.pgRollbackRate.error}
            yAxisFormat={(v) => formatRate(v)}
          />
          <TimeSeriesChart
            title="Temp Bytes Written/s"
            data={range.pgTempBytes.data}
            loading={range.pgTempBytes.loading}
            error={range.pgTempBytes.error}
            yAxisFormat={(v) => formatBytes(v)}
          />
        </div>
      </div>

      <Divider />

      {/* Redis */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Redis</Text>
        <div className={styles.cardRow}>
          <MetricCard
            title="Status"
            data={redis.up.data}
            loading={redis.up.loading}
            error={redis.up.error}
            format={statusFormat}
          />
          <MetricCard
            title="Connected Clients"
            data={redis.connectedClients.data}
            loading={redis.connectedClients.loading}
            error={redis.connectedClients.error}
            format={formatCount}
          />
          <MetricCard
            title="Memory Usage"
            data={redis.usedMemory.data}
            loading={redis.usedMemory.loading}
            error={redis.usedMemory.error}
            format={formatBytes}
          />
          <MetricCard
            title="Commands/sec"
            data={redis.commandsPerSec.data}
            loading={redis.commandsPerSec.loading}
            error={redis.commandsPerSec.error}
            format={formatRate}
          />
          <MetricCard
            title="Cache Hit Ratio"
            data={redis.cacheHitRatio.data}
            loading={redis.cacheHitRatio.loading}
            error={redis.cacheHitRatio.error}
            format={formatPercent}
          />
          <MetricCard
            title="Blocked Clients"
            data={redis.blockedClients.data}
            loading={redis.blockedClients.loading}
            error={redis.blockedClients.error}
            format={formatCount}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Memory Usage"
            data={range.redisMemory.data}
            loading={range.redisMemory.loading}
            error={range.redisMemory.error}
            yAxisFormat={(v) => formatBytes(v)}
          />
          <TimeSeriesChart
            title="Commands/sec"
            data={range.redisCommandsPerSec.data}
            loading={range.redisCommandsPerSec.loading}
            error={range.redisCommandsPerSec.error}
            yAxisFormat={(v) => formatRate(v)}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Cache Hit Ratio"
            data={range.redisCacheHitRatio.data}
            loading={range.redisCacheHitRatio.loading}
            error={range.redisCacheHitRatio.error}
            yAxisFormat={(v) => formatPercent(v)}
          />
        </div>
      </div>

      <Divider />

      {/* Temporal */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Temporal</Text>
        <div className={styles.cardRow}>
          <MetricCard
            title="Request Rate"
            data={temporal.requestRate.data}
            loading={temporal.requestRate.loading}
            error={temporal.requestRate.error}
            format={formatRate}
          />
          <MetricCard
            title="P95 Latency"
            data={temporal.p95Latency.data}
            loading={temporal.p95Latency.loading}
            error={temporal.p95Latency.error}
            format={formatLatency}
          />
          <MetricCard
            title="Error Rate"
            data={temporal.errorRate.data}
            loading={temporal.errorRate.loading}
            error={temporal.errorRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Persistence Rate"
            data={temporal.persistenceRate.data}
            loading={temporal.persistenceRate.loading}
            error={temporal.persistenceRate.error}
            format={formatRate}
          />
          <MetricCard
            title="P95 Persistence Latency"
            data={temporal.p95PersistenceLatency.data}
            loading={temporal.p95PersistenceLatency.loading}
            error={temporal.p95PersistenceLatency.error}
            format={formatLatency}
          />
          <MetricCard
            title="P95 Schedule-to-Start"
            data={temporal.p95ScheduleToStart.data}
            loading={temporal.p95ScheduleToStart.loading}
            error={temporal.p95ScheduleToStart.error}
            format={formatLatency}
          />
        </div>
        <div className={styles.cardRow}>
          <MetricCard
            title="Workflows Completed/s"
            data={temporal.workflowStartedRate.data}
            loading={temporal.workflowStartedRate.loading}
            error={temporal.workflowStartedRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Workflows Failed/s"
            data={temporal.workflowFailedRate.data}
            loading={temporal.workflowFailedRate.loading}
            error={temporal.workflowFailedRate.error}
            format={formatRate}
          />
          <MetricCard
            title="Workflows Canceled/s"
            data={temporal.workflowCanceledRate.data}
            loading={temporal.workflowCanceledRate.loading}
            error={temporal.workflowCanceledRate.error}
            format={formatRate}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Request Rate"
            data={range.temporalRequestRate.data}
            loading={range.temporalRequestRate.loading}
            error={range.temporalRequestRate.error}
            yAxisFormat={(v) => formatRate(v)}
          />
          <TimeSeriesChart
            title="P95 Service Latency"
            data={range.temporalLatency.data}
            loading={range.temporalLatency.loading}
            error={range.temporalLatency.error}
            yAxisFormat={(v) => formatLatency(v)}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Error Rate"
            data={range.temporalErrors.data}
            loading={range.temporalErrors.loading}
            error={range.temporalErrors.error}
            yAxisFormat={(v) => formatRate(v)}
          />
          <TimeSeriesChart
            title="P95 Persistence Latency"
            data={range.temporalPersistenceLatency.data}
            loading={range.temporalPersistenceLatency.loading}
            error={range.temporalPersistenceLatency.error}
            yAxisFormat={(v) => formatLatency(v)}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Workflow Completions/s"
            data={range.temporalWorkflowRate.data}
            loading={range.temporalWorkflowRate.loading}
            error={range.temporalWorkflowRate.error}
            yAxisFormat={(v) => formatRate(v)}
          />
          <TimeSeriesChart
            title="P95 Schedule-to-Start Latency"
            data={range.temporalScheduleToStart.data}
            loading={range.temporalScheduleToStart.loading}
            error={range.temporalScheduleToStart.error}
            yAxisFormat={(v) => formatLatency(v)}
          />
        </div>
      </div>
    </div>
  )
}
