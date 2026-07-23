import { Fragment, useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button, ProgressBar } from '@fluentui/react-components'

const LOG_MAX_HEIGHT = 'min(42vh, 440px)'
/** Above this, render rows with a virtual list to keep DOM size bounded. */
const VIRTUALIZE_FILE_COUNT = 120

function getDisplayPath(file: File): string {
  return (file as { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function manualUploadFileId(file: File, index: number): string {
  return `${getDisplayPath(file)}-${file.size}-${index}`
}

function aggregateUploadStats(
  files: File[],
  uploadProgress: Record<string, number>,
  uploadErrors: Record<string, string>
) {
  const total = files.length
  let completedSuccess = 0
  let failed = 0
  let remaining = 0
  let totalBytes = 0
  let weightedBytes = 0

  for (let i = 0; i < total; i++) {
    const file = files[i]
    const size = file.size || 0
    totalBytes += size
    const fileId = manualUploadFileId(files[i], i)
    if (uploadErrors[fileId]) {
      failed++
      continue
    }
    const p = uploadProgress[fileId] ?? 0
    weightedBytes += size * (p / 100)
    if (p >= 100) {
      completedSuccess++
    } else {
      remaining++
    }
  }

  const barValue =
    totalBytes > 0
      ? weightedBytes / totalBytes
      : total > 0
        ? files.reduce((acc, f, i) => {
            const fileId = manualUploadFileId(f, i)
            if (uploadErrors[fileId]) return acc
            return acc + (uploadProgress[fileId] ?? 0)
          }, 0) /
          (total * 100)
        : 0
  return { total, completedSuccess, failed, remaining, barValue }
}

export interface UploadFileLogPanelProps {
  files: File[]
  uploadProgress: Record<string, number>
  uploadErrors: Record<string, string>
  onRemove?: (index: number) => void
  /** Follow new lines / progress like a log tail (user can scroll up to pause follow) */
  autoScroll?: boolean
  compact?: boolean
  /** Show total-files progress (intended while dataset create/update is uploading) */
  showOverallProgress?: boolean
  /** Disable per-row remove (e.g. while submitting) */
  removeDisabled?: boolean
  /** Shown under the overall bar when uploads run with parallel workers */
  parallelUploadLimit?: number
}

export function UploadFileLogPanel({
  files,
  uploadProgress,
  uploadErrors,
  onRemove,
  autoScroll = true,
  compact = false,
  showOverallProgress = false,
  removeDisabled = false,
  parallelUploadLimit,
}: UploadFileLogPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)

  const stats = useMemo(
    () => aggregateUploadStats(files, uploadProgress, uploadErrors),
    [files, uploadProgress, uploadErrors]
  )

  const shouldVirtualize = files.length >= VIRTUALIZE_FILE_COUNT

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? files.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (compact ? 76 : 88),
    overscan: 10,
  })

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 72
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
  }, [])

  useLayoutEffect(() => {
    if (!autoScroll || !stickToBottomRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [files.length, uploadProgress, uploadErrors, autoScroll, shouldVirtualize])

  const pad = compact ? '6px 10px' : '8px 12px'
  const gridCols = onRemove ? 'minmax(0, 1fr) 88px 100px 40px' : 'minmax(0, 1fr) 88px 100px'

  const renderRow = (index: number) => {
    const file = files[index]
    const displayPath = getDisplayPath(file)
    const fileId = manualUploadFileId(file, index)
    const progress = uploadProgress[fileId]
    const error = uploadErrors[fileId]
    const hasProgressKey = fileId in uploadProgress
    const isComplete = hasProgressKey && progress === 100
    const isUploading = hasProgressKey && !isComplete && !error
    return (
      <div
        style={{
          borderBottom: '1px solid var(--colorNeutralStroke2)',
          backgroundColor: error && error !== 'Cancelled' ? 'var(--colorPaletteRedBackground2)' : undefined,
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: gridCols,
            alignItems: 'center',
            gap: '8px',
            padding: pad,
            fontSize: compact ? '12px' : '13px',
          }}
        >
          <span
            style={{
              fontWeight: 500,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={displayPath}
          >
            {displayPath}
          </span>
          <span
            style={{
              textAlign: 'right',
              color: 'var(--colorNeutralForeground3)',
              fontSize: compact ? '11px' : '12px',
            }}
          >
            {(file.size / 1024).toFixed(1)} KB
          </span>
          <span style={{ textAlign: 'center', fontSize: compact ? '11px' : '12px' }}>
            {error ? (
              <span style={{ color: error === 'Cancelled' ? 'var(--colorNeutralForeground3)' : 'var(--colorPaletteRedForeground1)' }}>
                {error === 'Cancelled' ? 'Cancelled' : 'Failed'}
              </span>
            ) : isUploading ? (
              <span style={{ color: 'var(--colorNeutralForeground2)' }}>{(progress ?? 0)}%</span>
            ) : isComplete ? (
              <span style={{ color: 'var(--colorBrandForeground1)' }}>✓</span>
            ) : (
              <span style={{ color: 'var(--colorNeutralForeground4)' }}>—</span>
            )}
          </span>
          {onRemove ? (
            <Button
              appearance="subtle"
              size="small"
              onClick={() => onRemove(index)}
              aria-label="Remove file"
              disabled={isUploading || removeDisabled}
              style={{ justifySelf: 'end' }}
            >
              ×
            </Button>
          ) : null}
        </div>
        {error && error !== 'Cancelled' && (
          <div
            style={{
              padding: '0 12px 8px',
              fontSize: '11px',
              color: 'var(--colorPaletteRedForeground1)',
            }}
          >
            {error}
            {(error.includes('stalled') || error.includes('network') || error.includes('timed out')) && (
              <span style={{ color: 'var(--colorNeutralForeground3)' }}>
                {' '}— Progress saved. Click Retry to resume.
              </span>
            )}
          </div>
        )}
        {isUploading && !error && (
          <div style={{ padding: '0 12px 10px' }}>
            <ProgressBar value={(progress ?? 0) / 100} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={{
        border: '1px solid var(--colorNeutralStroke2)',
        borderRadius: '4px',
        overflow: 'hidden',
        backgroundColor: 'var(--colorNeutralBackground2)',
      }}
    >
      {showOverallProgress && stats.total > 0 && (
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--colorNeutralStroke2)',
            backgroundColor: 'var(--colorNeutralBackground1)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              gap: '12px',
              marginBottom: '8px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--colorNeutralForeground2)' }}>
              Overall upload
            </span>
            <span style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              <strong style={{ color: 'var(--colorNeutralForeground1)' }}>{stats.completedSuccess}</strong>
              {' of '}
              <strong style={{ color: 'var(--colorNeutralForeground1)' }}>{stats.total}</strong>
              {' files done'}
              {stats.remaining > 0 ? (
                <span>
                  {' · '}
                  {stats.remaining} remaining
                </span>
              ) : null}
              {stats.failed > 0 ? (
                <span style={{ color: 'var(--colorPaletteRedForeground1)' }}>
                  {' · '}
                  {stats.failed} failed
                </span>
              ) : null}
            </span>
          </div>
          <ProgressBar value={stats.barValue} />
          {parallelUploadLimit != null && parallelUploadLimit > 1 ? (
            <div
              style={{
                marginTop: '6px',
                fontSize: '11px',
                color: 'var(--colorNeutralForeground4)',
              }}
            >
              Up to {parallelUploadLimit} files uploading in parallel
            </div>
          ) : null}
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          maxHeight: LOG_MAX_HEIGHT,
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: gridCols,
            alignItems: 'center',
            gap: '8px',
            padding: pad,
            fontSize: '11px',
            fontWeight: 600,
            color: 'var(--colorNeutralForeground3)',
            textTransform: 'uppercase',
            letterSpacing: '0.02em',
            borderBottom: '1px solid var(--colorNeutralStroke2)',
            position: 'sticky',
            top: 0,
            backgroundColor: 'var(--colorNeutralBackground1)',
            zIndex: 1,
          }}
        >
          <span>File</span>
          <span style={{ textAlign: 'right' }}>Size</span>
          <span style={{ textAlign: 'center' }}>Status</span>
          {onRemove ? <span /> : null}
        </div>

        {shouldVirtualize ? (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {renderRow(vi.index)}
              </div>
            ))}
          </div>
        ) : (
          files.map((_, index) => (
            <Fragment key={`${manualUploadFileId(files[index], index)}-${index}`}>
              {renderRow(index)}
            </Fragment>
          ))
        )}
      </div>
    </div>
  )
}
