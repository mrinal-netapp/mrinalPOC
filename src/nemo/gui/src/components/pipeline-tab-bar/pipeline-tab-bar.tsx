import { useState, useRef, useEffect } from 'react'
import {
  makeStyles,
  Button,
} from '@fluentui/react-components'
import { Dismiss24Regular, Add24Regular } from '@fluentui/react-icons'
import { usePipelineTabsStore } from '@/stores/pipeline-tabs/store'

const useStyles = makeStyles({
  tabBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    borderBottom: '1px solid var(--divider)',
    backgroundColor: 'var(--surface-2)',
    overflowX: 'auto',
    overflowY: 'hidden',
    flexShrink: 0,
  },
  tab: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    borderRadius: '4px',
    border: '1px solid var(--border)',
    backgroundColor: 'var(--surface-1)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    minWidth: '120px',
    maxWidth: '200px',
    transition: 'all 0.2s ease',
    ':hover': {
      backgroundColor: 'var(--surface-3)',
    },
  },
  activeTab: {
    backgroundColor: 'var(--surface-3)',
    border: '1px solid var(--border)',
    ':hover': {
      backgroundColor: 'var(--surface-3)',
    },
  },
  tabLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: '13px',
    color: 'var(--text-primary)',
    cursor: 'text',
    userSelect: 'text',
  },
  tabInput: {
    flex: 1,
    fontSize: '13px',
    color: 'var(--text-primary)',
    backgroundColor: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    padding: '2px 4px',
    outline: 'none',
    minWidth: '80px',
    ':focus': {
      outline: '1px solid var(--border)',
    },
  },
  closeButton: {
    minWidth: '20px',
    width: '20px',
    height: '20px',
    padding: 0,
    ':hover': {
      backgroundColor: 'var(--surface-9)',
    },
  },
  addButton: {
    minWidth: '32px',
    width: '32px',
    height: '32px',
    padding: 0,
    marginLeft: '4px',
    ':hover': {
      backgroundColor: 'var(--surface-3)',
    },
  },
})

interface PipelineTabBarProps {
  onAddTab?: () => void
}

export default function PipelineTabBar({ onAddTab }: PipelineTabBarProps) {
  const styles = useStyles()
  const { tabs, activeTabId, setActiveTab, removeTab, updateTabName } = usePipelineTabsStore()
  const [editingTabId, setEditingTabId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when editing starts
  useEffect(() => {
    if (editingTabId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingTabId])

  const handleTabClick = (tabId: string) => {
    if (editingTabId !== tabId) {
      setActiveTab(tabId)
    }
  }

  const handleTabNameClick = (e: React.MouseEvent, tabId: string, currentName: string) => {
    e.stopPropagation()
    setEditingTabId(tabId)
    setEditingName(currentName)
  }

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingName(e.target.value)
  }

  const handleNameBlur = () => {
    if (editingTabId) {
      if (editingName.trim()) {
        updateTabName(editingTabId, editingName.trim())
      }
      setEditingTabId(null)
      setEditingName('')
    }
  }

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleNameBlur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingTabId(null)
      setEditingName('')
    }
  }

  const handleClose = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    removeTab(tabId)
  }

  const handleAddTab = () => {
    if (onAddTab) {
      onAddTab()
    }
  }

  if (tabs.length === 0) {
    return null
  }

  return (
    <div className={styles.tabBar}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.tab} ${activeTabId === tab.id ? styles.activeTab : ''}`}
          onClick={() => handleTabClick(tab.id)}
        >
          {editingTabId === tab.id ? (
            <input
              ref={inputRef}
              type="text"
              value={editingName}
              onChange={handleNameChange}
              onBlur={handleNameBlur}
              onKeyDown={handleNameKeyDown}
              className={styles.tabInput}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className={styles.tabLabel}
              title={tab.name}
              onClick={(e) => handleTabNameClick(e, tab.id, tab.name)}
            >
              {tab.name}
            </span>
          )}
          <Button
            appearance="subtle"
            icon={<Dismiss24Regular />}
            size="small"
            className={styles.closeButton}
            onClick={(e) => handleClose(e, tab.id)}
          />
        </div>
      ))}
      {onAddTab && (
        <Button
          appearance="subtle"
          icon={<Add24Regular />}
          size="small"
          className={styles.addButton}
          onClick={handleAddTab}
          title="Add new tab"
        />
      )}
    </div>
  )
}

