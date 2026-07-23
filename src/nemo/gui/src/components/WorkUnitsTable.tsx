import { useMemo, useState } from 'react'
import {
  makeStyles,
  tokens,
  Text,
  Badge,
  Tooltip,
  CounterBadge,
} from '@fluentui/react-components'
import {
  ChevronDown20Regular,
  ChevronRight20Regular,
  CheckmarkCircle16Filled,
  Clock16Regular,
  Play16Filled,
  ErrorCircle16Filled,
} from '@fluentui/react-icons'

export interface WorkUnit {
  unitId?: string
  status?: string
  metrics?: Record<string, unknown>
}

interface WorkUnitsTableProps {
  units: WorkUnit[]
}

const useStyles = makeStyles({
  root: {
    marginTop: '12px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  summaryBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    flexWrap: 'wrap',
  },
  summaryChip: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 500,
    userSelect: 'none',
    transition: 'background 0.15s',
    '&:hover': {
      opacity: 0.85,
    },
  },
  progressTrack: {
    display: 'flex',
    height: '6px',
    borderRadius: '3px',
    overflow: 'hidden',
    marginBottom: '12px',
    backgroundColor: tokens.colorNeutralBackground4,
  },
  progressCompleted: {
    backgroundColor: tokens.colorStatusSuccessForeground1,
    transition: 'width 0.4s ease',
  },
  progressRunning: {
    backgroundColor: tokens.colorBrandForeground1,
    transition: 'width 0.4s ease',
  },
  progressFailed: {
    backgroundColor: tokens.colorStatusDangerForeground1,
    transition: 'width 0.4s ease',
  },
  progressPending: {
    backgroundColor: tokens.colorNeutralBackground4,
    transition: 'width 0.4s ease',
  },
  tableContainer: {
    maxHeight: '320px',
    overflowY: 'auto',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12px',
  },
  thead: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  th: {
    padding: '6px 10px',
    textAlign: 'left',
    fontWeight: 600,
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    color: tokens.colorNeutralForeground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tr: {
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '&:last-child': {
      borderBottom: 'none',
    },
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  td: {
    padding: '5px 10px',
    verticalAlign: 'middle',
  },
  unitId: {
    fontFamily: 'monospace',
    fontWeight: 500,
    fontSize: '12px',
    minWidth: '40px',
  },
  metricsCell: {
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '500px',
  },
  sectionToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    padding: '4px 0',
    userSelect: 'none',
    color: tokens.colorNeutralForeground2,
    fontWeight: 500,
    fontSize: '13px',
    '&:hover': {
      color: tokens.colorNeutralForeground1,
    },
  },
  sectionHeader: {
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '4px 10px',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
})

type StatusCategory = 'running' | 'completed' | 'pending' | 'failed'

function categorize(status?: string): StatusCategory {
  if (!status || status === 'pending') return 'pending'
  if (status === 'completed' || status === 'success') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  return 'running'
}

const statusIcon: Record<StatusCategory, React.ReactNode> = {
  running: <Play16Filled style={{ color: tokens.colorBrandForeground1 }} />,
  completed: <CheckmarkCircle16Filled style={{ color: tokens.colorStatusSuccessForeground1 }} />,
  pending: <Clock16Regular style={{ color: tokens.colorNeutralForeground3 }} />,
  failed: <ErrorCircle16Filled style={{ color: tokens.colorStatusDangerForeground1 }} />,
}

const counterBadgeColor: Record<StatusCategory, 'brand' | 'danger' | 'important' | 'informative'> = {
  running: 'brand',
  completed: 'informative',
  pending: 'informative',
  failed: 'danger',
}

function formatMetrics(metrics: Record<string, unknown>): string {
  return Object.entries(metrics)
    .filter(([, v]) => v != null)
    .map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()).trim()
      return `${label}: ${typeof v === 'number' ? v.toLocaleString() : String(v)}`
    })
    .join(' · ')
}

