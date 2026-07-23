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
  ArrowClockwise24Regular,
} from '@fluentui/react-icons'
import { volumeBrowseApi, VolumeDirEntry, VolumeBrowseResult } from '../../services/api'
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
    cursor: 'default',
    borderRadius: tokens.borderRadiusSmall,
    gap: '8px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  rowDirectory: {
    cursor: 'pointer',
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
  truncationBanner: {
    padding: '8px 12px',
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground2,
    fontSize: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
})

function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

interface VolumeExplorerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  volumeId: string
  volumeName: string
}

export function VolumeExplorerDialog({
  open,
  onOpenChange,
  projectId,
  volumeId,
  volumeName,
}: VolumeExplorerDialogProps) {
  const styles = useStyles()
  const [currentPath, setCurrentPath] = useState('')
  const [entries, setEntries] = useState<VolumeDirEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [browseResult, setBrowseResult] = useState<VolumeBrowseResult | null>(null)

  const loadDirectory = useCallback(async (subPath: string) => {
    setLoading(true)
    setError(null)
    setBrowseResult(null)
    try {
      const result = await volumeBrowseApi.listDirectory(projectId, volumeId, subPath)
      setEntries(result.entries)
      setCurrentPath(subPath)
      setBrowseResult(result)
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
      setCurrentPath('')
      setEntries([])
      setError(null)
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
      navigateTo(entry.path)
    }
  }

  const pathSegments = currentPath ? currentPath.split('/').filter(Boolean) : []
  const dirCount = browseResult?.totalDirCount ?? entries.filter(e => e.type === 'directory').length
  const fileCount = browseResult?.totalFileCount ?? entries.filter(e => e.type === 'file').length

  return (
    <ScrollableDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Volume Explorer — ${volumeName}`}
      bodyPadding="flush"
      resizable
      initialWidth="min(860px, 92vw)"
      initialHeight="min(72vh, 640px)"
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
            <div style={{ marginLeft: 'auto' }}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowClockwise24Regular />}
                onClick={() => loadDirectory(currentPath)}
                disabled={loading}
                title="Refresh"
              />
            </div>
          </div>

          {browseResult?.truncated && !loading && (
            <div className={styles.truncationBanner}>
              This directory contains too many items to display.
              Showing first {entries.length.toLocaleString()} entries
              ({browseResult.totalDirCount?.toLocaleString()} folders, {browseResult.totalFileCount?.toLocaleString()} files).
              Navigate into a subdirectory for a complete listing.
            </div>
          )}

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
                className={`${styles.row} ${entry.type === 'directory' ? styles.rowDirectory : ''}`}
                onClick={() => handleEntryClick(entry)}
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

          <div className={styles.statusBar}>
            <span>/{currentPath || ''}</span>
            <span>
              {!loading && !error && (
                <>
                  {dirCount > 0 && `${browseResult?.truncated ? '≥ ' : ''}${dirCount.toLocaleString()} folder${dirCount !== 1 ? 's' : ''}`}
                  {dirCount > 0 && fileCount > 0 && ', '}
                  {fileCount > 0 && `${browseResult?.truncated ? '≥ ' : ''}${fileCount.toLocaleString()} file${fileCount !== 1 ? 's' : ''}`}
                  {dirCount === 0 && fileCount === 0 && 'Empty'}
                </>
              )}
            </span>
          </div>
        </div>
      }
      actions={
        <Button appearance="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    />
  )
}
