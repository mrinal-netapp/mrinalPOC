import { useState, useRef, useEffect } from 'react'
import { makeStyles, tokens, Button, Text, Spinner, Input } from '@fluentui/react-components'
import { Add24Regular, Delete24Regular, Chat24Regular, Edit24Regular, Checkmark24Regular, Dismiss24Regular } from '@fluentui/react-icons'
import type { SessionInfo } from '../../services/api'

interface SessionSidebarProps {
  sessions: SessionInfo[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onNewConversation: () => void
  onRenameSession: (id: string, name: string) => void
  onDeleteSession: (id: string) => void
  loading: boolean
}

const useStyles = makeStyles({
  container: {
    width: '280px',
    minWidth: '280px',
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground2,
    height: '100%',
  },
  header: {
    padding: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  sessionItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
  sessionItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  sessionContent: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  sessionLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sessionDate: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  actionBtns: {
    display: 'flex',
    gap: '2px',
    flexShrink: 0,
    opacity: 0,
  },
  actionBtnsVisible: {
    opacity: 1,
  },
  emptyState: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    color: tokens.colorNeutralForeground3,
    padding: '16px',
    textAlign: 'center',
  },
  renameInput: {
    flex: 1,
    minWidth: 0,
  },
})

function formatSessionDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = d.toDateString() === yesterday.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (isToday) return `Today, ${time}`
  if (isYesterday) return `Yesterday, ${time}`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewConversation,
  onRenameSession,
  onDeleteSession,
  loading,
}: SessionSidebarProps) {
  const styles = useStyles()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingId])

  const startRename = (session: SessionInfo) => {
    setRenamingId(session.id)
    setRenameValue(session.name)
  }

  const confirmRename = () => {
    if (renamingId && renameValue.trim()) {
      onRenameSession(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const cancelRename = () => {
    setRenamingId(null)
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Button
          icon={<Add24Regular />}
          appearance="primary"
          style={{ width: '100%' }}
          onClick={onNewConversation}
        >
          New Conversation
        </Button>
      </div>
      <div className={styles.list}>
        {loading ? (
          <div className={styles.emptyState}>
            <Spinner size="small" label="Loading sessions..." />
          </div>
        ) : sessions.length === 0 ? (
          <div className={styles.emptyState}>
            <Text size={200}>No previous sessions</Text>
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`${styles.sessionItem} ${
                activeSessionId === session.id ? styles.sessionItemActive : ''
              }`}
              onClick={() => {
                if (renamingId !== session.id) onSelectSession(session.id)
              }}
              onMouseEnter={() => setHoveredId(session.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <Chat24Regular style={{ fontSize: 16, flexShrink: 0 }} />
              {renamingId === session.id ? (
                <>
                  <Input
                    ref={inputRef}
                    size="small"
                    className={styles.renameInput}
                    value={renameValue}
                    onChange={(_, d) => setRenameValue(d.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmRename()
                      if (e.key === 'Escape') cancelRename()
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Button
                    icon={<Checkmark24Regular />}
                    size="small"
                    appearance="subtle"
                    onClick={(e) => { e.stopPropagation(); confirmRename() }}
                    title="Save"
                  />
                  <Button
                    icon={<Dismiss24Regular />}
                    size="small"
                    appearance="subtle"
                    onClick={(e) => { e.stopPropagation(); cancelRename() }}
                    title="Cancel"
                  />
                </>
              ) : (
                <>
                  <div className={styles.sessionContent}>
                    <Text size={200} className={styles.sessionLabel} title={session.name}>
                      {session.name}
                    </Text>
                    {session.createdAt && (
                      <span className={styles.sessionDate}>
                        {formatSessionDate(session.createdAt)}
                      </span>
                    )}
                  </div>
                  <div
                    className={`${styles.actionBtns} ${
                      hoveredId === session.id || activeSessionId === session.id
                        ? styles.actionBtnsVisible
                        : ''
                    }`}
                  >
                    <Button
                      icon={<Edit24Regular />}
                      size="small"
                      appearance="subtle"
                      onClick={(e) => { e.stopPropagation(); startRename(session) }}
                      title="Rename session"
                    />
                    <Button
                      icon={<Delete24Regular />}
                      size="small"
                      appearance="subtle"
                      onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id) }}
                      title="Delete session"
                    />
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
