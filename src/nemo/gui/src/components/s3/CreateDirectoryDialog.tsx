import { useState } from 'react'
import {
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Field,
  Button,
  Input,
} from '@fluentui/react-components'

interface CreateDirectoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (dirName: string) => Promise<void>
  bucket: string
  path: string
}

export function CreateDirectoryDialog({
  open,
  onOpenChange,
  onConfirm,
  bucket,
  path,
}: CreateDirectoryDialogProps) {
  const [dirName, setDirName] = useState('')

  const handleConfirm = async () => {
    if (dirName.trim()) {
      await onConfirm(dirName.trim())
      setDirName('')
      onOpenChange(false)
    }
  }

  const handleCancel = () => {
    setDirName('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogTitle>Create New Folder</DialogTitle>
        <DialogBody>
          <DialogContent>
            <Field label="Folder name" required>
              <Input
                value={dirName}
                onChange={(_, data) => setDirName(data.value)}
                placeholder="Enter folder name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && dirName.trim()) {
                    handleConfirm()
                  }
                }}
              />
            </Field>
            <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
              Location: {bucket}{path ? `/${path}/` : '/'}{dirName || '...'}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={handleConfirm} disabled={!dirName.trim()}>
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  )
}

