import { makeStyles, tokens, Card, CardHeader, Spinner, Text } from '@fluentui/react-components'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import type { MatrixResult } from '../../services/metricsApi'

const COLORS = [
  '#0078d4', '#e3008c', '#107c10', '#ca5010', '#8764b8',
  '#008272', '#d13438', '#498205', '#005b70', '#a4262c',
]

const useStyles = makeStyles({
  card: {
    width: '100%',
  },
  chart: {
    height: '280px',
    marginTop: tokens.spacingVerticalS,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM,
  },
})

interface ResourceUsageChartProps {
  title: string
  data: MatrixResult | null
  loading: boolean
  error: string | null
  labelKey?: string
  yAxisFormat?: (val: number) => string
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatBytes(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(1)} GB`
  if (val >= 1e6) return `${(val / 1e6).toFixed(0)} MB`
  if (val >= 1e3) return `${(val / 1e3).toFixed(0)} KB`
  return `${val} B`
}

export const ResourceUsageChart: React.FC<ResourceUsageChartProps> = ({
  title,
  data,
  loading,
  error,
  labelKey = 'container',
  yAxisFormat = formatBytes,
}) => {
  const styles = useStyles()

  const { series, chartData } = (() => {
    if (!data?.result?.length) return { series: [], chartData: [] }

    const allTs = new Set<number>()
    const seriesNames: string[] = []
    const valueMap = new Map<number, Record<string, number>>()

    data.result.forEach((r) => {
      const name = r.metric[labelKey] || r.metric.pod || r.metric.instance || 'value'
      seriesNames.push(name)
      r.values.forEach(([ts, v]) => {
        allTs.add(ts)
        const existing = valueMap.get(ts) || {}
        existing[name] = parseFloat(v)
        valueMap.set(ts, existing)
      })
    })

    const sorted = Array.from(allTs).sort((a, b) => a - b)
    const points = sorted.map((ts) => ({ ts, ...valueMap.get(ts) }))
    return { series: seriesNames, chartData: points }
  })()

  return (
    <Card className={styles.card}>
      <CardHeader header={<Text weight="semibold">{title}</Text>} />
      {loading ? (
        <Spinner size="small" />
      ) : error ? (
        <Text className={styles.error}>{error}</Text>
      ) : chartData.length === 0 ? (
        <Text className={styles.error}>No data available</Text>
      ) : (
        <div className={styles.chart}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={tokens.colorNeutralStroke2} />
              <XAxis
                dataKey="ts"
                tickFormatter={formatTimestamp}
                stroke={tokens.colorNeutralForeground3}
                fontSize={11}
              />
              <YAxis
                stroke={tokens.colorNeutralForeground3}
                fontSize={11}
                tickFormatter={yAxisFormat}
              />
              <Tooltip
                labelFormatter={(ts) => new Date((ts as number) * 1000).toLocaleString()}
                formatter={(value) => yAxisFormat(value as number)}
                contentStyle={{
                  backgroundColor: tokens.colorNeutralBackground1,
                  border: `1px solid ${tokens.colorNeutralStroke1}`,
                  borderRadius: '4px',
                  fontSize: '12px',
                }}
              />
              {series.length > 1 && <Legend />}
              {series.map((name, i) => (
                <Area
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={COLORS[i % COLORS.length]}
                  fill={COLORS[i % COLORS.length]}
                  fillOpacity={0.15}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  )
}
