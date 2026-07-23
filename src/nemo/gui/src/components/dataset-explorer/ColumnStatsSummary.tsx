import { useMemo } from 'react'
import { makeStyles, tokens, Text, Card, Badge, MessageBar, MessageBarBody } from '@fluentui/react-components'
import type { ColumnStat } from '../../services/api'

const useStyles = makeStyles({
  card: {
    padding: '20px',
    marginTop: '16px',
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
    marginBottom: '16px',
  },
  badgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginBottom: '20px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '24px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
    marginBottom: '4px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
  },
  colName: {
    flex: '0 0 140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: tokens.colorNeutralForeground1,
  },
  barContainer: {
    flex: '1 1 0',
    height: '14px',
    backgroundColor: tokens.colorNeutralBackground4,
    borderRadius: '3px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: '3px',
    transition: 'width 0.3s ease',
  },
  value: {
    flex: '0 0 60px',
    textAlign: 'right',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
})

interface ColumnStatsSummaryProps {
  columnStats: Record<string, ColumnStat> | null
}

export function ColumnStatsSummary({ columnStats }: ColumnStatsSummaryProps) {
  const styles = useStyles()

  const { typeCounts, nullLeaders, cardinalityLeaders, overallNullRate } = useMemo(() => {
    if (!columnStats) {
      return { typeCounts: {}, nullLeaders: [], cardinalityLeaders: [], overallNullRate: 0 }
    }

    const counts: Record<string, number> = {}
    const entries = Object.entries(columnStats)
    let totalNulls = 0
    let totalValues = 0

    for (const [, stat] of entries) {
      const cat = stat.category || 'other'
      counts[cat] = (counts[cat] || 0) + 1
      totalNulls += stat.nullCount ?? 0
      totalValues += (stat.count ?? 0) + (stat.nullCount ?? 0)
    }

    const nullSorted = entries
      .filter(([, s]) => (s.nullPercentage ?? 0) > 0)
      .sort((a, b) => (b[1].nullPercentage ?? 0) - (a[1].nullPercentage ?? 0))
      .slice(0, 5)

    const cardSorted = entries
      .filter(([, s]) => s.approxUnique != null)
      .sort((a, b) => (b[1].approxUnique ?? 0) - (a[1].approxUnique ?? 0))
      .slice(0, 5)

    return {
      typeCounts: counts,
      nullLeaders: nullSorted,
      cardinalityLeaders: cardSorted,
      overallNullRate: totalValues > 0 ? Math.round((totalNulls / totalValues) * 1000) / 10 : 0,
    }
  }, [columnStats])

  if (!columnStats || Object.keys(columnStats).length === 0) {
    return (
      <MessageBar intent="info" style={{ marginTop: '16px' }}>
        <MessageBarBody>Column statistics not available for this dataset.</MessageBarBody>
      </MessageBar>
    )
  }

  const categoryColors: Record<string, 'brand' | 'success' | 'warning' | 'danger' | 'informative' | 'important' | 'subtle'> = {
    integer: 'brand',
    float: 'brand',
    string: 'informative',
    categorical: 'success',
    temporal: 'warning',
    boolean: 'important',
    other: 'subtle',
  }

  return (
    <Card className={styles.card}>
      <Text className={styles.title}>Data Quality Summary</Text>

      {/* Column type badges */}
      <div className={styles.badgeRow}>
        {Object.entries(typeCounts).map(([cat, count]) => (
          <Badge key={cat} appearance="filled" color={categoryColors[cat] || 'subtle'}>
            {count} {cat}
          </Badge>
        ))}
        <Badge appearance="outline" color={overallNullRate > 10 ? 'warning' : 'subtle'}>
          {overallNullRate}% overall null rate
        </Badge>
      </div>

      <div className={styles.grid}>
        {/* Most-null columns */}
        {nullLeaders.length > 0 && (
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>Highest Null Rate</Text>
            {nullLeaders.map(([name, stat]) => (
              <div key={name} className={styles.row}>
                <Text className={styles.colName} title={name}>{name}</Text>
                <div className={styles.barContainer}>
                  <div
                    className={styles.barFill}
                    style={{
                      width: `${Math.min(stat.nullPercentage ?? 0, 100)}%`,
                      backgroundColor: (stat.nullPercentage ?? 0) > 50
                        ? tokens.colorPaletteRedBackground3
                        : (stat.nullPercentage ?? 0) > 20
                          ? tokens.colorPaletteYellowBackground3
                          : tokens.colorBrandBackground,
                    }}
                  />
                </div>
                <Text className={styles.value}>{(stat.nullPercentage ?? 0).toFixed(1)}%</Text>
              </div>
            ))}
          </div>
        )}

        {/* Highest cardinality columns */}
        {cardinalityLeaders.length > 0 && (
          <div className={styles.section}>
            <Text className={styles.sectionTitle}>Highest Cardinality</Text>
            {cardinalityLeaders.map(([name, stat]) => {
              const maxCard = cardinalityLeaders[0][1].approxUnique ?? 1
              const pct = maxCard > 0 ? ((stat.approxUnique ?? 0) / maxCard) * 100 : 0
              return (
                <div key={name} className={styles.row}>
                  <Text className={styles.colName} title={name}>{name}</Text>
                  <div className={styles.barContainer}>
                    <div
                      className={styles.barFill}
                      style={{
                        width: `${pct}%`,
                        backgroundColor: tokens.colorPaletteBlueBorderActive,
                      }}
                    />
                  </div>
                  <Text className={styles.value}>{(stat.approxUnique ?? 0).toLocaleString()}</Text>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Card>
  )
}
