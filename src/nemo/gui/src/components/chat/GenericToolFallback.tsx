import React, { useState, useMemo } from 'react'
import { type ToolCallMessagePartProps } from '@assistant-ui/react'
import { makeStyles, tokens, Spinner, Text, Badge, Button } from '@fluentui/react-components'
import {
  Wrench16Regular,
  People16Regular,
  Send16Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Checkmark16Regular,
  Dismiss16Regular,
  DataBarVertical20Regular,
  Table20Regular,
  Code16Regular,
} from '@fluentui/react-icons'
import {
  type ChartType,
  type ChartAnalysis,
  analyzeChartability,
  analyzeDictChartability,
  ResultChart,
} from './SQLResultToolUI'

const useStyles = makeStyles({
  container: {
    margin: '6px 0',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '7px 12px',
    backgroundColor: tokens.colorNeutralBackground3,
    cursor: 'pointer',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    userSelect: 'none',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
  toolName: {
    fontWeight: 600,
    flex: 1,
  },
  memberBadge: {
    flexShrink: 0,
  },
  statusBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  body: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  section: {
    padding: '8px 12px',
    '& + &': {
      borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    },
  },
  sectionLabel: {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: tokens.colorNeutralForeground3,
    marginBottom: '4px',
    letterSpacing: '0.5px',
  },
  codeBlock: {
    fontFamily: 'monospace',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground4,
    padding: '6px 8px',
    borderRadius: '4px',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  memberResponseText: {
    fontSize: '13px',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: tokens.colorNeutralForeground1,
    padding: '6px 8px',
  },
  emptyResult: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  viewToggle: {
    display: 'flex',
    gap: '4px',
    padding: '6px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  tableWrapper: {
    overflowX: 'auto',
    maxHeight: '400px',
    overflowY: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '13px',
  },
  th: {
    position: 'sticky' as const,
    top: 0,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: '8px 10px',
    textAlign: 'left',
    fontWeight: 600,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    whiteSpace: 'nowrap',
    maxWidth: '300px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  rowCount: {
    padding: '6px 12px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  chartContainer: {
    padding: '16px',
    height: '300px',
  },
  sqlBlock: {
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground4,
    fontFamily: 'monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
})

function humanizeToolName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function isEmptyResult(result: unknown): boolean {
  if (result == null) return true
  if (result === '') return true
  if (Array.isArray(result) && result.length === 0) return true
  if (typeof result === 'object' && Object.keys(result as object).length === 0) return true
  if (typeof result === 'string') {
    const lower = result.toLowerCase().trim()
    if (lower === 'no results' || lower === 'no data' || lower === 'null' || lower === 'none')
      return true
  }
  return false
}

function formatResult(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '…'
}

const SEPARATOR = ' › '

function parseToolName(toolName: string): {
  memberName: string | undefined
  actualToolName: string
} {
  const idx = toolName.indexOf(SEPARATOR)
  if (idx >= 0) {
    return {
      memberName: toolName.slice(0, idx),
      actualToolName: toolName.slice(idx + SEPARATOR.length),
    }
  }
  return { memberName: undefined, actualToolName: toolName }
}

function isDelegationTool(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes('delegate') || lower.includes('transfer')
}

interface TabularData {
  columns: string[]
  rows: unknown[][]
  data?: unknown[]
  rowCount: number
}

function extractTabularData(result: unknown): TabularData | null {
  if (result == null || typeof result !== 'object') return null

  const r = result as Record<string, unknown>

  if (
    Array.isArray(r.columns) &&
    r.columns.length > 0 &&
    Array.isArray(r.rows) &&
    r.rows.length > 0
  ) {
    return {
      columns: r.columns as string[],
      rows: r.rows as unknown[][],
      rowCount: (r.rowCount as number) ?? (r.rows as unknown[][]).length,
    }
  }

  if (Array.isArray(r.data) && r.data.length > 0) {
    const first = r.data[0]
    if (first != null && typeof first === 'object' && !Array.isArray(first)) {
      return {
        columns: Object.keys(first as Record<string, unknown>),
        rows: [],
        data: r.data as unknown[],
        rowCount: (r.data as unknown[]).length,
      }
    }
  }

  return null
}

function extractSQL(argsText: string | undefined): string {
  if (!argsText) return ''
  try {
    const args = JSON.parse(argsText)
    return args.sql || args.query || ''
  } catch {
    return ''
  }
}

function TabularResultView({
  tabular,
  analysis,
  argsText,
}: {
  tabular: TabularData
  analysis: ChartAnalysis
  argsText?: string
}) {
  const styles = useStyles()
  const [view, setView] = useState<'table' | 'chart'>('table')
  const [chartType, setChartType] = useState<ChartType | null>(null)
  const [showSQL, setShowSQL] = useState(false)
  const activeChartType = chartType ?? analysis.suggestedType
  const sql = extractSQL(argsText)
  const hasTableData = tabular.columns.length > 0 && tabular.rows.length > 0
  const hasDictData = tabular.data && tabular.data.length > 0

  return (
    <>
      {sql && (
        <>
          <div
            className={styles.header}
            onClick={() => setShowSQL(!showSQL)}
            style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}` }}
          >
            <Code16Regular />
            <span>SQL Query</span>
            {showSQL ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
          </div>
          {showSQL && <div className={styles.sqlBlock}>{sql}</div>}
        </>
      )}

      {analysis.chartable && (
        <div className={styles.viewToggle}>
          <Button
            size="small"
            appearance={view === 'table' ? 'primary' : 'subtle'}
            icon={<Table20Regular />}
            onClick={() => setView('table')}
          >
            Table
          </Button>
          <Button
            size="small"
            appearance={view === 'chart' ? 'primary' : 'subtle'}
            icon={<DataBarVertical20Regular />}
            onClick={() => setView('chart')}
          >
            Chart
          </Button>
          {view === 'chart' && (
            <>
              <Button
                size="small"
                appearance={activeChartType === 'bar' ? 'outline' : 'subtle'}
                onClick={() => setChartType('bar')}
              >
                Bar
              </Button>
              <Button
                size="small"
                appearance={activeChartType === 'line' ? 'outline' : 'subtle'}
                onClick={() => setChartType('line')}
              >
                Line
              </Button>
              {analysis.numericKeys.length === 1 && (
                <Button
                  size="small"
                  appearance={activeChartType === 'pie' ? 'outline' : 'subtle'}
                  onClick={() => setChartType('pie')}
                >
                  Pie
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {view === 'chart' && analysis.chartable && (
        <div className={styles.chartContainer}>
          <ResultChart
            type={activeChartType}
            data={analysis.chartData}
            labelKey={analysis.labelKey}
            numericKeys={analysis.numericKeys}
          />
        </div>
      )}

      {view === 'table' && hasTableData && (
        <>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {tabular.columns.map((col, i) => (
                    <th key={i} className={styles.th}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tabular.rows.map((row, ri) => (
                  <tr key={ri}>
                    {(row as unknown[]).map((cell, ci) => (
                      <td key={ci} className={styles.td} title={String(cell ?? '')}>
                        {cell == null ? <em style={{ opacity: 0.4 }}>NULL</em> : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.rowCount}>
            {tabular.rowCount} row{tabular.rowCount !== 1 ? 's' : ''}{' '}
            {tabular.rows.length < tabular.rowCount && `(showing ${tabular.rows.length})`}
          </div>
        </>
      )}

      {view === 'table' && !hasTableData && hasDictData && (
        <>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {Object.keys(tabular.data![0] as Record<string, unknown>).map((key, i) => (
                    <th key={i} className={styles.th}>{key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tabular.data!.map((row, ri) => (
                  <tr key={ri}>
                    {Object.values(row as Record<string, unknown>).map((cell, ci) => (
                      <td key={ci} className={styles.td} title={String(cell ?? '')}>
                        {cell == null ? <em style={{ opacity: 0.4 }}>NULL</em> : String(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.rowCount}>
            {tabular.data!.length} row{tabular.data!.length !== 1 ? 's' : ''}
          </div>
        </>
      )}
    </>
  )
}

export const GenericToolFallback: React.FC<ToolCallMessagePartProps> = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const styles = useStyles()
  const { memberName, actualToolName } = parseToolName(toolName)
  const isMemberResponse = actualToolName === '__member_response__'
  const isDelegation = isDelegationTool(actualToolName)
  const isRunning = status.type === 'running'
  const isCancelled = status.type === 'incomplete'
  const empty = !isRunning && isEmptyResult(result)

  const resultText = formatResult(result)

  const tabular = useMemo(() => {
    if (status.type !== 'complete') return null
    return extractTabularData(result)
  }, [result, status.type])

  const [expanded, setExpanded] = useState(tabular != null)

  const analysis = useMemo<ChartAnalysis>(() => {
    if (!tabular) return { chartable: false, labelKey: '', numericKeys: [], chartData: [], suggestedType: 'bar' }
    if (tabular.rows.length > 0) return analyzeChartability(tabular.columns, tabular.rows)
    if (tabular.data && tabular.data.length > 0) return analyzeDictChartability(tabular.data)
    return { chartable: false, labelKey: '', numericKeys: [], chartData: [], suggestedType: 'bar' }
  }, [tabular])

  let headerIcon = <Wrench16Regular />
  let displayName: string

  if (isMemberResponse) {
    headerIcon = <People16Regular />
    displayName = memberName ? `${memberName} responded` : 'Agent responded'
  } else if (isDelegation) {
    headerIcon = <Send16Regular />
    let delegatee: string | undefined
    try {
      const args = argsText ? JSON.parse(argsText) : {}
      delegatee = args.member_name || args.agent_name || args.task
    } catch { /* ignore */ }
    displayName = delegatee
      ? `Delegated to ${delegatee}`
      : humanizeToolName(actualToolName)
  } else {
    displayName = humanizeToolName(actualToolName)
  }

  if (tabular) {
    return (
      <div className={styles.container}>
        <div className={styles.header} onClick={() => setExpanded(!expanded)}>
          {headerIcon}
          {memberName && (
            <Badge
              size="small"
              appearance="tint"
              color="brand"
              className={styles.memberBadge}
            >
              {memberName}
            </Badge>
          )}
          <span className={styles.toolName}>{displayName}</span>
          <span className={styles.statusBadge}>
            {isRunning && (
              <>
                <Spinner size="extra-tiny" />
                <Text size={100}>Running</Text>
              </>
            )}
            {status.type === 'complete' && (
              <>
                <Checkmark16Regular />
                <Text size={100}>Done</Text>
              </>
            )}
          </span>
          {expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
        </div>
        {expanded && (
          <>
            <TabularResultView
              tabular={tabular}
              analysis={analysis}
              argsText={argsText}
            />
          </>
        )}
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header} onClick={() => setExpanded(!expanded)}>
        {headerIcon}
        {memberName && !isMemberResponse && (
          <Badge
            size="small"
            appearance="tint"
            color="brand"
            className={styles.memberBadge}
          >
            {memberName}
          </Badge>
        )}
        <span className={styles.toolName}>{displayName}</span>

        <span className={styles.statusBadge}>
          {isRunning && (
            <>
              <Spinner size="extra-tiny" />
              <Text size={100}>Running</Text>
            </>
          )}
          {isCancelled && (
            <>
              <Dismiss16Regular />
              <Text size={100}>Cancelled</Text>
            </>
          )}
          {status.type === 'complete' && empty && (
            <Text size={100}>No results</Text>
          )}
          {status.type === 'complete' && !empty && (
            <>
              <Checkmark16Regular />
              <Text size={100}>Done</Text>
            </>
          )}
        </span>

        {expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
      </div>

      {expanded && (
        <div className={styles.body}>
          {!isMemberResponse && argsText && argsText !== '{}' && (
            <div className={styles.section}>
              <div className={styles.sectionLabel}>Arguments</div>
              <div className={styles.codeBlock}>
                {truncate(
                  (() => {
                    try { return JSON.stringify(JSON.parse(argsText), null, 2) }
                    catch { return argsText }
                  })(),
                  2000,
                )}
              </div>
            </div>
          )}

          {isRunning && (
            <div className={styles.section}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Spinner size="tiny" />
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                  {isMemberResponse
                    ? `Waiting for ${memberName || 'agent'} to respond…`
                    : `Executing ${displayName.toLowerCase()}…`}
                </Text>
              </div>
            </div>
          )}

          {isCancelled && (
            <div className={styles.section}>
              <span className={styles.emptyResult}>Tool call was cancelled.</span>
            </div>
          )}

          {status.type === 'complete' && empty && (
            <div className={styles.section}>
              <span className={styles.emptyResult}>
                {isMemberResponse ? 'No response received.' : 'Tool returned no data.'}
              </span>
            </div>
          )}

          {status.type === 'complete' && !empty && resultText && (
            <div className={styles.section}>
              {!isMemberResponse && (
                <div className={styles.sectionLabel}>Result</div>
              )}
              <div className={isMemberResponse ? styles.memberResponseText : styles.codeBlock}>
                {truncate(resultText, 5000)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
