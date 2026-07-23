import { useState } from 'react'
import {
  makeStyles,
  tokens,
  Text,
  Divider,
  Card,
  CardHeader,
  Spinner,
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from '@fluentui/react-components'
import { TIME_RANGES, type TimeRange } from '../hooks/usePrometheusQuery'
import { useCostOverview, useCostByModel, useCostRangeQueries } from '../hooks/useCostMetrics'
import { MetricCard, TimeSeriesChart } from '../components/dashboard'
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
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM,
  },
})

export default function CostDashboard() {
  const styles = useStyles()
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[1])

  const overview = useCostOverview(timeRange)
  const byModel = useCostByModel(timeRange)
  const rangeQueries = useCostRangeQueries(timeRange)

  const modelBreakdown = (() => {
    if (!byModel.spendByModel.data?.result) return []

    const reqMap = new Map<string, string>()
    byModel.requestsByModel.data?.result?.forEach((r) => {
      reqMap.set(r.metric.model, r.value[1])
    })
    const tokMap = new Map<string, string>()
    byModel.tokensByModel.data?.result?.forEach((r) => {
      tokMap.set(r.metric.model, r.value[1])
    })

    return byModel.spendByModel.data.result
      .map((r) => ({
        model: r.metric.model || 'unknown',
        spend: parseFloat(r.value[1]),
        requests: parseFloat(reqMap.get(r.metric.model) || '0'),
        tokens: parseFloat(tokMap.get(r.metric.model) || '0'),
      }))
      .sort((a, b) => b.spend - a.spend)
  })()

  const modelTableLoading =
    byModel.spendByModel.loading ||
    byModel.requestsByModel.loading ||
    byModel.tokensByModel.loading
  const modelTableError =
    byModel.spendByModel.error ||
    byModel.requestsByModel.error ||
    byModel.tokensByModel.error

  return (
    <div className={styles.page}>
      {/* Header */}
      <div className={styles.header}>
        <Text size={700} weight="semibold">Cost Dashboard</Text>
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

      {/* Totals */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Overview</Text>
        <div className={styles.cardRow}>
          <MetricCard
            title="Total Spend"
            data={overview.totalSpend.data}
            loading={overview.totalSpend.loading}
            error={overview.totalSpend.error}
            format={formatDollars}
          />
          <MetricCard
            title="Total Requests"
            data={overview.totalRequests.data}
            loading={overview.totalRequests.loading}
            error={overview.totalRequests.error}
            format={formatCount}
          />
          <MetricCard
            title="Input Tokens"
            data={overview.totalInputTokens.data}
            loading={overview.totalInputTokens.loading}
            error={overview.totalInputTokens.error}
            format={formatTokens}
          />
          <MetricCard
            title="Output Tokens"
            data={overview.totalOutputTokens.data}
            loading={overview.totalOutputTokens.loading}
            error={overview.totalOutputTokens.error}
            format={formatTokens}
          />
        </div>
      </div>

      <Divider />

      {/* Cost by Model table */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Cost by Model</Text>
        <Card style={{ width: '100%' }}>
          <CardHeader header={<Text weight="semibold">Model Breakdown</Text>} />
          {modelTableLoading ? (
            <Spinner size="small" />
          ) : modelTableError ? (
            <Text className={styles.error}>{modelTableError}</Text>
          ) : modelBreakdown.length === 0 ? (
            <Text className={styles.error}>No model cost data available</Text>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Model</TableHeaderCell>
                  <TableHeaderCell>Spend</TableHeaderCell>
                  <TableHeaderCell>Requests</TableHeaderCell>
                  <TableHeaderCell>Total Tokens</TableHeaderCell>
                  <TableHeaderCell>Avg Cost / Request</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelBreakdown.map((row) => (
                  <TableRow key={row.model}>
                    <TableCell>{row.model}</TableCell>
                    <TableCell>{formatDollars(row.spend)}</TableCell>
                    <TableCell>{formatCount(row.requests)}</TableCell>
                    <TableCell>{formatTokens(row.tokens)}</TableCell>
                    <TableCell>
                      {row.requests > 0
                        ? formatDollars(row.spend / row.requests)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <Divider />

      {/* Spend over time */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Spend & Usage Trends</Text>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Spend Rate by Model ($/s)"
            data={rangeQueries.spendOverTime.data}
            loading={rangeQueries.spendOverTime.loading}
            error={rangeQueries.spendOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => `$${v.toFixed(4)}`}
          />
          <TimeSeriesChart
            title="Request Rate by Model"
            data={rangeQueries.requestsOverTime.data}
            loading={rangeQueries.requestsOverTime.loading}
            error={rangeQueries.requestsOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => `${v.toFixed(1)}/s`}
          />
        </div>
        <div className={styles.chartRow}>
          <TimeSeriesChart
            title="Token Throughput by Model"
            data={rangeQueries.tokensOverTime.data}
            loading={rangeQueries.tokensOverTime.loading}
            error={rangeQueries.tokensOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => formatTokens(v) + '/s'}
          />
          <TimeSeriesChart
            title="P95 API Latency by Model"
            data={rangeQueries.latencyOverTime.data}
            loading={rangeQueries.latencyOverTime.loading}
            error={rangeQueries.latencyOverTime.error}
            labelKey="model"
            yAxisFormat={(v) => v < 1 ? `${(v * 1000).toFixed(0)}ms` : `${v.toFixed(1)}s`}
          />
        </div>
      </div>

      <Divider />

      {/* Failures */}
      <div className={styles.section}>
        <Text size={500} weight="semibold">Failures</Text>
        <TimeSeriesChart
          title="Failure Rate by Model"
          data={rangeQueries.failuresOverTime.data}
          loading={rangeQueries.failuresOverTime.loading}
          error={rangeQueries.failuresOverTime.error}
          labelKey="model"
          yAxisFormat={(v) => `${v.toFixed(2)}/s`}
        />
      </div>
    </div>
  )
}
