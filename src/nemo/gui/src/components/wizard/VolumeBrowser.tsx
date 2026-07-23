import React, { useState, useCallback, useEffect } from 'react'
import {
  Button,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import {
  Folder24Regular,
  Document24Regular,
  ArrowUp24Regular,
} from '@fluentui/react-icons'
import { volumeBrowseApi, VolumeDirEntry } from '../../services/api'
import { ScrollableDialogShell } from '../dialog'

const useStyles = makeStyles({
  treeContainer: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '4px 0',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusSmall,
    gap: '8px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  rowSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2,
    },
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '8px 12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'monospace',
    fontSize: '13px',
    flexWrap: 'wrap',
    minHeight: '40px',
  },
  breadcrumbSegment: {
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: tokens.borderRadiusSmall,
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
      textDecoration: 'underline',
    },
  },
  meta: {
    marginLeft: 'auto',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    display: 'flex',
    gap: '12px',
  },
  empty: {
    padding: '24px',
    textAlign: 'center' as const,
    color: tokens.colorNeutralForeground3,
  },
  error: {
    padding: '12px',
    color: tokens.colorPaletteRedForeground1,
    fontSize: '13px',
  },
})

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface VolumeBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  volumeId: string
  volumeName: string
  onSelect: (path: string) => void
}

export function VolumeBrowser({
  open,
  onOpenChange,
  projectId,
  volumeId,
  volumeName,
  onSelect,
}: VolumeBrowserProps) {
  const styles = useStyles()
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<VolumeDirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const loadDirectory = useCallback(async (subPath: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await volumeBrowseApi.listDirectory(projectId, volumeId, subPath)
      setEntries(result.entries)
      setCurrentPath(subPath)
      setSelectedPath(null)
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Failed to list directory'
      setError(msg)
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [projectId, volumeId])

  useEffect(() => {
    if (open) {
      loadDirectory('')
    }
  }, [open, loadDirectory])

  const navigateTo = (subPath: string) => {
    loadDirectory(subPath)
  }

  const navigateUp = () => {
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    navigateTo(parts.join('/'))
  }

  const handleEntryClick = (entry: VolumeDirEntry) => {
    if (entry.type === 'directory') {
      setSelectedPath(entry.path)
    }
  }

  const handleEntryDoubleClick = (entry: VolumeDirEntry) => {
    if (entry.type === 'directory') {
      navigateTo(entry.path)
    }
  }

  const pathSegments = currentPath ? currentPath.split('/').filter(Boolean) : []

  return (
    <ScrollableDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Browse: ${volumeName}`}
      bodyPadding="flush"
      resizable
      initialWidth="min(800px, 90vw)"
      initialHeight="min(70vh, 600px)"
      minWidth={480}
      minHeight={360}
      body={
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div className={styles.breadcrumb}>
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowUp24Regular />}
              onClick={navigateUp}
              disabled={!currentPath || loading}
              title="Go up"
            />
            <span
              className={styles.breadcrumbSegment}
              onClick={() => navigateTo('')}
            >
              /
            </span>
            {pathSegments.map((seg, i) => {
              const segPath = pathSegments.slice(0, i + 1).join('/')
              return (
                <React.Fragment key={segPath}>
                  <span style={{ color: tokens.colorNeutralForeground3 }}>/</span>
                  <span
                    className={styles.breadcrumbSegment}
                    onClick={() => navigateTo(segPath)}
                  >
                    {seg}
                  </span>
                </React.Fragment>
              )
            })}
          </div>

          <div className={styles.treeContainer}>
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
                <Spinner size="small" label="Loading..." />
              </div>
            )}
            {error && <div className={styles.error}>{error}</div>}
            {!loading && !error && entries.length === 0 && (
              <div className={styles.empty}>
                <Text>Empty directory</Text>
              </div>
            )}
            {!loading && entries.map((entry) => (
              <div
                key={entry.path || entry.name}
                className={`${styles.row} ${selectedPath === entry.path ? styles.rowSelected : ''}`}
                onClick={() => handleEntryClick(entry)}
                onDoubleClick={() => handleEntryDoubleClick(entry)}
              >
                {entry.type === 'directory' ? (
                  <Folder24Regular style={{ flexShrink: 0 }} />
                ) : (
                  <Document24Regular style={{ flexShrink: 0 }} />
                )}
                <Text style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {entry.name}
                </Text>
                <div className={styles.meta}>
                  {entry.type === 'file' && entry.size > 0 && <span>{formatSize(entry.size)}</span>}
                  {entry.lastModified && (
                    <span>{new Date(entry.lastModified).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      }
      footer={
        selectedPath ? (
          <div style={{
            padding: '8px 12px',
            backgroundColor: 'var(--colorNeutralBackground3)',
            borderRadius: '4px',
            fontSize: '13px',
          }}>
            <span style={{ fontWeight: 600 }}>Selected: </span>
            <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {selectedPath || '/'}
            </span>
          </div>
        ) : (
          <div style={{
            padding: '8px 12px',
            fontSize: '13px',
            color: 'var(--colorNeutralForeground3)',
          }}>
            {currentPath
              ? `Current directory: ${currentPath}`
              : 'Click a folder to select it, or double-click to open. Select the current directory by clicking "Use current path".'}
          </div>
        )
      }
      actions={
        <>
          <Button appearance="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            appearance="secondary"
            onClick={() => {
              onSelect(currentPath)
              onOpenChange(false)
            }}
          >
            Use current path
          </Button>
          <Button
            appearance="primary"
            disabled={!selectedPath}
            onClick={() => {
              if (selectedPath) {
                onSelect(selectedPath)
                onOpenChange(false)
              }
            }}
          >
            Select folder
          </Button>
        </>
      }
    />
  )
}
