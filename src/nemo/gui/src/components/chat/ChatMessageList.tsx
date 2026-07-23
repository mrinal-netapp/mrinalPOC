import { forwardRef, useState } from 'react'
import { makeStyles, tokens, Text, Link, mergeClasses } from '@fluentui/react-components'
import {
  Bot24Regular,
  Person24Regular,
  DocumentArrowDown20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
  Timer16Regular,
  BrainCircuit20Regular,
  Clock16Regular,
} from '@fluentui/react-icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import FilePreviewModal from '../FilePreviewModal'
import { TokenUsage } from '../../services/api'

export interface Citation {
  source: string
  documentId?: string
  downloadUrl?: string
  knowledgeBaseId?: string
  knowledgeBaseName?: string
  score?: number
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  latencyMs?: number
  modelName?: string
  usage?: TokenUsage
  citations?: Citation[]
}

interface ChatMessageListProps {
  messages: ChatMessage[]
  streamingText: string
  isStreaming: boolean
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (isToday) return time
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

function friendlyFileName(source: string): string {
  const parts = source.split('/')
  return parts[parts.length - 1] || source
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflowY: 'auto',
    padding: '16px',
    gap: '12px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: '8px',
    color: tokens.colorNeutralForeground3,
  },
  messageRow: {
    display: 'flex',
    gap: '8px',
    maxWidth: '80%',
  },
  userRow: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  assistantRow: {
    alignSelf: 'flex-start',
  },
  avatar: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  userAvatar: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  assistantAvatar: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
  },
  bubble: {
    padding: '10px 14px',
    borderRadius: '12px',
    lineHeight: '1.5',
    wordBreak: 'break-word',
  },
  userBubble: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    borderTopRightRadius: '4px',
  },
  assistantBubble: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    borderTopLeftRadius: '4px',
  },
  markdown: {
    '& p': { marginTop: 0, marginBottom: '8px' },
    '& p:last-child': { marginBottom: 0 },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '12px',
      borderRadius: '8px',
      overflowX: 'auto',
      fontSize: '13px',
    },
    '& code': {
      fontFamily: 'monospace',
      fontSize: '13px',
    },
    '& :not(pre) > code': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '2px 6px',
      borderRadius: '4px',
    },
    '& table': {
      borderCollapse: 'collapse',
      width: '100%',
      marginBottom: '8px',
    },
    '& th, & td': {
      border: `1px solid ${tokens.colorNeutralStroke1}`,
      padding: '6px 10px',
      textAlign: 'left',
    },
    '& th': {
      backgroundColor: tokens.colorNeutralBackground4,
      fontWeight: 600,
    },
    '& ul, & ol': { paddingLeft: '20px', marginTop: 0, marginBottom: '8px' },
    '& blockquote': {
      borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
      marginLeft: 0,
      paddingLeft: '12px',
      color: tokens.colorNeutralForeground3,
    },
  },
  cursor: {
    display: 'inline-block',
    width: '2px',
    height: '1em',
    backgroundColor: tokens.colorNeutralForeground1,
    marginLeft: '2px',
    verticalAlign: 'text-bottom',
    animationName: {
      '0%, 100%': { opacity: 1 },
      '50%': { opacity: 0 },
    },
    animationDuration: '1s',
    animationIterationCount: 'infinite',
  },
  // Thinking indicator
  thinkingRow: {
    display: 'flex',
    gap: '8px',
    maxWidth: '80%',
    alignSelf: 'flex-start',
  },
  thinkingBubble: {
    padding: '14px 20px',
    borderRadius: '12px',
    borderTopLeftRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  thinkingIcon: {
    color: tokens.colorBrandForeground1,
    animationName: {
      '0%, 100%': { opacity: 0.5 },
      '50%': { opacity: 1 },
    },
    animationDuration: '1.5s',
    animationIterationCount: 'infinite',
  },
  thinkingDots: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: tokens.colorNeutralForeground3,
    animationName: {
      '0%, 80%, 100%': { transform: 'scale(0.6)', opacity: 0.4 },
      '40%': { transform: 'scale(1)', opacity: 1 },
    },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
  },
  dot1: { animationDelay: '0s' },
  dot2: { animationDelay: '0.2s' },
  dot3: { animationDelay: '0.4s' },
  thinkingLabel: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground3,
  },
  // Metadata row (latency + model)
  messageMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '4px',
    paddingLeft: '2px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
  },
  // Citations
  citationsContainer: {
    marginTop: '6px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '6px',
  },
  citationsToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    border: 'none',
    background: 'none',
    padding: '2px 0',
    ':hover': {
      color: tokens.colorNeutralForeground2,
    },
  },
  citationsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    marginTop: '4px',
  },
  citationItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 8px',
    borderRadius: '6px',
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: '12px',
  },
  citationIcon: {
    color: tokens.colorBrandForeground1,
    flexShrink: 0,
  },
  citationName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  citationScore: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
})

