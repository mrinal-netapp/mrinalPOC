/**
 * PipelineHeader component - Header bar with title and actions
 */

import React from 'react'
import { Edit24Regular } from '@fluentui/react-icons'
import styles from './pipeline-editor.module.css'

interface PipelineHeaderProps {
  pipelineName?: string
  onSave?: () => void | Promise<void>
  onEdit?: () => void
  saving?: boolean
  saveButtonLabel?: string
}

export const PipelineHeader: React.FC<PipelineHeaderProps> = ({ 
  pipelineName, 
  onSave, 
  onEdit,
  saving = false,
  saveButtonLabel = 'Save Pipeline'
}) => {
  const displayName = pipelineName || 'New pipeline'

  return (
    <div className={styles.header}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <h1 className={styles.title}>
          {displayName}
        </h1>
        {onEdit && (
          <button
            onClick={onEdit}
            className={styles.editButton}
            title="Edit pipeline name and description"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--colorNeutralForeground2)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--colorNeutralForeground1)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--colorNeutralForeground2)'
            }}
          >
            <Edit24Regular />
          </button>
        )}
      </div>
      <div className={styles.headerActions}>
        {onSave && (
          <button 
            onClick={onSave} 
            className={styles.saveButton}
            disabled={saving}
          >
            {saving ? 'Saving...' : saveButtonLabel}
          </button>
        )}
      </div>
    </div>
  )
}

