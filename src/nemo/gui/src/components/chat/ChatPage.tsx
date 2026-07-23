import { useState, useEffect, useCallback, type FC } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Button,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
  Badge,
  Dropdown,
  Option,
} from '@fluentui/react-components'
import { ArrowLeft24Regular } from '@fluentui/react-icons'
import type { SessionInfo, Model } from '../../services/api'
import { modelApi } from '../../services/api'
import { useToast } from '../../contexts/ToastContext'
import SessionSidebar from './SessionSidebar'
import AgentThread from './AgentThread'
import type { StreamDoneMetadata } from '../../hooks/useChatRuntime'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    height: '100%',
    overflow: 'hidden',
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headerInfo: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
  },
  headerTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  modelSelector: {
    minWidth: '180px',
    maxWidth: '280px',
  },
  loadingContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  errorContainer: {
    padding: '24px',
  },
  threadArea: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  threadContainer: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
})

export interface ChatPageSessionApi {
  listSessions(projectId: string, entityId: string): Promise<SessionInfo[]>
  renameSession(projectId: string, entityId: string, sessionId: string, name: string): Promise<unknown>
  deleteSession(projectId: string, entityId: string, sessionId: string): Promise<unknown>
}

export interface ChatPageEntity {
  name: string
  description?: string
  role?: string
  modelId?: string
  modelClass?: string
}

export interface ChatPageProps {
  projectId: string
  entityId: string
  entityLabel: string
  fetchEntity: () => Promise<ChatPageEntity | null>
  sessionApi: ChatPageSessionApi
  useRuntime: (
    projectId: string,
    entityId: string,
    sessionId: string,
    onStreamDone?: (meta: StreamDoneMetadata) => void,
    onStreamEvent?: undefined,
    modelIdOverride?: string,
  ) => ReturnType<typeof import('../../hooks/useChatRuntime').useChatRuntime>
  backPath: string
  backLabel: string
}

