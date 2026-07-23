import { useEffect, useMemo, useState, type FC } from 'react'
import {
  makeStyles,
  tokens,
  Text,
  Badge,
  TabList,
  Tab,
} from '@fluentui/react-components'
import type { TraceSpan } from '../../../services/api'
import {
  formatAbsoluteTime,
  formatOffsetMs,
} from '../traceRenderUtils'
import { pickAttr, spanDurationMs, formatMs } from './spanWaterfall'
import { TraceRawAttributes, TraceSpanField } from './TraceSpanField'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    flex: 1,
  },
  header: {
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  scroll: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    fontSize: '12px',
  },
  kvRow: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr',
    gap: '6px 12px',
    marginBottom: '6px',
    alignItems: 'start',
  },
  kvKey: {
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
  },
  kvVal: {
    wordBreak: 'break-word',
    fontSize: '12px',
  },
  empty: {
    padding: '24px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
  eventRow: {
    marginBottom: '10px',
    padding: '8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    fontSize: '11px',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
})

const INPUT_KEYS = ['input.value', 'input', 'llm.input_messages'] as const
const OUTPUT_KEYS = ['output.value', 'output', 'llm.output_messages'] as const

export interface SpanDetailPanelProps {
  span: TraceSpan | null
  traceStartMs: number
  totalMs: number
}

export const SpanDetailPanel: FC<SpanDetailPanelProps> = ({
  span,
  traceStartMs,
  totalMs,
}) => {
  const styles = useStyles()
  const [tab, setTab] = useState<'overview' | 'io' | 'attributes' | 'events'>('overview')

  const spanId = span?.context.span_id

  const attrs = span?.attributes ?? {}
  const dur = span ? spanDurationMs(span) : 0
  const offsetMs = span
    ? new Date(span.start_time).getTime() - traceStartMs
    : 0

  const eventsList = useMemo(() => {
    const ev = span?.events
    if (!Array.isArray(ev) || ev.length === 0) return []
    return ev as Array<Record<string, unknown>>
  }, [span?.events])

  const hasEvents = eventsList.length > 0

  useEffect(() => {
    setTab('overview')
  }, [spanId])

  useEffect(() => {
    if (tab === 'events' && !hasEvents) setTab('overview')
  }, [tab, hasEvents])

  if (!span) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>
          <Text>Select a span to view details</Text>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text weight="semibold" size={300} block truncate wrap={false} title={span.name}>
          {span.name}
        </Text>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
          <Badge appearance="filled" color="informative" size="small">
            {span.span_kind || '—'}
          </Badge>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            {formatMs(dur)}
          </Text>
          {span.status_code === 'ERROR' && (
            <Badge appearance="filled" color="danger" size="small">
              {span.status_code}
            </Badge>
          )}
        </div>
      </div>

      <TabList
        selectedValue={tab}
        onTabSelect={(_, data) => {
          const v = data.value
          if (v === 'overview' || v === 'io' || v === 'attributes' || v === 'events') {
            setTab(v)
          }
        }}
      >
        <Tab value="overview">Overview</Tab>
        <Tab value="io">Input / output</Tab>
        <Tab value="attributes">Attributes</Tab>
        {hasEvents && <Tab value="events">Events</Tab>}
      </TabList>

      <div className={styles.scroll}>
        {tab === 'overview' && (
          <div>
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Status</span>
              <span className={styles.kvVal}>{span.status_code}</span>
            </div>
            {span.status_message && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>Status message</span>
                <span className={styles.kvVal}>{span.status_message}</span>
              </div>
            )}
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Duration</span>
              <span className={styles.kvVal}>{formatMs(dur)}</span>
            </div>
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Offset from trace start</span>
              <span className={styles.kvVal}>{formatOffsetMs(offsetMs)} (of {formatMs(totalMs)} total)</span>
            </div>
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>Start</span>
              <span className={styles.kvVal}>{formatAbsoluteTime(span.start_time)}</span>
            </div>
            <div className={styles.kvRow}>
              <span className={styles.kvKey}>End</span>
              <span className={styles.kvVal}>{formatAbsoluteTime(span.end_time)}</span>
            </div>
            {pickAttr(attrs, ['llm.model_name', 'model_name']) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>Model</span>
                <span className={styles.kvVal}>{pickAttr(attrs, ['llm.model_name', 'model_name'])}</span>
              </div>
            )}
            {(pickAttr(attrs, ['llm.token_count.prompt', 'input_tokens']) ||
              pickAttr(attrs, ['llm.token_count.completion', 'output_tokens'])) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>Tokens</span>
                <span className={styles.kvVal}>
                  P {pickAttr(attrs, ['llm.token_count.prompt', 'input_tokens']) ?? '—'} / C{' '}
                  {pickAttr(attrs, ['llm.token_count.completion', 'output_tokens']) ?? '—'}
                </span>
              </div>
            )}
            {pickAttr(attrs, ['session.id']) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>session.id</span>
                <span className={styles.kvVal}>{pickAttr(attrs, ['session.id'])}</span>
              </div>
            )}
            {pickAttr(attrs, ['project.id']) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>project.id</span>
                <span className={styles.kvVal}>{pickAttr(attrs, ['project.id'])}</span>
              </div>
            )}
            {pickAttr(attrs, ['agent.id']) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>agent.id</span>
                <span className={styles.kvVal}>{pickAttr(attrs, ['agent.id'])}</span>
              </div>
            )}
            {pickAttr(attrs, ['team.id']) && (
              <div className={styles.kvRow}>
                <span className={styles.kvKey}>team.id</span>
                <span className={styles.kvVal}>{pickAttr(attrs, ['team.id'])}</span>
              </div>
            )}
          </div>
        )}

        {tab === 'io' && (
          <div>
            {INPUT_KEYS.map((k) => {
              const v = attrs[k]
              if (v == null) return null
              return <TraceSpanField key={k} label={k} value={v} />
            })}
            {OUTPUT_KEYS.map((k) => {
              const v = attrs[k]
              if (v == null) return null
              return <TraceSpanField key={k} label={k} value={v} />
            })}
            {!INPUT_KEYS.some((k) => attrs[k] != null) &&
              !OUTPUT_KEYS.some((k) => attrs[k] != null) && (
                <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                  No input/output attributes on this span.
                </Text>
              )}
          </div>
        )}

        {tab === 'attributes' && (
          <div>
            <TraceRawAttributes attrs={attrs} />
          </div>
        )}

        {tab === 'events' && hasEvents && (
          <div>
            {eventsList.map((ev, i) => {
              const name = typeof ev.name === 'string' ? ev.name : 'event'
              const ts = ev.timestamp ?? ev.time ?? ''
              const rest = { ...ev }
              delete rest.name
              delete rest.timestamp
              delete rest.time
              return (
                <div key={i} className={styles.eventRow}>
                  <Text weight="semibold" size={200}>
                    {String(name)}
                  </Text>
                  {ts !== '' && (
                    <Text size={100} block style={{ marginBottom: 4 }}>
                      {String(ts)}
                    </Text>
                  )}
                  {Object.keys(rest).length > 0 && (
                    <Text size={100} style={{ fontFamily: 'monospace' }}>
                      {JSON.stringify(rest, null, 2)}
                    </Text>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
