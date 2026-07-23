import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { useParams } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Button,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import {
  Dismiss24Regular,
  ArrowClockwise24Regular,
  Copy16Regular,
  Timeline24Regular,
} from '@fluentui/react-icons'
import { traceApi, type TraceSpan } from '../../services/api'
import {
  SpanDetailPanel,
  SpanListRow,
  TimelineRuler,
  orderSpansForWaterfall,
  formatMs,
} from './trace'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function useNarrowPanelLayout(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const apply = () => setNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return narrow
}

const useStyles = makeStyles({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    zIndex: 10000,
  },
  panel: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(960px, 100vw)',
    zIndex: 10001,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow64,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  headerTitle: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  },
  metaRow: {
    padding: '8px 16px 0',
    flexShrink: 0,
  },
  splitMain: {
    display: 'flex',
    flexWrap: 'wrap',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  listPane: {
    flex: '1 1 38%',
    minWidth: '280px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    padding: '0 8px 12px 16px',
  },
  listPaneScroll: {
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
  },
  detailPane: {
    flex: '1 1 58%',
    minWidth: '280px',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  detailPaneWide: {
    borderLeft: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingLeft: '8px',
  },
  detailPaneNarrow: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '8px',
    flex: '1 1 100%',
  },
  emptyHint: {
    padding: '16px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
})

export interface TraceDrawerProps {
  open: boolean
  traceId: string | null
  onClose: () => void
}

