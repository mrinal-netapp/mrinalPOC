import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Badge,
  Button,
  Dropdown,
  Field,
  makeStyles,
  Option,
  Spinner,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  Bot24Regular,
  BrainCircuit20Regular,
  Clock16Regular,
  Delete24Regular,
  Person24Regular,
  Send24Regular,
  Timer16Regular,
} from '@fluentui/react-icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  modelApi,
  modelPlaygroundApi,
  Model,
  ModelPlaygroundMessage,
  TokenUsage,
} from '../services/api'
import { useToast } from '../contexts/ToastContext'

const STORAGE_VERSION = 1
const MAX_MODELS = 3
const MAX_HISTORY_TURNS = 20
const MAX_CONTEXT_CHARS = 24000

type ResponseState = {
  status: 'pending' | 'completed' | 'error'
  response?: string
  error?: string
  latencyMs?: number
  modelName?: string
  usage?: TokenUsage
}

type ConversationTurn = {
  id: string
  prompt: string
  createdAt: string
  responses: Record<string, ResponseState>
}

type PersistedState = {
  version: number
  selectedModelIds: string[]
  turns: ConversationTurn[]
  updatedAt: string
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  controls: {
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
  },
  modelField: {
    minWidth: '380px',
    marginBottom: 0,
  },
  panels: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '8px',
    minHeight: '320px',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
  modelHeaderGrid: {
    display: 'grid',
    gap: '0px',
    padding: '0px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  modelHeaderCell: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    ':last-child': {
      borderRight: 'none',
    },
  },
  panelBody: {
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    overflowY: 'auto',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  turnBlock: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '10px',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  responseGrid: {
    display: 'grid',
    gap: '0px',
    marginTop: '10px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  bubble: { borderRadius: '10px', padding: '8px 10px', lineHeight: '1.45' },
  userBubble: {
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  assistantBubble: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    borderRadius: '0px',
    padding: '10px 12px',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    minHeight: '72px',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      boxShadow: tokens.shadow4,
    },
    ':focus-within': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      boxShadow: tokens.shadow4,
    },
    ':last-child': {
      borderRight: 'none',
    },
  },
  meta: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    color: tokens.colorNeutralForeground3,
    fontSize: '10px',
    marginTop: '4px',
    opacity: 0.65,
    transitionProperty: 'opacity, color',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
  },
  emptyResponse: {
    color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
  modelCellHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '6px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
    opacity: 0.8,
  },
  composer: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    paddingTop: '10px',
  },
})

function buildLocalStorageKey(projectId: string) {
  return `agentstudio:model-playground:v${STORAGE_VERSION}:${projectId}`
}

function formatLatency(ms?: number) {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function buildContextMessages(turns: ConversationTurn[], modelId: string, prompt: string): ModelPlaygroundMessage[] {
  const messages: ModelPlaygroundMessage[] = []
  let totalChars = 0
  let countTurns = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (countTurns >= MAX_HISTORY_TURNS) break
    const turn = turns[i]
    if (!turn) continue
    const r = turn.responses[modelId]
    if (!r || r.status !== 'completed' || !r.response) continue
    const pairChars = turn.prompt.length + r.response.length
    if (totalChars + pairChars > MAX_CONTEXT_CHARS) break
    messages.unshift({ role: 'assistant', content: r.response })
    messages.unshift({ role: 'user', content: turn.prompt })
    totalChars += pairChars
    countTurns += 1
  }
  messages.push({ role: 'user', content: prompt })
  return messages
}

function buildContextMessagesForTurn(
  turns: ConversationTurn[],
  modelId: string,
  turnIndex: number,
  prompt: string,
): ModelPlaygroundMessage[] {
  const messages: ModelPlaygroundMessage[] = []
  let totalChars = 0
  let countTurns = 0
  for (let i = turnIndex - 1; i >= 0; i -= 1) {
    if (countTurns >= MAX_HISTORY_TURNS) break
    const turn = turns[i]
    if (!turn) continue
    const r = turn.responses[modelId]
    if (!r || r.status !== 'completed' || !r.response) continue
    const pairChars = turn.prompt.length + r.response.length
    if (totalChars + pairChars > MAX_CONTEXT_CHARS) break
    messages.unshift({ role: 'assistant', content: r.response })
    messages.unshift({ role: 'user', content: turn.prompt })
    totalChars += pairChars
    countTurns += 1
  }
  messages.push({ role: 'user', content: prompt })
  return messages
}