const ChatPage: FC<ChatPageProps> = ({
  projectId,
  entityId,
  entityLabel,
  fetchEntity,
  sessionApi,
  useRuntime,
  backPath,
  backLabel,
}) => {
  const styles = useStyles()
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [entity, setEntity] = useState<ChatPageEntity | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>(() => crypto.randomUUID())
  const [loading, setLoading] = useState(true)
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [streamMeta, setStreamMeta] = useState<StreamDoneMetadata | null>(null)
  const [threadKey, setThreadKey] = useState(0)

  const [models, setModels] = useState<Model[]>([])
  const [modelIdOverride, setModelIdOverride] = useState<string | undefined>(undefined)

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchEntity()
        if (!data) {
          setError(`${entityLabel} not found`)
        } else {
          setEntity(data)
          if (data.modelId) {
            setModelIdOverride(data.modelId)
          }
        }
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 404) {
          setError(`${entityLabel} not found`)
        } else {
          setError(`Failed to load ${entityLabel.toLowerCase()}`)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId])

  useEffect(() => {
    const loadModels = async () => {
      try {
        const allModels: Model[] = await modelApi.list(projectId)
        const llmModels = allModels.filter(
          (m) => !m.modelType || m.modelType === 'llm',
        )
        if (entity?.modelClass) {
          const classFiltered = llmModels.filter(
            (m) => (m as Model & { modelClass?: string }).modelClass === entity.modelClass,
          )
          setModels(classFiltered.length > 0 ? classFiltered : llmModels)
        } else {
          setModels(llmModels)
        }
      } catch {
        // non-critical
      }
    }
    if (!loading && !error) {
      loadModels()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loading, error, entity?.modelClass])

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const list = await sessionApi.listSessions(projectId, entityId)
      setSessions(list)
    } catch {
      // Non-critical
    } finally {
      setSessionsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, entityId])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  const handleStreamDone = useCallback(
    (meta: StreamDoneMetadata) => {
      setStreamMeta(meta)
      loadSessions()
    },
    [loadSessions],
  )

  const handleSelectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
    setStreamMeta(null)
    setThreadKey((k) => k + 1)
  }, [])

  const handleNewConversation = useCallback(() => {
    setActiveSessionId(crypto.randomUUID())
    setStreamMeta(null)
    setThreadKey((k) => k + 1)
  }, [])

  const handleRenameSession = useCallback(
    async (sessionId: string, name: string) => {
      try {
        await sessionApi.renameSession(projectId, entityId, sessionId, name)
        loadSessions()
      } catch {
        showToast('Failed to rename session', 'error')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, entityId, showToast, loadSessions],
  )

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await sessionApi.deleteSession(projectId, entityId, sessionId)
        showToast('Session deleted', 'success')
        if (activeSessionId === sessionId) {
          handleNewConversation()
        }
        loadSessions()
      } catch {
        showToast('Failed to delete session', 'error')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, entityId, activeSessionId, showToast, loadSessions, handleNewConversation],
  )

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loadingContainer}>
          <Spinner size="large" label={`Loading ${entityLabel.toLowerCase()}...`} />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.root}>
        <div className={styles.errorContainer}>
          <MessageBar intent="error">
            <MessageBarBody>
              {error}.{' '}
              <Button
                appearance="transparent"
                size="small"
                onClick={() => navigate(backPath)}
              >
                {backLabel}
              </Button>
            </MessageBarBody>
          </MessageBar>
        </div>
      </div>
    )
  }

  const selectedModel = models.find((m) => m.id === modelIdOverride)

  return (
    <div className={styles.root}>
      <SessionSidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewConversation={handleNewConversation}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        loading={sessionsLoading}
      />
      <div className={styles.main}>
        <div className={styles.header}>
          <Button
            icon={<ArrowLeft24Regular />}
            appearance="subtle"
            onClick={() => navigate(backPath)}
            title={backLabel}
          />
          <div className={styles.headerInfo}>
            <Text size={400} weight="semibold" className={styles.headerTitle}>
              {entity?.name || entityLabel}
            </Text>
            {entity?.role && (
              <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                {entity.role}
              </Text>
            )}
          </div>
          {models.length > 0 && (
            <Dropdown
              className={styles.modelSelector}
              value={selectedModel ? `${selectedModel.provider || ''} / ${selectedModel.providerModelId || selectedModel.name}` : ''}
              selectedOptions={modelIdOverride ? [modelIdOverride] : []}
              onOptionSelect={(_, d) => setModelIdOverride(d.optionValue as string)}
              placeholder="Select model"
              size="small"
            >
              {models.map((m) => (
                <Option key={m.id} value={m.id} text={`${m.provider || ''} / ${m.providerModelId || m.name}`}>
                  {m.provider || ''} / {m.providerModelId || m.name}
                </Option>
              ))}
            </Dropdown>
          )}
          {sessions.find((s) => s.id === activeSessionId) && (
            <Badge appearance="outline" size="small">
              {sessions.find((s) => s.id === activeSessionId)?.name ||
                activeSessionId.slice(0, 8)}
            </Badge>
          )}
        </div>

        <div className={styles.threadArea}>
          <div className={styles.threadContainer}>
            <ThreadContainer
              key={threadKey}
              projectId={projectId}
              entityId={entityId}
              sessionId={activeSessionId}
              metadata={streamMeta}
              onStreamDone={handleStreamDone}
              useRuntime={useRuntime}
              modelIdOverride={modelIdOverride}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface ThreadContainerProps {
  projectId: string
  entityId: string
  sessionId: string
  metadata: StreamDoneMetadata | null
  onStreamDone: (meta: StreamDoneMetadata) => void
  useRuntime: ChatPageProps['useRuntime']
  modelIdOverride?: string
}

const ThreadContainer: FC<ThreadContainerProps> = ({
  projectId,
  entityId,
  sessionId,
  metadata,
  onStreamDone,
  useRuntime,
  modelIdOverride,
}) => {
  const runtime = useRuntime(projectId, entityId, sessionId, onStreamDone, undefined, modelIdOverride)
  return <AgentThread runtime={runtime} metadata={metadata} />
}

export default ChatPage
