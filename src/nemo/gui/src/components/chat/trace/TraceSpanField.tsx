import { useMemo, useState, type FC } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  makeStyles,
  tokens,
  Button,
  Badge,
} from '@fluentui/react-components'
import {
  looksLikeMarkdown,
  stringifyForRaw,
  tryExtractOpenInferenceMessages,
  unwrapJsonStringLayers,
} from '../traceRenderUtils'
import { AttributesJsonView } from './AttributesJsonView'

const useStyles = makeStyles({
  attrKey: {
    color: tokens.colorNeutralForeground3,
    marginTop: '6px',
  },
  attrVal: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'monospace',
    fontSize: '11px',
  },
  mdBox: {
    marginTop: '4px',
    padding: '8px',
    borderRadius: '4px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    maxHeight: 'min(60vh, 480px)',
    overflowY: 'auto',
  },
  mdContent: {
    fontSize: '12px',
    lineHeight: 1.45,
    '& p': { margin: '0 0 0.5em' },
    '& pre': {
      fontSize: '11px',
      overflow: 'auto',
      padding: '6px',
      borderRadius: '4px',
      backgroundColor: tokens.colorNeutralBackground4,
    },
    '& code': { fontFamily: 'monospace', fontSize: '11px' },
    '& ul, & ol': { margin: '0.25em 0', paddingLeft: '1.25em' },
  },
})

const ATTR_PREVIEW_MAX = 8000

export interface TraceSpanFieldProps {
  label: string
  value: unknown
}

/** OpenInference-style attributes: unwrap JSON-in-string, messages as markdown, Raw toggle. */
export const TraceSpanField: FC<TraceSpanFieldProps> = ({ label, value }) => {
  const styles = useStyles()
  const [raw, setRaw] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const unwrapped = useMemo(() => unwrapJsonStringLayers(value), [value])
  const messages = useMemo(
    () => (!raw ? tryExtractOpenInferenceMessages(unwrapped) : null),
    [unwrapped, raw],
  )

  const rawText = useMemo(() => stringifyForRaw(value), [value])
  const smartText = useMemo(() => {
    if (typeof unwrapped === 'object' && unwrapped !== null) {
      return JSON.stringify(unwrapped, null, 2)
    }
    if (typeof unwrapped === 'string') return unwrapped
    return String(unwrapped)
  }, [unwrapped])

  const display = raw ? rawText : smartText
  const needsTruncate = display.length > ATTR_PREVIEW_MAX
  const shown = !expanded && needsTruncate ? `${display.slice(0, ATTR_PREVIEW_MAX)}…` : display

  const mdString =
    !raw && typeof unwrapped === 'string' && looksLikeMarkdown(unwrapped) ? unwrapped : null

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
          flexWrap: 'wrap',
        }}
      >
        <div className={styles.attrKey} style={{ marginTop: 0, flex: 1 }}>
          {label}
        </div>
        <Button size="small" appearance="subtle" onClick={() => setRaw((r) => !r)}>
          {raw ? 'Formatted' : 'Raw'}
        </Button>
        {needsTruncate && (
          <Button size="small" appearance="subtle" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Collapse' : 'Expand'}
          </Button>
        )}
      </div>

      {raw ? (
        <div className={styles.attrVal}>{shown}</div>
      ) : messages ? (
        <div className={styles.mdBox}>
          {messages.map((m, i) => (
            <div key={`${m.role}-${i}`} style={{ marginBottom: 10 }}>
              <Badge appearance="outline" size="small">
                {m.role}
              </Badge>
              <div className={styles.mdContent}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              </div>
            </div>
          ))}
        </div>
      ) : mdString ? (
        <div className={styles.mdBox}>
          <div className={styles.mdContent}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{mdString}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <div className={styles.attrVal}>{shown}</div>
      )}
    </div>
  )
}

/** Pretty-printed + syntax-highlighted JSON (Monaco); optional unwrap of nested JSON strings. */
export const TraceRawAttributes: FC<{ attrs: Record<string, unknown> }> = ({ attrs }) => (
  <AttributesJsonView attrs={attrs} />
)
