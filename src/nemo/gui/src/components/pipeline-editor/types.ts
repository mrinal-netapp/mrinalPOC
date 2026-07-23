/**
 * Type definitions for the pipeline editor
 */

export interface PipelineEditorProps {
  pipelineName?: string
  onNameChange?: (name: string) => void
  onSave?: (workflow: any) => void | Promise<void>
  onEdit?: () => void
  saving?: boolean
  saveButtonLabel?: string
}

