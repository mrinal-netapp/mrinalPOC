/**
 * PipelineEditor - Main component for the pipeline editor
 * 
 * This component orchestrates the pipeline editor UI, including:
 * - Header with save action
 * - Canvas (center) with right-click context menu for block selection
 * - Properties panel (right sidebar)
 */

import React, { useCallback } from 'react'
import { Panel } from '@/components/panel/panel'
import { useWorkflowStore } from '@/stores/workflow/store'
import { PipelineContent } from './workflow-content'
import { PipelineHeader } from './workflow-header'
import { PipelineEditorProps } from './types'
import styles from './pipeline-editor.module.css'

export const PipelineEditor: React.FC<PipelineEditorProps> = ({ 
  pipelineName, 
  onSave, 
  onEdit,
  saving = false,
  saveButtonLabel = 'Save Pipeline'
}) => {
  const { getWorkflowState } = useWorkflowStore()

  const handleSave = useCallback(async () => {
    const state = getWorkflowState()
    if (onSave) {
      await onSave(state)
    }
  }, [getWorkflowState, onSave])

  return (
    <div className={styles.container}>
      <PipelineHeader 
        pipelineName={pipelineName}
        onSave={handleSave} 
        onEdit={onEdit}
        saving={saving}
        saveButtonLabel={saveButtonLabel}
      />
      <div className={styles.contentArea}>
        <div className={styles.canvasContainer}>
          <PipelineContent />
        </div>
        <Panel />
      </div>
    </div>
  )
}

