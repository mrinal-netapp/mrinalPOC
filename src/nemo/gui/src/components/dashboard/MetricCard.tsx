import { makeStyles, tokens, Card, CardHeader, Spinner, Text } from '@fluentui/react-components'
import { ResponsiveContainer, AreaChart, Area } from 'recharts'
import type { VectorResult, MatrixResult } from '../../services/metricsApi'

const useStyles = makeStyles({
  card: {
    minWidth: '200px',
    flex: '1 1 200px',
  },
  value: {
    fontSize: tokens.fontSizeHero800,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightHero800,
  },
  label: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  sparkline: {
    height: '40px',
    marginTop: tokens.spacingVerticalS,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
  },
})

interface MetricCardProps {
  title: string
  data: VectorResult | null
  loading: boolean
  error: string | null
  format?: (val: number) => string
  sparklineData?: MatrixResult | null
}

function defaultFormat(val: number): string {
  if (val >= 1e9) return `${(val / 1e9).toFixed(1)}G`
  if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`
  return val % 1 === 0 ? val.toString() : val.toFixed(2)
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  data,
  loading,
  error,
  format = defaultFormat,
  sparklineData,
}) => {
  const styles = useStyles()

  const value = data?.result?.[0]?.value?.[1]
  const numericValue = value !== undefined ? parseFloat(value) : null

  const sparkPoints = sparklineData?.result?.[0]?.values?.map(([ts, v]) => ({
    ts,
    v: parseFloat(v),
  }))

  return (
    <Card className={styles.card}>
      <CardHeader header={<Text className={styles.label}>{title}</Text>} />
      {loading ? (
        <Spinner size="small" />
      ) : error ? (
        <Text className={styles.error}>{error}</Text>
      ) : (
        <>
          <Text className={styles.value}>
            {numericValue !== null ? format(numericValue) : '—'}
          </Text>
          {sparkPoints && sparkPoints.length > 1 && (
            <div className={styles.sparkline}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparkPoints}>
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={tokens.colorBrandForeground1}
                    fill={tokens.colorBrandBackground2}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