export default function ModelPlayground() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { showToast } = useToast()

  const [models, setModels] = useState<Model[]>([])
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])
  const [turns, setTurns] = useState<ConversationTurn[]>([])
  const [inputValue, setInputValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [runningTurnIds, setRunningTurnIds] = useState<Set<string>>(new Set())
  const [storageWritable, setStorageWritable] = useState(true)

  const generationRef = useRef(0)
  const warnedStorageRef = useRef(false)

  const llmModels = useMemo(
    () => models.filter((m) => !m.modelType || m.modelType === 'llm'),
    [models],
  )
  const selectedModels = useMemo(
    () => llmModels.filter((m) => selectedModelIds.includes(m.id)),
    [llmModels, selectedModelIds],
  )

  useEffect(() => {
    if (!projectId) return
    const load = async () => {
      try {
        const listed = await modelApi.list(projectId)
        const llms = listed.filter((m) => !m.modelType || m.modelType === 'llm')
        setModels(listed)
        const validModelIds = new Set(llms.map((m) => m.id))

        let initialSelected: string[] = []
        const preselect = searchParams.get('modelIds')
        if (preselect) initialSelected = preselect.split(',').filter(Boolean).slice(0, MAX_MODELS)

        const storedRaw = localStorage.getItem(buildLocalStorageKey(projectId))
        if (storedRaw) {
          try {
            const parsed = JSON.parse(storedRaw) as PersistedState
            if (parsed?.version === STORAGE_VERSION && Array.isArray(parsed.selectedModelIds) && Array.isArray(parsed.turns)) {
              const prunedSelected = parsed.selectedModelIds.filter((id) => validModelIds.has(id)).slice(0, MAX_MODELS)
              setSelectedModelIds(initialSelected.length ? initialSelected.filter((id) => validModelIds.has(id)).slice(0, MAX_MODELS) : prunedSelected)
              setTurns(parsed.turns)
            }
          } catch {
            showToast('Model Playground history was invalid and has been reset', 'warning')
          }
        } else if (initialSelected.length) {
          setSelectedModelIds(initialSelected.filter((id) => validModelIds.has(id)).slice(0, MAX_MODELS))
        }
      } catch (err: any) {
        showToast(err?.message || 'Failed to load models', 'error')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [projectId, searchParams, showToast])

  useEffect(() => {
    if (!projectId || loading || !storageWritable) return
    const timer = setTimeout(() => {
      try {
        const payload: PersistedState = {
          version: STORAGE_VERSION,
          selectedModelIds: selectedModelIds.slice(0, MAX_MODELS),
          turns,
          updatedAt: new Date().toISOString(),
        }
        localStorage.setItem(buildLocalStorageKey(projectId), JSON.stringify(payload))
      } catch {
        setStorageWritable(false)
        if (!warnedStorageRef.current) {
          warnedStorageRef.current = true
          showToast('Could not write Model Playground history to local storage; session remains in memory', 'warning')
        }
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [projectId, loading, selectedModelIds, turns, storageWritable, showToast])

  const handleSend = async () => {
    if (!projectId || sending) return
    const prompt = inputValue.trim()
    if (!prompt) return
    if (selectedModelIds.length === 0) {
      showToast('Select at least one model', 'warning')
      return
    }

    const generation = generationRef.current + 1
    generationRef.current = generation
    setSending(true)
    setInputValue('')

    const turnId = `turn-${Date.now()}`
    const pendingResponses: Record<string, ResponseState> = {}
    selectedModelIds.forEach((id) => { pendingResponses[id] = { status: 'pending' } })
    setTurns((prev) => [...prev, {
      id: turnId,
      prompt,
      createdAt: new Date().toISOString(),
      responses: pendingResponses,
    }])

    const snapshotTurns = turns
    await Promise.allSettled(selectedModelIds.map(async (modelId) => {
      try {
        const messages = buildContextMessages(snapshotTurns, modelId, prompt)
        const result = await modelPlaygroundApi.invoke(projectId, modelId, { messages })
        if (generationRef.current !== generation) return
        setTurns((prev) => prev.map((t) => (
          t.id === turnId
            ? {
                ...t,
                responses: {
                  ...t.responses,
                  [modelId]: {
                    status: 'completed',
                    response: result.response,
                    latencyMs: result.latencyMs,
                    modelName: result.modelName,
                    usage: result.usage,
                  },
                },
              }
            : t
        )))
      } catch (err: any) {
        if (generationRef.current !== generation) return
        setTurns((prev) => prev.map((t) => (
          t.id === turnId
            ? {
                ...t,
                responses: {
                  ...t.responses,
                  [modelId]: {
                    status: 'error',
                    error: err?.response?.data?.error || err?.message || 'Invocation failed',
                  },
                },
              }
            : t
        )))
      }
    }))

    if (generationRef.current === generation) {
      setSending(false)
    }
  }

  const runTurnForModels = async (turnId: string, modelIds: string[]) => {
    if (!projectId || modelIds.length === 0) return
    const turnsSnapshot = turns
    const turnIndex = turnsSnapshot.findIndex((t) => t.id === turnId)
    if (turnIndex < 0) return
    const turn = turnsSnapshot[turnIndex]
    if (!turn) return

    setRunningTurnIds((prev) => new Set(prev).add(turnId))
    setTurns((prev) => prev.map((t) => (
      t.id === turnId
        ? {
            ...t,
            responses: {
              ...t.responses,
              ...Object.fromEntries(modelIds.map((id) => [id, { status: 'pending' as const }])),
            },
          }
        : t
    )))

    await Promise.allSettled(modelIds.map(async (modelId) => {
      try {
        const messages = buildContextMessagesForTurn(turnsSnapshot, modelId, turnIndex, turn.prompt)
        const result = await modelPlaygroundApi.invoke(projectId, modelId, { messages })
        setTurns((prev) => prev.map((t) => (
          t.id === turnId
            ? {
                ...t,
                responses: {
                  ...t.responses,
                  [modelId]: {
                    status: 'completed',
                    response: result.response,
                    latencyMs: result.latencyMs,
                    modelName: result.modelName,
                    usage: result.usage,
                  },
                },
              }
            : t
        )))
      } catch (err: any) {
        setTurns((prev) => prev.map((t) => (
          t.id === turnId
            ? {
                ...t,
                responses: {
                  ...t.responses,
                  [modelId]: {
                    status: 'error',
                    error: err?.response?.data?.error || err?.message || 'Invocation failed',
                  },
                },
              }
            : t
        )))
      }
    }))

    setRunningTurnIds((prev) => {
      const next = new Set(prev)
      next.delete(turnId)
      return next
    })
  }

  const handleClearHistory = () => {
    if (turns.length === 0) return
    const confirmed = window.confirm('Clear all conversation history for this Model Playground?')
    if (!confirmed) return
    setTurns([])
    showToast('Conversation history cleared', 'success')
  }

  if (loading) {
    return <Spinner label="Loading models..." />
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button appearance="subtle" icon={<ArrowLeft24Regular />} onClick={() => navigate(`/projects/${projectId}/models`)} />
        <Text size={500} weight="semibold" style={{ flex: 1 }}>Model Playground</Text>
        <Badge appearance="outline">{selectedModelIds.length} / {MAX_MODELS} selected</Badge>
      </div>

      <div className={styles.controls}>
        <Field label="Models (up to 3)" className={styles.modelField}>
          <Dropdown
            multiselect
            selectedOptions={selectedModelIds}
            value={selectedModels.map((m) => m.displayName || m.name).join(', ')}
            placeholder="Select models"
            onOptionSelect={(_, data) => {
              const next = (data.selectedOptions || []) as string[]
              if (next.length > MAX_MODELS) {
                showToast(`You can compare up to ${MAX_MODELS} models`, 'warning')
                return
              }
              setSelectedModelIds(next)
            }}
          >
            {llmModels.map((m) => (
              <Option key={m.id} value={m.id} text={m.displayName || m.name}>
                {m.displayName || m.name}
              </Option>
            ))}
          </Dropdown>
        </Field>
        <Button
          icon={<Delete24Regular />}
          appearance="secondary"
          onClick={handleClearHistory}
          disabled={turns.length === 0}
        >
          Clear history
        </Button>
        <Button appearance="secondary" onClick={() => setSelectedModelIds([])} disabled={selectedModelIds.length === 0}>
          Clear selected models
        </Button>
      </div>

      <div className={styles.panels}>
        {selectedModels.length === 0 ? (
          <div className={styles.panelBody}>
            <Text>Select 1 to 3 models to start comparing responses.</Text>
          </div>
        ) : (
          <>
            <div className={styles.modelHeaderGrid} style={{ gridTemplateColumns: `repeat(${selectedModels.length}, minmax(0, 1fr))` }}>
              {selectedModels.map((model) => (
                <div key={model.id} className={styles.modelHeaderCell}>
                  <Bot24Regular />
                  <Text weight="semibold">{model.displayName || model.name}</Text>
                </div>
              ))}
            </div>
            <div className={styles.panelBody}>
              {turns.length === 0 && <Text size={200}>No messages yet.</Text>}
              {turns.map((turn) => (
                <div key={turn.id} className={styles.turnBlock}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginBottom: '8px' }}>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={runningTurnIds.has(turn.id) || selectedModelIds.length === 0 || selectedModelIds.every((id) => !!turn.responses[id])}
                      onClick={() => {
                        const missing = selectedModelIds.filter((id) => !turn.responses[id])
                        void runTurnForModels(turn.id, missing)
                      }}
                    >
                      Run missing models
                    </Button>
                    <Button
                      size="small"
                      appearance="secondary"
                      disabled={runningTurnIds.has(turn.id) || selectedModelIds.length === 0}
                      onClick={() => void runTurnForModels(turn.id, selectedModelIds)}
                    >
                      Rerun all selected
                    </Button>
                  </div>
                  <div className={`${styles.bubble} ${styles.userBubble}`}>
                    <Person24Regular style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
                    {turn.prompt}
                  </div>
                  <div className={styles.responseGrid} style={{ gridTemplateColumns: `repeat(${selectedModels.length}, minmax(0, 1fr))` }}>
                    {selectedModels.map((model) => {
                      const state = turn.responses[model.id]
                      return (
                        <div key={`${model.id}-${turn.id}`} className={`${styles.bubble} ${styles.assistantBubble}`}>
                          <div className={styles.modelCellHeader}>
                            <span>{model.displayName || model.name}</span>
                          </div>
                          {state?.status === 'pending' && <Spinner size="tiny" label="Generating..." />}
                          {state?.status === 'error' && <Text>Error: {state.error}</Text>}
                          {state?.status === 'completed' && (
                            <div>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{state.response || ''}</ReactMarkdown>
                              <div className={styles.meta}>
                                {state.modelName && <span><BrainCircuit20Regular style={{ fontSize: 12 }} /> {state.modelName}</span>}
                                {state.latencyMs != null && <span><Timer16Regular style={{ fontSize: 12 }} /> {formatLatency(state.latencyMs)}</span>}
                                {state.usage?.promptTokens != null && <span><Clock16Regular style={{ fontSize: 12 }} /> P {state.usage.promptTokens}</span>}
                                {state.usage?.completionTokens != null && <span>C {state.usage.completionTokens}</span>}
                                {state.usage?.totalTokens != null && <span>T {state.usage.totalTokens}</span>}
                              </div>
                            </div>
                          )}
                          {!state && <Text size={200} className={styles.emptyResponse}>No response for this turn.</Text>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className={styles.composer}>
        <Textarea
          placeholder="Type a prompt to send to all selected models..."
          value={inputValue}
          onChange={(_, d) => setInputValue(d.value)}
          resize="vertical"
          rows={3}
          style={{ flex: 1 }}
          disabled={sending || selectedModelIds.length === 0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleSend()
            }
          }}
        />
        <Button appearance="primary" icon={<Send24Regular />} onClick={() => void handleSend()} disabled={sending || !inputValue.trim()}>
          Send
        </Button>
      </div>
    </div>
  )
}
