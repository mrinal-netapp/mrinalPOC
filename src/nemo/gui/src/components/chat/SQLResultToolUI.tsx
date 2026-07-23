import { makeAssistantToolUI } from '@assistant-ui/react'
import { makeStyles, tokens, Spinner, Text, Button } from '@fluentui/react-components'
import {
  Code16Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  DataBarVertical20Regular,
  Table20Regular,
} from '@fluentui/react-icons'
import { useState, useMemo } from 'react'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from 'recharts'

export const CHART_COLORS = [
  '#0078d4', '#e3008c', '#107c10', '#ca5010', '#8764b8',
  '#008272', '#d13438', '#a4262c', '#498205', '#005b70',
]

const useStyles = makeStyles({
  container: {
    margin: '8px 0',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '8px',
    overflow: 'hidden',
  },
  sqlHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 12px',
    backgroundColor: tokens.colorNeutralBackground3,
    cursor: 'pointer',
    fontSize: '12px',
    color: tokens.colorNeutralForeground2,
    userSelect: 'none',
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
  running: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  error: {
    padding: '12px',
    color: tokens.colorPaletteRedForeground1,
    fontSize: '13px',
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
  viewToggle: {
    display: 'flex',
    gap: '4px',
    padding: '6px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  chartContainer: {
    padding: '16px',
    height: '300px',
  },
})

interface SQLToolArgs {
  sql?: string
  query?: string
}

interface SQLToolResult {
  columns?: string[]
  rows?: unknown[][]
  data?: unknown[]
  rowCount?: number
  error?: string
}

export type ChartType = 'bar' | 'line' | 'pie'

export interface ChartAnalysis {
  chartable: boolean
  labelKey: string
  numericKeys: string[]
  chartData: Record<string, unknown>[]
  suggestedType: ChartType
}

export function analyzeChartability(
  columns: string[],
  rows: unknown[][],
): ChartAnalysis {
  const empty: ChartAnalysis = {
    chartable: false,
    labelKey: '',
    numericKeys: [],
    chartData: [],
    suggestedType: 'bar',
  }

  if (columns.length < 2 || rows.length === 0 || rows.length > 100) return empty

  const numericCols: number[] = []
  const stringCols: number[] = []

  for (let ci = 0; ci < columns.length; ci++) {
    const allNumeric = rows.every((row) => {
      const val = row[ci]
      return val == null || (typeof val === 'number') || !isNaN(Number(val))
    })
    if (allNumeric) {
      numericCols.push(ci)
    } else {
      stringCols.push(ci)
    }
  }

  if (numericCols.length === 0) return empty

  const labelColIdx = stringCols.length > 0 ? stringCols[0] : -1
  const labelKey = labelColIdx >= 0 ? columns[labelColIdx] : 'row'

  const chartData = rows.map((row, ri) => {
    const entry: Record<string, unknown> = {
      [labelKey]: labelColIdx >= 0 ? String(row[labelColIdx] ?? '') : String(ri + 1),
    }
    for (const ci of numericCols) {
      entry[columns[ci]] = Number(row[ci]) || 0
    }
    return entry
  })

  const numericKeys = numericCols.map((ci) => columns[ci])

  let suggestedType: ChartType = 'bar'
  if (numericKeys.length === 1 && rows.length <= 8) {
    suggestedType = 'pie'
  } else if (rows.length > 12) {
    suggestedType = 'line'
  }

  return { chartable: true, labelKey, numericKeys, chartData, suggestedType }
}

export function analyzeDictChartability(data: unknown[]): ChartAnalysis {
  const empty: ChartAnalysis = {
    chartable: false,
    labelKey: '',
    numericKeys: [],
    chartData: [],
    suggestedType: 'bar',
  }

  if (data.length === 0 || data.length > 100) return empty

  const first = data[0] as Record<string, unknown>
  const keys = Object.keys(first)
  if (keys.length < 2) return empty

  const numericKeys: string[] = []
  const stringKeys: string[] = []

  for (const key of keys) {
    const allNumeric = data.every((row) => {
      const val = (row as Record<string, unknown>)[key]
      return val == null || (typeof val === 'number') || !isNaN(Number(val))
    })
    if (allNumeric) {
      numericKeys.push(key)
    } else {
      stringKeys.push(key)
    }
  }

  if (numericKeys.length === 0) return empty

  const labelKey = stringKeys.length > 0 ? stringKeys[0] : 'row'

  const chartData = data.map((row, ri) => {
    const rec = row as Record<string, unknown>
    const entry: Record<string, unknown> = {
      [labelKey]: stringKeys.length > 0 ? String(rec[labelKey] ?? '') : String(ri + 1),
    }
    for (const nk of numericKeys) {
      entry[nk] = Number(rec[nk]) || 0
    }
    return entry
  })

  let suggestedType: ChartType = 'bar'
  if (numericKeys.length === 1 && data.length <= 8) {
    suggestedType = 'pie'
  } else if (data.length > 12) {
    suggestedType = 'line'
  }

  return { chartable: true, labelKey, numericKeys, chartData, suggestedType }
}

export const SQLResultToolUI = makeAssistantToolUI<SQLToolArgs, SQLToolResult>({
  toolName: 'execute_query',
  render: ({ args, result, status }) => {
    const styles = useStyles()
    const [showSQL, setShowSQL] = useState(false)
    const [view, setView] = useState<'table' | 'chart'>('table')
    const [chartType, setChartType] = useState<ChartType | null>(null)
    const sql = args?.sql || args?.query || ''

    const columns = result?.columns || []
    const rows = result?.rows || []
    const data = result?.data
    const hasTableData = columns.length > 0 && rows.length > 0
    const hasDictData = data && Array.isArray(data) && data.length > 0

    const analysis = useMemo<ChartAnalysis>(() => {
      if (hasTableData) return analyzeChartability(columns, rows)
      if (hasDictData) return analyzeDictChartability(data)
      return { chartable: false, labelKey: '', numericKeys: [], chartData: [], suggestedType: 'bar' }
    }, [columns, rows, data, hasTableData, hasDictData])

    const activeChartType = chartType ?? analysis.suggestedType

    if (status.type === 'running') {
      return (
        <div className={styles.container}>
          <CollapsibleSQL sql={sql} show={showSQL} onToggle={() => setShowSQL(!showSQL)} />
          <div className={styles.running}>
            <Spinner size="tiny" />
            <Text size={200}>Running query...</Text>
          </div>
        </div>
      )
    }

    if (status.type === 'incomplete') {
      return (
        <div className={styles.container}>
          <CollapsibleSQL sql={sql} show={showSQL} onToggle={() => setShowSQL(!showSQL)} />
          <div className={styles.error}>Query was interrupted or failed.</div>
        </div>
      )
    }

    if (result?.error) {
      return (
        <div className={styles.container}>
          <CollapsibleSQL sql={sql} show={showSQL} onToggle={() => setShowSQL(!showSQL)} />
          <div className={styles.error}>{result.error}</div>
        </div>
      )
    }

    const totalRows = result?.rowCount ?? rows.length

    return (
      <div className={styles.container}>
        <CollapsibleSQL sql={sql} show={showSQL} onToggle={() => setShowSQL(!showSQL)} />

        {(hasTableData || hasDictData) && analysis.chartable && (
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
                    {columns.map((col, i) => (
                      <th key={i} className={styles.th}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
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
              {totalRows} row{totalRows !== 1 ? 's' : ''}{' '}
              {rows.length < totalRows && `(showing ${rows.length})`}
            </div>
          </>
        )}

        {view === 'table' && !hasTableData && hasDictData && (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {Object.keys(data[0] as Record<string, unknown>).map((key, i) => (
                      <th key={i} className={styles.th}>{key}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, ri) => (
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
            <div className={styles.rowCount}>{data.length} row{data.length !== 1 ? 's' : ''}</div>
          </>
        )}

        {view === 'table' && !hasTableData && !hasDictData && result && (
          <div style={{ padding: '12px', fontSize: '13px', color: tokens.colorNeutralForeground2 }}>
            Query executed successfully (no rows returned).
          </div>
        )}
      </div>
    )
  },
})

export function ResultChart({
  type,
  data,
  labelKey,
  numericKeys,
}: {
  type: ChartType
  data: Record<string, unknown>[]
  labelKey: string
  numericKeys: string[]
}) {
  if (type === 'pie' && numericKeys.length === 1) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey={numericKeys[0]}
            nameKey={labelKey}
            cx="50%"
            cy="50%"
            outerRadius={100}
            label={({ name, percent }) =>
              `${name ?? ''}: ${((percent ?? 0) * 100).toFixed(0)}%`
            }
          >
            {data.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    )
  }

  if (type === 'line') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          {numericKeys.length > 1 && <Legend />}
          {numericKeys.map((key, i) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={labelKey} tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip />
        {numericKeys.length > 1 && <Legend />}
        {numericKeys.map((key, i) => (
          <Bar key={key} dataKey={key} fill={CHART_COLORS[i % CHART_COLORS.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function CollapsibleSQL({
  sql,
  show,
  onToggle,
}: {
  sql: string
  show: boolean
  onToggle: () => void
}) {
  const styles = useStyles()
  if (!sql) return null
  return (
    <>
      <div className={styles.sqlHeader} onClick={onToggle}>
        <Code16Regular />
        <span>SQL Query</span>
        {show ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
      </div>
      {show && <div className={styles.sqlBlock}>{sql}</div>}
    </>
  )
}
