import { makeStyles, tokens, Text, Card, MessageBar, MessageBarBody } from '@fluentui/react-components'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import type { FileStatsFacet } from '../../services/api'

const COLORS = [
  tokens.colorBrandBackground,
  tokens.colorPaletteBlueBorderActive,
  tokens.colorPaletteGreenBorderActive,
  tokens.colorPaletteYellowBorderActive,
  tokens.colorPaletteRedBorderActive,
  tokens.colorPaletteBerryBorderActive,
  tokens.colorPaletteMarigoldBorderActive,
  tokens.colorPaletteTealBorderActive,
  tokens.colorPalettePurpleBorderActive,
  tokens.colorNeutralForeground3,
]

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
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '24px',
    marginBottom: '24px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
  },
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground2,
    marginBottom: '8px',
  },
  chartWrap: {
    width: '100%',
    height: '220px',
  },
  fullWidth: {
    marginTop: '8px',
  },
  legendRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginTop: '8px',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground2,
  },
  legendDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
})

interface FileDistributionChartsProps {
  stats: FileStatsFacet | null
}

export function FileDistributionCharts({ stats }: FileDistributionChartsProps) {
  const styles = useStyles()

  if (!stats) {
    return (
      <MessageBar intent="info" style={{ marginTop: '16px' }}>
        <MessageBarBody>File distribution stats not available for this dataset.</MessageBarBody>
      </MessageBar>
    )
  }

  const hasExtensions = stats.extensionDistribution && stats.extensionDistribution.length > 0
  const hasSizes = stats.sizeDistribution && stats.sizeDistribution.length > 0
  const hasAges = stats.ageDistribution && stats.ageDistribution.length > 0

  if (!hasExtensions && !hasSizes && !hasAges) {
    return null
  }

  return (
    <Card className={styles.card}>
      <Text className={styles.title}>File Distributions</Text>

      <div className={styles.grid}>
        {/* Extension pie chart */}
        <div className={styles.section}>
          <Text className={styles.sectionTitle}>File Types</Text>
          {hasExtensions ? (
            <>
              <div className={styles.chartWrap}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stats.extensionDistribution}
                      dataKey="count"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={40}
                    >
                      {stats.extensionDistribution.map((_entry, idx) => (
                        <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ fontSize: '12px', padding: '6px 10px' }}
                      formatter={(value) => [Number(value).toLocaleString(), 'Files']}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className={styles.legendRow}>
                {stats.extensionDistribution.map((entry, idx) => (
                  <div key={entry.label} className={styles.legendItem}>
                    <div
                      className={styles.legendDot}
                      style={{ backgroundColor: COLORS[idx % COLORS.length] }}
                    />
                    <span>{entry.label} ({entry.count.toLocaleString()})</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Text style={{ color: tokens.colorNeutralForeground3, fontSize: '13px' }}>
              No extension data
            </Text>
          )}
        </div>

        {/* Size distribution bar chart */}
        <div className={styles.section}>
          <Text className={styles.sectionTitle}>File Size Distribution</Text>
          {hasSizes ? (
            <div className={styles.chartWrap}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={stats.sizeDistribution.filter((b) => b.count > 0)}
                  layout="vertical"
                  margin={{ top: 5, right: 20, bottom: 5, left: 80 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => v.toLocaleString()} />
                  <YAxis type="category" dataKey="label" width={75} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ fontSize: '12px', padding: '6px 10px' }}
                    formatter={(value) => [Number(value).toLocaleString(), 'Files']}
                  />
                  <Bar dataKey="count" fill={tokens.colorBrandBackground} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Text style={{ color: tokens.colorNeutralForeground3, fontSize: '13px' }}>
              No size data
            </Text>
          )}
        </div>
      </div>

      {/* Age distribution full-width bar chart */}
      {hasAges && (
        <div className={styles.fullWidth}>
          <Text className={styles.sectionTitle}>File Age Distribution</Text>
          <div className={styles.chartWrap}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={stats.ageDistribution.filter((b) => b.count > 0)}
                margin={{ top: 5, right: 20, bottom: 5, left: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => v.toLocaleString()} />
                <Tooltip
                  contentStyle={{ fontSize: '12px', padding: '6px 10px' }}
                  formatter={(value) => [Number(value).toLocaleString(), 'Files']}
                />
                <Bar dataKey="count" fill={tokens.colorPaletteBlueBorderActive} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  )
}