export function WorkUnitsTable({ units }: WorkUnitsTableProps) {
  const styles = useStyles()
  const [collapsedSections, setCollapsedSections] = useState<Set<StatusCategory>>(new Set(['completed']))

  const { grouped, counts, total } = useMemo(() => {
    const g: Record<StatusCategory, WorkUnit[]> = { running: [], failed: [], pending: [], completed: [] }
    for (const u of units) {
      g[categorize(u.status)].push(u)
    }
    return {
      grouped: g,
      counts: {
        running: g.running.length,
        completed: g.completed.length,
        pending: g.pending.length,
        failed: g.failed.length,
      },
      total: units.length,
    }
  }, [units])

  const toggleSection = (cat: StatusCategory) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  const sectionOrder: StatusCategory[] = ['running', 'failed', 'pending', 'completed']
  const activeSections = sectionOrder.filter((cat) => counts[cat] > 0)

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text weight="semibold" size={300}>
          Work units
        </Text>
        <div className={styles.summaryBar}>
          {counts.completed > 0 && (
            <Tooltip content={`${counts.completed} completed`} relationship="label">
              <span
                className={styles.summaryChip}
                style={{ backgroundColor: 'rgba(16,124,16,0.1)', color: tokens.colorStatusSuccessForeground1 }}
                onClick={() => toggleSection('completed')}
              >
                <CheckmarkCircle16Filled /> {counts.completed}
              </span>
            </Tooltip>
          )}
          {counts.running > 0 && (
            <Tooltip content={`${counts.running} running`} relationship="label">
              <span
                className={styles.summaryChip}
                style={{ backgroundColor: 'rgba(0,120,212,0.1)', color: tokens.colorBrandForeground1 }}
                onClick={() => toggleSection('running')}
              >
                <Play16Filled /> {counts.running}
              </span>
            </Tooltip>
          )}
          {counts.pending > 0 && (
            <Tooltip content={`${counts.pending} pending`} relationship="label">
              <span
                className={styles.summaryChip}
                style={{ backgroundColor: 'rgba(0,0,0,0.05)', color: tokens.colorNeutralForeground3 }}
                onClick={() => toggleSection('pending')}
              >
                <Clock16Regular /> {counts.pending}
              </span>
            </Tooltip>
          )}
          {counts.failed > 0 && (
            <Tooltip content={`${counts.failed} failed`} relationship="label">
              <span
                className={styles.summaryChip}
                style={{ backgroundColor: 'rgba(196,49,75,0.1)', color: tokens.colorStatusDangerForeground1 }}
                onClick={() => toggleSection('failed')}
              >
                <ErrorCircle16Filled /> {counts.failed}
              </span>
            </Tooltip>
          )}
          <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
            {counts.completed} / {total}
          </Text>
        </div>
      </div>

      {/* Segmented progress bar */}
      <div className={styles.progressTrack}>
        {counts.completed > 0 && (
          <div className={styles.progressCompleted} style={{ width: `${(counts.completed / total) * 100}%` }} />
        )}
        {counts.running > 0 && (
          <div className={styles.progressRunning} style={{ width: `${(counts.running / total) * 100}%` }} />
        )}
        {counts.failed > 0 && (
          <div className={styles.progressFailed} style={{ width: `${(counts.failed / total) * 100}%` }} />
        )}
        {counts.pending > 0 && (
          <div className={styles.progressPending} style={{ width: `${(counts.pending / total) * 100}%` }} />
        )}
      </div>

      {/* Grouped table */}
      <div className={styles.tableContainer}>
        <table className={styles.table}>
          <thead className={styles.thead}>
            <tr>
              <th className={styles.th} style={{ width: '60px' }}>Unit</th>
              <th className={styles.th} style={{ width: '90px' }}>Status</th>
              <th className={styles.th}>Metrics</th>
            </tr>
          </thead>
          <tbody>
            {activeSections.map((cat) => {
              const items = grouped[cat]
              const isCollapsed = collapsedSections.has(cat)
              return (
                <SectionGroup
                  key={cat}
                  category={cat}
                  items={items}
                  isCollapsed={isCollapsed}
                  onToggle={() => toggleSection(cat)}
                  styles={styles}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SectionGroup({
  category,
  items,
  isCollapsed,
  onToggle,
  styles,
}: {
  category: StatusCategory
  items: WorkUnit[]
  isCollapsed: boolean
  onToggle: () => void
  styles: ReturnType<typeof useStyles>
}) {
  const label = category.charAt(0).toUpperCase() + category.slice(1)
  const ChevronIcon = isCollapsed ? ChevronRight20Regular : ChevronDown20Regular

  return (
    <>
      <tr>
        <td colSpan={3} style={{ padding: 0 }}>
          <div className={styles.sectionHeader} onClick={onToggle}>
            <ChevronIcon style={{ fontSize: '14px' }} />
            {statusIcon[category]}
            <Text size={200} weight="semibold">{label}</Text>
            <CounterBadge count={items.length} size="small" color={counterBadgeColor[category]} appearance="filled" />
          </div>
        </td>
      </tr>
      {!isCollapsed &&
        items.map((u) => {
          const cat = categorize(u.status)
          const metricsStr = u.metrics && Object.keys(u.metrics).length > 0 ? formatMetrics(u.metrics) : ''
          return (
            <tr key={u.unitId ?? ''} className={styles.tr}>
              <td className={`${styles.td} ${styles.unitId}`}>{u.unitId ?? '-'}</td>
              <td className={styles.td}>
                <Badge
                  appearance={cat === 'completed' || cat === 'failed' ? 'filled' : 'outline'}
                  color={cat === 'completed' ? 'success' : cat === 'failed' ? 'danger' : cat === 'running' ? 'brand' : 'informative'}
                  size="small"
                >
                  {u.status ?? 'pending'}
                </Badge>
              </td>
              <td className={`${styles.td} ${styles.metricsCell}`}>
                {metricsStr ? (
                  <Tooltip content={metricsStr} relationship="description" positioning="above">
                    <span>{metricsStr}</span>
                  </Tooltip>
                ) : (
                  <span style={{ color: tokens.colorNeutralForeground4 }}>—</span>
                )}
              </td>
            </tr>
          )
        })}
    </>
  )
}
