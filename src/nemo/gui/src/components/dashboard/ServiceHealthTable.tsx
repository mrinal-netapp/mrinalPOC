import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Spinner,
  Text,
  Badge,
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
} from '@fluentui/react-components'
import type { VectorResult } from '../../services/metricsApi'

const useStyles = makeStyles({
  card: {
    width: '100%',
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    padding: tokens.spacingVerticalM,
  },
})

interface ServiceHealthTableProps {
  upStatus: { data: VectorResult | null; loading: boolean; error: string | null }
  requestRate: { data: VectorResult | null; loading: boolean; error: string | null }
  errorRate: { data: VectorResult | null; loading: boolean; error: string | null }
  p95Latency: { data: VectorResult | null; loading: boolean; error: string | null }
}

function fmtRate(val: string | undefined): string {
  if (!val) return '—'
  const n = parseFloat(val)
  return n < 0.01 ? '< 0.01' : n.toFixed(2)
}

function fmtLatency(val: string | undefined): string {
  if (!val) return '—'
  const n = parseFloat(val)
  if (isNaN(n) || !isFinite(n)) return '—'
  if (n < 0.001) return `${(n * 1_000_000).toFixed(0)} µs`
  if (n < 1) return `${(n * 1000).toFixed(1)} ms`
  return `${n.toFixed(2)} s`
}

export const ServiceHealthTable: React.FC<ServiceHealthTableProps> = ({
  upStatus,
  requestRate,
  errorRate,
  p95Latency,
}) => {
  const styles = useStyles()

  const loading = upStatus.loading || requestRate.loading || errorRate.loading || p95Latency.loading
  const anyError = upStatus.error || requestRate.error || errorRate.error || p95Latency.error

  const services = (() => {
    if (!upStatus.data?.result) return []

    const rateMap = new Map<string, string>()
    requestRate.data?.result?.forEach((r) => {
      rateMap.set(r.metric.job, r.value[1])
    })

    const errMap = new Map<string, string>()
    errorRate.data?.result?.forEach((r) => {
      errMap.set(r.metric.job, r.value[1])
    })

    const latMap = new Map<string, string>()
    p95Latency.data?.result?.forEach((r) => {
      latMap.set(r.metric.job, r.value[1])
    })

    const upMap = new Map<string, boolean>()
    upStatus.data.result.forEach((r) => {
      const job = r.metric.job || r.metric.instance || 'unknown'
      const isUp = r.value[1] === '1'
      const prev = upMap.get(job)
      upMap.set(job, prev === undefined ? isUp : prev && isUp)
    })

    return Array.from(upMap.entries()).map(([job, up]) => ({
      name: job,
      up,
      rps: rateMap.get(job),
      errRate: errMap.get(job),
      p95: latMap.get(job),
    }))
  })()

  return (
    <Card className={styles.card}>
      <CardHeader header={<Text weight="semibold">Service Health</Text>} />
      {loading ? (
        <Spinner size="small" />
      ) : anyError ? (
        <Text className={styles.error}>{anyError}</Text>
      ) : services.length === 0 ? (
        <Text className={styles.error}>No services found</Text>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Service</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>RPS</TableHeaderCell>
              <TableHeaderCell>Error Rate</TableHeaderCell>
              <TableHeaderCell>P95 Latency</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {services.map((svc) => (
              <TableRow key={svc.name}>
                <TableCell>{svc.name}</TableCell>
                <TableCell>
                  <Badge
                    appearance="filled"
                    color={svc.up ? 'success' : 'danger'}
                  >
                    {svc.up ? 'UP' : 'DOWN'}
                  </Badge>
                </TableCell>
                <TableCell>{fmtRate(svc.rps)}</TableCell>
                <TableCell>{fmtRate(svc.errRate)}</TableCell>
                <TableCell>{fmtLatency(svc.p95)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  )
}
