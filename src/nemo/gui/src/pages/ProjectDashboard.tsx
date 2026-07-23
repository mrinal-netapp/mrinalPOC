import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { makeStyles, tokens, Text, Divider, Button } from '@fluentui/react-components'
import { ArrowRight24Regular } from '@fluentui/react-icons'
import {
  useClusterMetrics,
  useServiceMetrics,
  usePrometheusRangeQuery,
  TIME_RANGES,
  k8sMetricsNamespaceSelector,
  type TimeRange,
} from '../hooks/usePrometheusQuery'
import { useCostOverview, useCostRangeQueries } from '../hooks/useCostMetrics'
import { MetricCard, TimeSeriesChart, ServiceHealthTable, ResourceUsageChart } from '../components/dashboard'
import { formatCount, formatDollars, formatTokens } from '../utils/costFormat'

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
  sectionHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
})

function formatCpuCores(val: number): string {
  if (val < 0.01) return `${(val * 1000).toFixed(0)}m`
  return `${val.toFixed(2)} cores`
}

function formatBytes(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(1)} GB`
  if (val >= 1e6) return `${(val / 1e6).toFixed(0)} MB`
  if (val >= 1e3) return `${(val / 1e3).toFixed(0)} KB`
  return `${val} B`
}

function formatRps(val: number): string {
  return `${val.toFixed(2)} req/s`
}

function formatPercent(val: number): string {
  return `${(val * 100).toFixed(1)}%`
}

export default function ProjectDashboard() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[1]) // default 1h
  const nsSel = k8sMetricsNamespaceSelector()
  const containerFilter = `${nsSel},container!="POD",container!=""`

  const cluster = useClusterMetrics()
  const svcMetrics = useServiceMetrics()
  const costOverview = useCostOverview(timeRange)
  const costTrends = useCostRangeQueries(timeRange)

  // Range queries for charts
  const requestRateRange = usePrometheusRangeQuery(
    `sum(rate(http_requests_total{${nsSel}}[5m])) by (job)`,
    timeRange,
  )
  const errorRateRange = usePrometheusRangeQuery(
    `sum(rate(http_requests_total{${nsSel},status=~"5.."}[5m])) by (job)`,
    timeRange,
  )
  const cpuRange = usePrometheusRangeQuery(
    `sum(rate(container_cpu_usage_seconds_total{${containerFilter}}[5m])) by (container)`,
    timeRange,
  )
  const memRange = usePrometheusRangeQuery(
    `sum(container_memory_working_set_bytes{${containerFilter}}) by (container)`,
    timeRange,
  )

  // Domain-specific range queries
  const flightsqlRange = usePrometheusRangeQuery(
    'rate(flightsql_queries_total[5m])',
    timeRange,
  )
  const cacheHitRange = usePrometheusRangeQuery(
    'rate(query_cache_hits_total[5m]) / (rate(query_cache_hits_total[5m]) + rate(query_cache_misses_total[5m]))',
    timeRange,
  )

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <Text size={700} weight="semibold">Observability Dashboard</Text>
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

      {/* Cluster Overview */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Cluster Overview</Text>
        <div className={styles.cardRow}>
          <MetricCard
            title="Running Pods"
            data={cluster.podCount.data}
            loading={cluster.podCount.loading}
            error={cluster.podCount.error}
          />
          <MetricCard
            title="Total CPU Usage"
            data={cluster.cpuUsage.data}
            loading={cluster.cpuUsage.loading}
            error={cluster.cpuUsage.error}
            format={formatCpuCores}
          />
          <MetricCard
            title="Total Memory Usage"
            data={cluster.memoryUsage.data}
            loading={cluster.memoryUsage.loading}
            error={cluster.memoryUsage.error}
            format={formatBytes}
          />
          <MetricCard
            title="Overall Request Rate"
            data={cluster.requestRate.data}
            loading={cluster.requestRate.loading}
            error={cluster.requestRate.error}
            format={formatRps}
          />
        </div>
      </div>

      <Divider />

      {/* Service Health */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Service Health</Text>
        <ServiceHealthTable
          upStatus={svcMetrics.upStatus}
          requestRate={svcMetrics.requestRate}
          errorRate={svcMetrics.errorRate}
          p95Latency={svcMetrics.p95Latency}
        />
      </div>

      <Divider />

      {/* HTTP Traffic */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">HTTP Traffic</Text>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Request Rate by Service"
            data={requestRateRange.data}
            loading={requestRateRange.loading}
            error={requestRateRange.error}
            yAxisFormat={(v) => `${v.toFixed(1)}/s`}
          />
          <TimeSeriesChart
            title="Error Rate (5xx) by Service"
            data={errorRateRange.data}
            loading={errorRateRange.loading}
            error={errorRateRange.error}
            yAxisFormat={(v) => `${v.toFixed(2)}/s`}
          />
        </div>
      </div>

      <Divider />

      {/* Resource Usage */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Resource Usage</Text>
        <div className={styles.chartRow}>
          <ResourceUsageChart
            title="CPU Usage by Container"
            data={cpuRange.data}
            loading={cpuRange.loading}
            error={cpuRange.error}
            yAxisFormat={formatCpuCores}
          />
          <ResourceUsageChart
            title="Memory Usage by Container"
            data={memRange.data}
            loading={memRange.loading}
            error={memRange.error}
            yAxisFormat={formatBytes}
          />
        </div>
      </div>

      <Divider />

      {/* LLM gateway cost (Bifrost /prometheus via apigateway) */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Text size={500} weight="semibold">LLM Gateway Cost</Text>
          {projectId && (
            <Link to={`/projects/${projectId}/cost`} style={{ textDecoration: 'none' }}>
              <Button
                appearance="subtle"
                icon={<ArrowRight24Regular />}
                iconPosition="after"
              >
                Full cost dashboard
              </Button>
            </Link>
          )}
        </div>
        <div className={styles.cardRow}>
          <MetricCard
            title="Total Spend"
            data={costOverview.totalSpend.data}
            loading={costOverview.totalSpend.loading}
            error={costOverview.totalSpend.error}
            format={formatDollars}
          />
          <MetricCard
            title="LLM Requests"
            data={costOverview.totalRequests.data}
            loading={costOverview.totalRequests.loading}
            error={costOverview.totalRequests.error}
            format={formatCount}
          />
          <MetricCard
            title="Input Tokens"
            data={costOverview.totalInputTokens.data}
            loading={costOverview.totalInputTokens.loading}
            error={costOverview.totalInputTokens.error}
            format={formatTokens}
          />
          <MetricCard
            title="Output Tokens"
            data={costOverview.totalOutputTokens.data}
            loading={costOverview.totalOutputTokens.loading}
            error={costOverview.totalOutputTokens.error}
            format={formatTokens}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Spend Rate by Model ($/s)"
            data={costTrends.spendOverTime.data}
            loading={costTrends.spendOverTime.loading}
            error={costTrends.spendOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => `$${v.toFixed(4)}`}
          />
          <TimeSeriesChart
            title="Request Rate by Model"
            data={costTrends.requestsOverTime.data}
            loading={costTrends.requestsOverTime.loading}
            error={costTrends.requestsOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => `${v.toFixed(1)}/s`}
          />
        </div>
      </div>

      <Divider />

      {/* Analytics Engine */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Analytics Engine</Text>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="FlightSQL Query Rate"
            data={flightsqlRange.data}
            loading={flightsqlRange.loading}
            error={flightsqlRange.error}
            yAxisFormat={(v) => `${v.toFixed(1)}/s`}
          />
          <TimeSeriesChart
            title="Cache Hit Ratio"
            data={cacheHitRange.data}
            loading={cacheHitRange.loading}
            error={cacheHitRange.error}
            yAxisFormat={formatPercent}
          />
        </div>
      </div>
    </div>
  )
}