function CitationsSection({ citations }: { citations: Citation[] }) {
  const styles = useStyles()
  const [expanded, setExpanded] = useState(false)
  const [previewCitation, setPreviewCitation] = useState<Citation | null>(null)

  if (!citations.length) return null

  return (
    <div className={styles.citationsContainer}>
      <button
        className={styles.citationsToggle}
        onClick={() => setExpanded(!expanded)}
      >
        <DocumentArrowDown20Regular />
        <span>{citations.length} source{citations.length !== 1 ? 's' : ''} cited</span>
        {expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
      </button>
      {expanded && (
        <div className={styles.citationsList}>
          {citations.map((c, idx) => (
            <div key={idx} className={styles.citationItem}>
              <DocumentArrowDown20Regular className={styles.citationIcon} />
              <span className={styles.citationName} title={c.source}>
                {c.downloadUrl ? (
                  <Link
                    as="button"
                    onClick={(e) => { e.stopPropagation(); setPreviewCitation(c) }}
                  >
                    {friendlyFileName(c.source)}
                  </Link>
                ) : (
                  friendlyFileName(c.source)
                )}
              </span>
              {c.knowledgeBaseName && (
                <Text size={100} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>
                  {c.knowledgeBaseName}
                </Text>
              )}
              {c.score != null && (
                <span className={styles.citationScore}>
                  {(c.score * 100).toFixed(0)}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {previewCitation?.downloadUrl && (
        <FilePreviewModal
          url={previewCitation.downloadUrl}
          fileName={friendlyFileName(previewCitation.source)}
          onClose={() => setPreviewCitation(null)}
        />
      )}
    </div>
  )
}

const ChatMessageList = forwardRef<HTMLDivElement, ChatMessageListProps>(
  ({ messages, streamingText, isStreaming }, ref) => {
    const styles = useStyles()

    if (messages.length === 0 && !isStreaming) {
      return (
        <div className={styles.container} ref={ref}>
          <div className={styles.emptyState}>
            <Bot24Regular style={{ fontSize: 48 }} />
            <Text size={400} weight="semibold">
              Send a message to start testing this agent
            </Text>
            <Text size={300}>
              Your conversation will appear here
            </Text>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.container} ref={ref}>
        {messages.map((msg, i) => (
          <div key={i}>
            <div
              className={`${styles.messageRow} ${
                msg.role === 'user' ? styles.userRow : styles.assistantRow
              }`}
            >
              <div
                className={`${styles.avatar} ${
                  msg.role === 'user' ? styles.userAvatar : styles.assistantAvatar
                }`}
              >
                {msg.role === 'user' ? (
                  <Person24Regular style={{ fontSize: 16 }} />
                ) : (
                  <Bot24Regular style={{ fontSize: 16 }} />
                )}
              </div>
              <div>
                <div
                  className={`${styles.bubble} ${
                    msg.role === 'user' ? styles.userBubble : styles.assistantBubble
                  }`}
                >
                  {msg.role === 'user' ? (
                    msg.content
                  ) : (
                    <div className={styles.markdown}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                      {msg.citations && msg.citations.length > 0 && (
                        <CitationsSection citations={msg.citations} />
                      )}
                    </div>
                  )}
                </div>
                {(msg.timestamp || (msg.role === 'assistant' && (msg.latencyMs || msg.modelName || msg.usage))) && (
                  <div className={styles.messageMeta} style={msg.role === 'user' ? { justifyContent: 'flex-end' } : undefined}>
                    {msg.timestamp && (
                      <span className={styles.metaItem}>
                        <Clock16Regular style={{ fontSize: 13 }} />
                        {formatTimestamp(msg.timestamp)}
                      </span>
                    )}
                    {msg.role === 'assistant' && msg.modelName && (
                      <span className={styles.metaItem}>
                        <BrainCircuit20Regular style={{ fontSize: 13 }} />
                        {msg.modelName}
                      </span>
                    )}
                    {msg.role === 'assistant' && msg.latencyMs != null && (
                      <span className={styles.metaItem}>
                        <Timer16Regular style={{ fontSize: 13 }} />
                        {formatLatency(msg.latencyMs)}
                      </span>
                    )}
                    {msg.role === 'assistant' && msg.usage?.promptTokens != null && (
                      <span className={styles.metaItem}>P {msg.usage.promptTokens}</span>
                    )}
                    {msg.role === 'assistant' && msg.usage?.completionTokens != null && (
                      <span className={styles.metaItem}>C {msg.usage.completionTokens}</span>
                    )}
                    {msg.role === 'assistant' && msg.usage?.totalTokens != null && (
                      <span className={styles.metaItem}>T {msg.usage.totalTokens}</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Thinking indicator -- shown while waiting for the backend response */}
        {isStreaming && !streamingText && (
          <div className={styles.thinkingRow}>
            <div className={mergeClasses(styles.avatar, styles.assistantAvatar)}>
              <Bot24Regular style={{ fontSize: 16 }} />
            </div>
            <div className={styles.thinkingBubble}>
              <BrainCircuit20Regular className={styles.thinkingIcon} style={{ fontSize: 18 }} />
              <div className={styles.thinkingDots}>
                <div className={mergeClasses(styles.dot, styles.dot1)} />
                <div className={mergeClasses(styles.dot, styles.dot2)} />
                <div className={mergeClasses(styles.dot, styles.dot3)} />
              </div>
              <span className={styles.thinkingLabel}>Thinking...</span>
            </div>
          </div>
        )}

        {/* Streaming text reveal with blinking cursor */}
        {isStreaming && streamingText && (
          <div className={`${styles.messageRow} ${styles.assistantRow}`}>
            <div className={`${styles.avatar} ${styles.assistantAvatar}`}>
              <Bot24Regular style={{ fontSize: 16 }} />
            </div>
            <div className={`${styles.bubble} ${styles.assistantBubble}`}>
              <div className={styles.markdown}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {streamingText}
                </ReactMarkdown>
                <span className={styles.cursor} />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
)

ChatMessageList.displayName = 'ChatMessageList'

export default ChatMessageList
