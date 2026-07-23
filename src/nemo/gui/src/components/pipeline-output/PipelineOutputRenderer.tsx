import { useMemo } from 'react'
import {
  makeStyles,
  Card,
  CardHeader,
  Text,
  Badge,
  Button,
  tokens,
} from '@fluentui/react-components'
import {
  ArrowRepeatAll24Regular,
  ArrowDownload24Regular,
} from '@fluentui/react-icons'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    marginTop: '16px',
  },
  summary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: '12px',
  },
  summaryCard: {
    padding: '16px',
    textAlign: 'center',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '14px',
  },
  th: {
    textAlign: 'left',
    padding: '10px 12px',
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: 600,
  },
  td: {
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  visualizations: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
    gap: '16px',
  },
  chartCard: {
    padding: '16px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
})

const CHART_COLORS = [
  '#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8',
  '#82CA9D', '#FFC658', '#8DD1E1', '#D0ED57', '#A4DE6C',
]

interface PipelineOutputData {
  $schema?: string
  kind?: string
  title?: string
  summary?: Record<string, any>
  columns?: Array<{ id: string; label: string; type: string; values?: string[] }>
  rows?: Array<Record<string, any>>
  actions?: Array<{ id: string; label: string; style: string; clientAction?: string; triggersExecution?: boolean }>
  visualizations?: Array<{ type: string; title: string; groupBy?: string; x?: string; y?: string }>
}

interface Props {
  data: PipelineOutputData
}

export function PipelineOutputRenderer({ data }: Props) {
  const classes = useStyles()

  const columns = data.columns || []
  const rows = data.rows || []

  const pieData = useMemo(() => {
    const viz = data.visualizations?.find((v) => v.type === 'pie')
    if (!viz || !viz.groupBy) return null
    const counts: Record<string, number> = {}
    rows.forEach((row) => {
      const key = String(row[viz.groupBy!] || 'Other')
      counts[key] = (counts[key] || 0) + 1
    })
    return Object.entries(counts).map(([name, value]) => ({ name, value }))
  }, [data.visualizations, rows])

  const barData = useMemo(() => {
    const viz = data.visualizations?.find((v) => v.type === 'bar')
    if (!viz || !viz.x || !viz.y) return null
    const grouped: Record<string, number> = {}
    rows.forEach((row) => {
      const key = String(row[viz.x!] || 'Other')
      grouped[key] = (grouped[key] || 0) + Number(row[viz.y!] || 0)
    })
    return Object.entries(grouped).map(([name, value]) => ({ name, value }))
  }, [data.visualizations, rows])

  const handleAction = (action: any) => {
    if (action.clientAction === 'exportTable') {
      exportCSV(columns, rows)
    }
  }

  return (
    <div className={classes.root}>
      {data.title && <Text size={500} weight="semibold">{data.title}</Text>}

      {data.summary && (
        <div className={classes.summary}>
          {Object.entries(data.summary).map(([key, value]) => (
            <Card key={key} className={classes.summaryCard}>
              <Text size={200} style={{ textTransform: 'capitalize' }}>
                {key.replace(/_/g, ' ')}
              </Text>
              <Text size={600} weight="bold" style={{ display: 'block' }}>
                {typeof value === 'number' && key.includes('usd')
                  ? `$${value.toLocaleString()}`
                  : String(value)}
              </Text>
            </Card>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <Card>
          <CardHeader header={<Text weight="semibold">Recommendations ({rows.length})</Text>} />
          <div style={{ overflowX: 'auto' }}>
            <table className={classes.table}>
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col.id} className={classes.th}>{col.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx}>
                    {columns.map((col) => (
                      <td key={col.id} className={classes.td}>
                        {renderCell(row[col.id], col)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {(pieData || barData) && (
        <div className={classes.visualizations}>
          {pieData && (
            <Card className={classes.chartCard}>
              <Text weight="semibold" style={{ marginBottom: 12, display: 'block' }}>
                {data.visualizations?.find((v) => v.type === 'pie')?.title || 'Distribution'}
              </Text>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={({ name, value }) => `${name} (${value})`}
                  >
                    {pieData.map((_, index) => (
                      <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          )}

          {barData && (
            <Card className={classes.chartCard}>
              <Text weight="semibold" style={{ marginBottom: 12, display: 'block' }}>
                {data.visualizations?.find((v) => v.type === 'bar')?.title || 'Chart'}
              </Text>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="value" fill="#0088FE" />
                </BarChart>
              </ResponsiveContainer>
            </Card>
          )}
        </div>
      )}

      {data.actions && data.actions.length > 0 && (
        <div className={classes.actions}>
          {data.actions.map((action) => (
            <Button
              key={action.id}
              appearance={action.style === 'primary' ? 'primary' : 'secondary'}
              icon={action.id === 'rerun' ? <ArrowRepeatAll24Regular /> : <ArrowDownload24Regular />}
              onClick={() => handleAction(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function renderCell(value: any, col: { type: string; values?: string[] }) {
  if (value === null || value === undefined) return '—'

  switch (col.type) {
    case 'currency':
      return `$${Number(value).toLocaleString()}`
    case 'enum': {
      const colorMap: Record<string, 'success' | 'danger' | 'warning' | 'informative' | 'brand'> = {
        executed: 'success',
        approved: 'success',
        completed: 'success',
        low: 'success',
        rejected: 'danger',
        failed: 'danger',
        high: 'danger',
        pending: 'warning',
        medium: 'warning',
      }
      return (
        <Badge appearance="outline" color={colorMap[String(value)] || 'informative'}>
          {String(value)}
        </Badge>
      )
    }
    case 'text':
      return <span title={String(value)}>{String(value).slice(0, 100)}{String(value).length > 100 ? '...' : ''}</span>
    default:
      return String(value)
  }
}

function exportCSV(columns: Array<{ id: string; label: string }>, rows: Array<Record<string, any>>) {
  const header = columns.map((c) => c.label).join(',')
  const body = rows.map((row) =>
    columns.map((col) => {
      const val = row[col.id]
      if (val === null || val === undefined) return ''
      const str = String(val)
      return str.includes(',') ? `"${str}"` : str
    }).join(',')
  ).join('\n')
  const csv = `${header}\n${body}`
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'pipeline-output.csv'
  a.click()
  URL.revokeObjectURL(url)
}
