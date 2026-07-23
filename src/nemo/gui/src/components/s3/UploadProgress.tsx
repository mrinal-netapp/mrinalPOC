import { ProgressBar, Text, Button, tokens } from '@fluentui/react-components'
import { makeStyles } from '@fluentui/react-components'
import { formatSize } from '../../utils/s3Utils'
import { UploadProgress as UploadProgressType } from '../../types/s3'

const useStyles = makeStyles({
  uploadItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground2,
    marginTop: '8px',
  },
  uploadItemInfo: {
    flex: 1,
    minWidth: 0,
  },
  uploadItemName: {
    fontSize: tokens.fontSizeBase200,
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  uploadItemSize: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
})

interface UploadProgressProps {
  uploads: Map<string, UploadProgressType>
  onDismiss?: (uploadId: string) => void
}

export function UploadProgress({ uploads, onDismiss }: UploadProgressProps) {
  const styles = useStyles()

  if (uploads.size === 0) {
    return null
  }

  return (
    <div style={{ marginBottom: '16px' }}>
      {Array.from(uploads.entries()).map(([uploadId, upload]) => (
        <div key={uploadId} className={styles.uploadItem}>
          <div className={styles.uploadItemInfo}>
            <div className={styles.uploadItemName}>{upload.file.name}</div>
            <div className={styles.uploadItemSize}>
              {upload.error ? (
                <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {upload.error}
                </Text>
              ) : (
                <>
                  {formatSize(upload.file.size)} • {upload.progress}%
                  <ProgressBar value={upload.progress / 100} style={{ marginTop: '4px' }} />
                </>
              )}
            </div>
          </div>
          {upload.error && onDismiss && (
            <Button
              appearance="subtle"
              size="small"
              onClick={() => onDismiss(uploadId)}
            >
              Dismiss
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