const TraceDrawer: FC<TraceDrawerProps> = ({ open, traceId, onClose }) => {
  const styles = useStyles()
  const narrow = useNarrowPanelLayout()
  const { projectId } = useParams<{ projectId: string }>()
  const [spans, setSpans] = useState<TraceSpan[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null)

  const loadSpans = useCallback(
    async (withRetry: boolean) => {
      if (!projectId || !traceId) return
      setLoading(true)
      setError(null)
      try {
        let data = await traceApi.getSpans(projectId, traceId)
        if (withRetry && data.length === 0) {
          setRetrying(true)
          for (let i = 0; i < 3; i++) {
            await sleep(3000)
            data = await traceApi.getSpans(projectId, traceId)
            if (data.length > 0) break
          }
          setRetrying(false)
        }
        setSpans(data)
      } catch (e: unknown) {
        const status = (e as { response?: { status?: number } })?.response?.status
        let msg: string
        if (status === 502 || status === 503 || status === 504) {
          msg =
            'The observability backend is unreachable (HTTP ' +
            status +
            '). Tracing may not be deployed — verify the observability stack is running ' +
            '(e.g. make deploy-observability or deploy-all OBSERVABILITY=1).'
        } else if (status === 404) {
          msg =
            'Trace not found. It may not have been ingested yet — try refreshing in a few seconds.'
        } else {
          msg = e instanceof Error ? e.message : 'Failed to load trace'
        }
        setError(msg)
        setSpans([])
      } finally {
        setLoading(false)
        setRetrying(false)
      }
    },
    [projectId, traceId],
  )

  useEffect(() => {
    if (!open || !traceId || !projectId) {
      setSpans([])
      setError(null)
      setSelectedSpanId(null)
      return
    }
    void loadSpans(true)
  }, [open, traceId, projectId, loadSpans])

  useEffect(() => {
    setSelectedSpanId(null)
  }, [traceId])

  const ordered = useMemo(() => orderSpansForWaterfall(spans), [spans])

  const { traceStart, totalMs } = useMemo(() => {
    if (spans.length === 0) {
      return { traceStart: 0, totalMs: 1 }
    }
    let min = Infinity
    let max = -Infinity
    for (const s of spans) {
      const a = new Date(s.start_time).getTime()
      const b = new Date(s.end_time).getTime()
      min = Math.min(min, a)
      max = Math.max(max, b)
    }
    const t = Math.max(1, max - min)
    return { traceStart: min, totalMs: t }
  }, [spans])

  useEffect(() => {
    if (spans.length === 0) {
      setSelectedSpanId(null)
      return
    }
    setSelectedSpanId((prev) => {
      if (prev && spans.some((s) => s.context.span_id === prev)) return prev
      const ord = orderSpansForWaterfall(spans)
      const firstRoot = ord.find(({ depth }) => depth === 0)
      return firstRoot?.span.context.span_id ?? ord[0]?.span.context.span_id ?? null
    })
  }, [spans])

  const selectedSpan = useMemo(
    () => spans.find((s) => s.context.span_id === selectedSpanId) ?? null,
    [spans, selectedSpanId],
  )

  if (!open || !traceId) return null

  const copyTraceId = () => {
    void navigator.clipboard.writeText(traceId)
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.panel} role="dialog" aria-labelledby="trace-drawer-title">
        <div className={styles.header}>
          <div className={styles.headerTitle}>
            <Timeline24Regular />
            <Text id="trace-drawer-title" weight="semibold" size={400}>
              Trace
            </Text>
          </div>
          <Button
            appearance="subtle"
            icon={<ArrowClockwise24Regular />}
            title="Refresh"
            onClick={() => void loadSpans(false)}
            disabled={loading}
          />
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            title="Close"
            onClick={onClose}
          />
        </div>
        <div className={styles.metaRow}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              fontSize: 12,
              color: tokens.colorNeutralForeground3,
              wordBreak: 'break-all',
            }}
          >
            <Text size={200}>ID:</Text>
            <Text size={200} style={{ flex: 1 }} title={traceId}>
              {truncate(traceId, 48)}
            </Text>
            <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={copyTraceId}>
              Copy
            </Button>
          </div>
          {spans.length > 0 && (
            <Text size={200} style={{ marginBottom: 8, color: tokens.colorNeutralForeground3 }}>
              Total duration: {formatMs(totalMs)}
            </Text>
          )}
        </div>

        {loading && !retrying && <Spinner label="Loading trace…" />}
        {retrying && (
          <MessageBar intent="warning">
            <MessageBarBody>
              Trace data is still being processed in Phoenix. Retrying…
            </MessageBarBody>
          </MessageBar>
        )}
        {error && (
          <div style={{ padding: '0 16px' }}>
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
            <Button
              appearance="primary"
              style={{ marginTop: 12 }}
              onClick={() => void loadSpans(false)}
            >
              Retry
            </Button>
          </div>
        )}
        {!loading && !error && spans.length === 0 && (
          <div className={styles.emptyHint}>
            <Text>No spans found for this trace yet. Try Refresh in a few seconds.</Text>
            <Button appearance="primary" style={{ marginTop: 12 }} onClick={() => void loadSpans(false)}>
              Refresh
            </Button>
          </div>
        )}

        {!loading && !error && spans.length > 0 && (
          <div className={styles.splitMain}>
            <div className={styles.listPane}>
              <TimelineRuler totalMs={totalMs} />
              <div
                className={styles.listPaneScroll}
                role="listbox"
                aria-label="Trace spans"
                aria-activedescendant={selectedSpanId ? `trace-span-${selectedSpanId}` : undefined}
              >
                {ordered.map(({ span, depth }) => {
                  const sid = span.context.span_id
                  return (
                    <SpanListRow
                      key={sid}
                      span={span}
                      depth={depth}
                      selected={selectedSpanId === sid}
                      traceStartMs={traceStart}
                      totalMs={totalMs}
                      onSelect={() => setSelectedSpanId(sid)}
                    />
                  )
                })}
              </div>
            </div>
            <div
              className={`${styles.detailPane} ${narrow ? styles.detailPaneNarrow : styles.detailPaneWide}`}
            >
              <SpanDetailPanel
                span={selectedSpan}
                traceStartMs={traceStart}
                totalMs={totalMs}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export default TraceDrawer
