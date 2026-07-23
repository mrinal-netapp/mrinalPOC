import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Button,
  Text,
  Link,
  Spinner,
  Textarea,
  Badge,
  Dropdown,
  Option,
  mergeClasses,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  Send24Regular,
  Add24Regular,
  Dismiss24Regular,
  Bot24Regular,
  Person24Regular,
  BrainCircuit20Regular,
  Timer16Regular,
  Clock16Regular,
  DocumentArrowDown20Regular,
  ChevronDown16Regular,
  ChevronUp16Regular,
} from '@fluentui/react-icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { agentApi, agentInvokeApi, Agent, TokenUsage } from '../services/api'
import { useToast } from '../contexts/ToastContext'
import FilePreviewModal from '../components/FilePreviewModal'

interface PaneCitation {
  source: string
  downloadUrl?: string
  knowledgeBaseName?: string
  score?: number
}

interface PaneMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  latencyMs?: number
  modelName?: string
  usage?: TokenUsage
  citations?: PaneCitation[]
}

interface AgentPane {
  agentId: string
  agent: Agent | null
  messages: PaneMessage[]
  isStreaming: boolean
  streamingText: string
  sessionId: string | null
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headerTitle: {
    flex: 1,
  },
  panesContainer: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  pane: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    minWidth: '300px',
    ':last-child': {
      borderRight: 'none',
    },
  },
  paneHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  paneMessages: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  messageRow: {
    display: 'flex',
    gap: '8px',
    maxWidth: '95%',
  },
  userRow: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  assistantRow: {
    alignSelf: 'flex-start',
  },
  avatar: {
    width: '28px',
    height: '28px',
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
    padding: '8px 12px',
    borderRadius: '10px',
    lineHeight: '1.5',
    fontSize: '13px',
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
    '& p': { marginTop: 0, marginBottom: '6px' },
    '& p:last-child': { marginBottom: 0 },
    '& pre': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '8px',
      borderRadius: '6px',
      overflowX: 'auto',
      fontSize: '12px',
    },
    '& code': { fontFamily: 'monospace', fontSize: '12px' },
    '& :not(pre) > code': {
      backgroundColor: tokens.colorNeutralBackground4,
      padding: '1px 4px',
      borderRadius: '3px',
    },
  },
  messageMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginTop: '3px',
    paddingLeft: '2px',
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
  },
  metaItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  },
  inputBar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: '8px',
    padding: '12px 16px',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  inputWrapper: {
    flex: 1,
  },
  emptyPane: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: '12px',
    padding: '24px',
    color: tokens.colorNeutralForeground3,
  },
  addPane: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '200px',
    maxWidth: '280px',
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: 'pointer',
    gap: '8px',
    color: tokens.colorNeutralForeground3,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
  thinkingDots: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    padding: '8px 12px',
  },
  dot: {
    width: '5px',
    height: '5px',
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
  citationsContainer: {
    marginTop: '6px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '4px',
  },
  citationsToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    border: 'none',
    background: 'none',
    padding: '2px 0',
    ':hover': { color: tokens.colorNeutralForeground2 },
  },
  citationsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '3px',
    marginTop: '3px',
  },
  citationItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 6px',
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground4,
    fontSize: '11px',
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
    fontSize: '10px',
    color: tokens.colorNeutralForeground3,
    flexShrink: 0,
  },
})

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function friendlyFileName(source: string): string {
  const parts = source.split('/')
  return parts[parts.length - 1] || source
}

