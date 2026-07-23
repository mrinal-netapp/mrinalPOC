import { makeStyles, tokens, Text, Badge } from '@fluentui/react-components'
import type { TraceSpan } from '../../../services/api'
import { formatOffsetMs } from '../traceRenderUtils'
import { formatMs, kindColor, spanDurationMs } from './spanWaterfall'

const useStyles = makeStyles({
  row: {
    marginBottom: '8px',
    borderRadius: '6px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  rowSelected: {
    border: `2px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
  },
  depthGuide: {
    borderLeftWidth: '3px',
    borderLeftStyle: 'solid',
    borderLeftColor: tokens.colorNeutralStroke2,
    paddingLeft: '6px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 8px',
    cursor: 'pointer',
    width: '100%',
    border: 'none',
    background: 'transparent',
    textAlign: 'left',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3,
    },
  },
  timing: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    flexShrink: 0,
    gap: '2px',
  },
  spanBarTrack: {
    position: 'relative',
    height: '8px',
    backgroundColor: tokens.colorNeutralBackground4,
    margin: '0 8px 8px',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  spanBarFill: {
    position: 'absolute',
    top: 0,
    height: '100%',
    borderRadius: '4px',
  },
})

export interface SpanListRowProps {
  span: TraceSpan
  depth: number
  selected: boolean
  traceStartMs: number
  totalMs: number
  onSelect: () => void
}

export function SpanListRow({
  span,
  depth,
  selected,
  traceStartMs,
  totalMs,
  onSelect,
}: SpanListRowProps) {
  const styles = useStyles()
  const sid = span.context.span_id
  const dur = spanDurationMs(span)
  const start = new Date(span.start_time).getTime()
  const offsetMs = start - traceStartMs
  const leftPct = ((start - traceStartMs) / totalMs) * 100
  const widthPct = (dur / totalMs) * 100

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''}`}
      style={{ marginLeft: depth * 12 }}
    >
      <button
        type="button"
        className={`${styles.header} ${styles.depthGuide}`}
        style={{ borderLeftColor: depth > 0 ? tokens.colorBrandStroke1 : tokens.colorNeutralStroke2 }}
        onClick={onSelect}
        role="option"
        aria-selected={selected}
        id={`trace-span-${sid}`}
      >
        <Badge appearance="filled" color="informative" size="small">
          {span.span_kind || '—'}
        </Badge>
        <Text size={200} weight="semibold" style={{ flex: 1, minWidth: 0 }}>
          {span.name}
        </Text>
        <div className={styles.timing}>
          <Text size={100} style={{ color: tokens.colorNeutralForeground3, fontFamily: 'monospace' }}>
            {formatOffsetMs(offsetMs)}
          </Text>
          <Text size={100} style={{ color: tokens.colorNeutralForeground3 }}>
            {formatMs(dur)}
          </Text>
        </div>
        {span.status_code === 'ERROR' && (
          <Badge appearance="filled" color="danger" size="small">
            ERROR
          </Badge>
        )}
      </button>
      <div className={styles.spanBarTrack}>
        <div
          className={styles.spanBarFill}
          style={{
            left: `${Math.min(100, Math.max(0, leftPct))}%`,
            width: `${Math.min(100, Math.max(0.5, widthPct))}%`,
            backgroundColor: kindColor(span.span_kind || ''),
          }}
        />
      </div>
    </div>
  )
}
