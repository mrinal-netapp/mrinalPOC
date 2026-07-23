import { makeStyles, tokens, Text, Skeleton, SkeletonItem } from '@fluentui/react-components'
import { BarChart, Bar, Tooltip, ResponsiveContainer } from 'recharts'
import { classifyDuckDBType, isNumericCategory } from '../../utils/duckdb-types'
import type { ColumnStat } from '../../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minHeight: '28px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  statLine: {
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    lineHeight: '14px',
  },
  chartContainer: {
    width: '100%',
    height: '40px',
    marginTop: '2px',
  },
})

interface ColumnStatsHeaderProps {
  stats?: ColumnStat
}

export function ColumnStatsHeader({ stats }: ColumnStatsHeaderProps) {
  const styles = useStyles()

  if (!stats) {
    return (
      <div className={styles.container}>
        <Skeleton>
          <SkeletonItem size={12} style={{ width: '80px' }} />
        </Skeleton>
      </div>
    )
  }

  const category = stats.category || classifyDuckDBType(stats.type)

  const nullSuffix = (parts: string[]) => {
    if (stats.nullPercentage != null && stats.nullPercentage > 0) {
      parts.push(`${stats.nullPercentage.toFixed(1)}% null`)
    }
  }

  const formatStat = (): string => {
    const parts: string[] = []

    switch (category) {
      case 'categorical':
        if (stats.approxUnique != null) parts.push(`${stats.approxUnique} unique`)
        nullSuffix(parts)
        break

      case 'string':
        if (stats.approxUnique != null) parts.push(`${stats.approxUnique} unique`)
        if (stats.avgLength != null) parts.push(`avg len ${Math.round(stats.avgLength)} chars`)
        nullSuffix(parts)
        break

      case 'integer':
        if (stats.min != null && stats.max != null) parts.push(`${stats.min}–${stats.max}`)
        if (stats.median != null) parts.push(`median ${stats.median}`)
        else if (stats.q50 != null) parts.push(`median ${stats.q50}`)
        nullSuffix(parts)
        break

      case 'float':
        if (stats.min != null && stats.max != null) {
          const fmtNum = (s: string) => {
            const n = Number(s)
            return isNaN(n) ? s : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
          }
          parts.push(`${fmtNum(stats.min)}–${fmtNum(stats.max)}`)
        }
        nullSuffix(parts)
        break

      case 'temporal': {
        if (stats.min != null && stats.max != null) {
          const fmtDate = (s: string) => {
            const d = new Date(s)
            return isNaN(d.getTime()) ? s : d.toLocaleDateString()
          }
          parts.push(`${fmtDate(stats.min)}–${fmtDate(stats.max)}`)
        }
        nullSuffix(parts)
        break
      }

      case 'boolean':
        if (stats.truePercentage != null) parts.push(`${stats.truePercentage}% true`)
        nullSuffix(parts)
        break

      default:
        if (stats.approxUnique != null) parts.push(`${stats.approxUnique} unique`)
        if (isNumericCategory(category) && stats.min != null && stats.max != null) {
          parts.push(`${stats.min}–${stats.max}`)
        }
        nullSuffix(parts)
    }

    return parts.join(', ') || stats.type
  }

  const renderHistogram = () => {
    if (!stats.histogram || stats.histogram.length === 0) return null

    return (
      <div className={styles.chartContainer}>
        <ResponsiveContainer width="100%" height={40}>
          <BarChart data={stats.histogram} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Tooltip
              contentStyle={{ fontSize: '11px', padding: '4px 8px' }}
              formatter={(value) => [String(value), 'Count']}
              labelFormatter={(label) => String(label)}
            />
            <Bar dataKey="count" fill={tokens.colorBrandBackground} radius={[1, 1, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <Text className={styles.statLine} title={formatStat()}>
        {formatStat()}
      </Text>
      {renderHistogram()}
    </div>
  )
}