function PaneCitationsSection({
  citations,
  onPreview,
}: {
  citations: PaneCitation[]
  onPreview: (url: string, name: string) => void
}) {
  const styles = useStyles()
  const [expanded, setExpanded] = useState(false)

  if (!citations.length) return null

  return (
    <div className={styles.citationsContainer}>
      <button className={styles.citationsToggle} onClick={() => setExpanded(!expanded)}>
        <DocumentArrowDown20Regular style={{ fontSize: 14 }} />
        <span>{citations.length} source{citations.length !== 1 ? 's' : ''}</span>
        {expanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
      </button>
      {expanded && (
        <div className={styles.citationsList}>
          {citations.map((c, idx) => (
            <div key={idx} className={styles.citationItem}>
              <DocumentArrowDown20Regular className={styles.citationIcon} style={{ fontSize: 13 }} />
              <span className={styles.citationName} title={c.source}>
                {c.downloadUrl ? (
                  <Link
                    as="button"
                    onClick={(e) => { e.stopPropagation(); onPreview(c.downloadUrl!, friendlyFileName(c.source)) }}
                    style={{ fontSize: '11px' }}
                  >
                    {friendlyFileName(c.source)}
                  </Link>
                ) : (
                  friendlyFileName(c.source)
                )}
              </span>
              {c.score != null && (
                <span className={styles.citationScore}>{(c.score * 100).toFixed(0)}%</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AgentPlayground() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [agents, setAgents] = useState<Agent[]>([])
  const [loading, setLoading] = useState(true)
  const [panes, setPanes] = useState<AgentPane[]>([])
  const [inputValue, setInputValue] = useState('')
  const [showAddDropdown, setShowAddDropdown] = useState(false)
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null)
  const abortRefs = useRef<Map<string, AbortController>>(new Map())
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    if (!projectId) return
    const load = async () => {
      try {
        const data = await agentApi.list(projectId)
        setAgents(data)

        const preselected = searchParams.get('agents')
        if (preselected) {
          const ids = preselected.split(',').filter(Boolean)
          const initialPanes: AgentPane[] = ids.map(id => ({
            agentId: id,
            agent: data.find(a => a.id === id) || null,
            messages: [],
            isStreaming: false,
            streamingText: '',
            sessionId: null,
          }))
          setPanes(initialPanes)
        }
      } catch {
        showToast('Failed to load agents', 'error')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [projectId, searchParams, showToast])

  const addPane = useCallback((agentId: string) => {
    const agent = agents.find(a => a.id === agentId)
    setPanes(prev => [
      ...prev,
      {
        agentId,
        agent: agent || null,
        messages: [],
        isStreaming: false,
        streamingText: '',
        sessionId: null,
      },
    ])
    setShowAddDropdown(false)
  }, [agents])

  const removePane = useCallback((agentId: string) => {
    setPanes(prev => prev.filter(p => p.agentId !== agentId))
    abortRefs.current.get(agentId)?.abort()
    abortRefs.current.delete(agentId)
    const timer = typingTimers.current.get(agentId)
    if (timer) clearTimeout(timer)
    typingTimers.current.delete(agentId)
  }, [])

  const revealText = useCallback(
    (agentId: string, fullText: string, onComplete: () => void) => {
      const CHARS_PER_TICK = 8
      const TICK_MS = 16
      let pos = 0

      const tick = () => {
        pos = Math.min(pos + CHARS_PER_TICK, fullText.length)
        setPanes(prev => prev.map(p =>
          p.agentId === agentId ? { ...p, streamingText: fullText.slice(0, pos) } : p
        ))
        if (pos < fullText.length) {
          typingTimers.current.set(agentId, setTimeout(tick, TICK_MS))
        } else {
          onComplete()
        }
      }
      tick()
    },
    [],
  )

  const handleSend = useCallback(() => {
    if (!projectId || !inputValue.trim() || panes.length === 0) return
    const message = inputValue.trim()
    setInputValue('')
    const now = new Date().toISOString()

    setPanes(prev => prev.map(p => ({
      ...p,
      messages: [...p.messages, { role: 'user' as const, content: message, timestamp: now }],
      isStreaming: true,
      streamingText: '',
    })))

    for (const pane of panes) {
      const controller = agentInvokeApi.invoke(
        projectId,
        pane.agentId,
        message,
        pane.sessionId,
        (responseText, sessionId, metadata) => {
          const citations: PaneCitation[] | undefined = metadata?.citations?.map((c: any) => ({
            source: c.source,
            downloadUrl: c.downloadUrl,
            knowledgeBaseName: c.knowledgeBaseName,
            score: c.score,
          }))
          revealText(pane.agentId, responseText, () => {
            setPanes(prev => prev.map(p =>
              p.agentId === pane.agentId
                ? {
                    ...p,
                    messages: [
                      ...p.messages,
                      {
                        role: 'assistant' as const,
                        content: responseText,
                        timestamp: new Date().toISOString(),
                        latencyMs: metadata?.latencyMs,
                        modelName: metadata?.modelName,
                        usage: metadata?.usage,
                        citations: citations?.length ? citations : undefined,
                      },
                    ],
                    isStreaming: false,
                    streamingText: '',
                    sessionId,
                  }
                : p
            ))
          })
        },
        (errMsg) => {
          setPanes(prev => prev.map(p =>
            p.agentId === pane.agentId
              ? { ...p, isStreaming: false, streamingText: '' }
              : p
          ))
          showToast(`${pane.agent?.name || pane.agentId}: ${errMsg}`, 'error')
        },
      )
      abortRefs.current.set(pane.agentId, controller)
    }
  }, [projectId, inputValue, panes, revealText, showToast])

  const anyStreaming = panes.some(p => p.isStreaming)
  const usedAgentIds = new Set(panes.map(p => p.agentId))
  const availableAgents = agents.filter(a => !usedAgentIds.has(a.id))

  if (loading) {
    return (
      <div className={styles.root}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
          <Spinner size="large" label="Loading agents..." />
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button
          icon={<ArrowLeft24Regular />}
          appearance="subtle"
          onClick={() => navigate(`/projects/${projectId}/agents`)}
          title="Back to agents"
        />
        <Text size={400} weight="semibold" className={styles.headerTitle}>
          Agent Playground
        </Text>
        <Badge appearance="outline" size="small">
          {panes.length} agent{panes.length !== 1 ? 's' : ''}
        </Badge>
        {availableAgents.length > 0 && (
          <div style={{ position: 'relative' }}>
            <Button
              icon={<Add24Regular />}
              appearance="secondary"
              size="small"
              onClick={() => setShowAddDropdown(!showAddDropdown)}
            >
              Add Agent
            </Button>
            {showAddDropdown && (
              <div style={{
                position: 'absolute',
                right: 0,
                top: '100%',
                marginTop: '4px',
                zIndex: 100,
                minWidth: '220px',
              }}>
                <Dropdown
                  open
                  placeholder="Select agent"
                  onOptionSelect={(_, data) => {
                    if (data.optionValue) addPane(data.optionValue)
                  }}
                >
                  {availableAgents.map(a => (
                    <Option key={a.id} value={a.id} text={a.name}>
                      {a.name} — {a.role}
                    </Option>
                  ))}
                </Dropdown>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.panesContainer}>
        {panes.length === 0 ? (
          <div className={styles.emptyPane}>
            <Bot24Regular style={{ fontSize: 48 }} />
            <Text size={400} weight="semibold">Agent Playground</Text>
            <Text size={300}>
              Add agents to compare their responses side-by-side.
              Send one message and see how each agent responds.
            </Text>
            {availableAgents.length > 0 && (
              <Dropdown
                placeholder="Select an agent to start"
                onOptionSelect={(_, data) => {
                  if (data.optionValue) addPane(data.optionValue)
                }}
                style={{ minWidth: '240px' }}
              >
                {availableAgents.map(a => (
                  <Option key={a.id} value={a.id} text={a.name}>
                    {a.name} — {a.role}
                  </Option>
                ))}
              </Dropdown>
            )}
          </div>
        ) : (
          panes.map((pane) => (
            <div key={pane.agentId} className={styles.pane}>
              <div className={styles.paneHeader}>
                <Bot24Regular style={{ fontSize: 16 }} />
                <Text size={300} weight="semibold" style={{ flex: 1 }}>
                  {pane.agent?.name || pane.agentId}
                </Text>
                {pane.agent?.role && (
                  <Badge appearance="outline" size="small">{pane.agent.role}</Badge>
                )}
                <Button
                  icon={<Dismiss24Regular />}
                  size="small"
                  appearance="subtle"
                  onClick={() => removePane(pane.agentId)}
                  title="Remove agent"
                />
              </div>
              <div className={styles.paneMessages}>
                {pane.messages.length === 0 && !pane.isStreaming && (
                  <div style={{ textAlign: 'center', color: tokens.colorNeutralForeground3, padding: '24px' }}>
                    <Text size={200}>Waiting for a message...</Text>
                  </div>
                )}
                {pane.messages.map((msg, i) => (
                  <div key={i}>
                    <div className={`${styles.messageRow} ${msg.role === 'user' ? styles.userRow : styles.assistantRow}`}>
                      <div className={`${styles.avatar} ${msg.role === 'user' ? styles.userAvatar : styles.assistantAvatar}`}>
                        {msg.role === 'user' ? <Person24Regular style={{ fontSize: 14 }} /> : <Bot24Regular style={{ fontSize: 14 }} />}
                      </div>
                      <div>
                        <div className={`${styles.bubble} ${msg.role === 'user' ? styles.userBubble : styles.assistantBubble}`}>
                          {msg.role === 'user' ? (
                            msg.content
                          ) : (
                            <div className={styles.markdown}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                              {msg.citations && msg.citations.length > 0 && (
                                <PaneCitationsSection
                                  citations={msg.citations}
                                  onPreview={(url, name) => setPreviewFile({ url, name })}
                                />
                              )}
                            </div>
                          )}
                        </div>
                        {(msg.timestamp || msg.latencyMs || msg.modelName || msg.usage) && (
                          <div className={styles.messageMeta} style={msg.role === 'user' ? { justifyContent: 'flex-end' } : undefined}>
                            {msg.timestamp && (
                              <span className={styles.metaItem}>
                                <Clock16Regular style={{ fontSize: 11 }} />
                                {formatTimestamp(msg.timestamp)}
                              </span>
                            )}
                            {msg.role === 'assistant' && msg.modelName && (
                              <span className={styles.metaItem}>
                                <BrainCircuit20Regular style={{ fontSize: 11 }} />
                                {msg.modelName}
                              </span>
                            )}
                            {msg.role === 'assistant' && msg.latencyMs != null && (
                              <span className={styles.metaItem}>
                                <Timer16Regular style={{ fontSize: 11 }} />
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

                {pane.isStreaming && !pane.streamingText && (
                  <div className={styles.thinkingDots}>
                    <div className={mergeClasses(styles.dot, styles.dot1)} />
                    <div className={mergeClasses(styles.dot, styles.dot2)} />
                    <div className={mergeClasses(styles.dot, styles.dot3)} />
                  </div>
                )}

                {pane.isStreaming && pane.streamingText && (
                  <div className={`${styles.messageRow} ${styles.assistantRow}`}>
                    <div className={`${styles.avatar} ${styles.assistantAvatar}`}>
                      <Bot24Regular style={{ fontSize: 14 }} />
                    </div>
                    <div className={`${styles.bubble} ${styles.assistantBubble}`}>
                      <div className={styles.markdown}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{pane.streamingText}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {panes.length > 0 && (
        <div className={styles.inputBar}>
          <div className={styles.inputWrapper}>
            <Textarea
              placeholder="Type a message to send to all agents..."
              value={inputValue}
              onChange={(_, d) => setInputValue(d.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              resize="none"
              disabled={anyStreaming}
              style={{ width: '100%' }}
            />
          </div>
          <Button
            icon={<Send24Regular />}
            appearance="primary"
            onClick={handleSend}
            disabled={anyStreaming || !inputValue.trim()}
            title="Send to all agents"
          />
        </div>
      )}

      {previewFile && (
        <FilePreviewModal
          url={previewFile.url}
          fileName={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </div>
  )
}
