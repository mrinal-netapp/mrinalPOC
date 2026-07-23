import { useState, useEffect, useMemo } from 'react'
import type { SubBlockConfig } from '@/blocks/types'
import type { SubBlockState } from '@/stores/workflow/types'
import { useWorkflowStore } from '@/stores/workflow/store'
import { datasetApi, datasourceApi, projectApi, agentApi, type DataSet, type Bucket, type DataSourceItem, type Project, type Agent } from '@/services/api'
import { SQLMonacoEditor } from '@/components/dataset-explorer/SQLMonacoEditor'

// Input format field interface
interface InputFormatField {
  name: string
  type: string
  value?: string
}

// Input Format Editor Component
function InputFormatEditor({
  subBlock,
  value,
  onChange,
}: {
  subBlock: SubBlockConfig
  value: SubBlockState['value']
  onChange: (newValue: SubBlockState['value']) => void
}) {
  // Convert string[][] to InputFormatField[]
  const parseValue = (val: SubBlockState['value']): InputFormatField[] => {
    if (Array.isArray(val)) {
      // Check if it's string[][] format (array of arrays)
      if (val.length > 0 && Array.isArray(val[0])) {
        return (val as string[][]).map((row) => ({
          name: row[0] || '',
          type: row[1] || 'string',
          value: row[2] || '',
        }))
      }
    }
    return []
  }

  // Convert InputFormatField[] to string[][]
  const serializeValue = (fields: InputFormatField[]): string[][] => {
    return fields.map((field) => [field.name || '', field.type || 'string', field.value || ''])
  }

  // Parse value as array of input format fields
  const [fields, setFields] = useState<InputFormatField[]>(() => parseValue(value))

  // Sync with external value changes
  useEffect(() => {
    setFields(parseValue(value))
  }, [value])

  const addField = () => {
    const newField: InputFormatField = { name: '', type: 'string', value: '' }
    const updated = [...fields, newField]
    setFields(updated)
    onChange(serializeValue(updated))
  }

  const removeField = (index: number) => {
    const updated = fields.filter((_, i) => i !== index)
    setFields(updated)
    onChange(serializeValue(updated))
  }

  const updateField = (index: number, field: Partial<InputFormatField>) => {
    const updated = fields.map((f, i) => (i === index ? { ...f, ...field } : f))
    setFields(updated)
    onChange(serializeValue(updated))
  }

  const typeOptions = ['string', 'number', 'boolean', 'array', 'object', 'json']

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-xs font-medium text-[var(--text-tertiary)]">
          {subBlock.title || subBlock.id}
          {subBlock.required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <button
          type="button"
          onClick={addField}
          className="text-xs px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
        >
          + Add Field
        </button>
      </div>
      {subBlock.description && (
        <p className="text-xs text-[var(--text-tertiary)]">{subBlock.description}</p>
      )}
      {fields.length === 0 ? (
        <div className="text-xs text-[var(--text-tertiary)] italic py-2">
          No input fields defined. Click "Add Field" to add one.
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-3)]">
              <tr>
                <th className="text-left p-2 font-medium text-[var(--text-tertiary)] border-b border-[var(--border)]">Name</th>
                <th className="text-left p-2 font-medium text-[var(--text-tertiary)] border-b border-[var(--border)]">Type</th>
                <th className="text-left p-2 font-medium text-[var(--text-tertiary)] border-b border-[var(--border)]">Value</th>
                <th className="text-left p-2 font-medium text-[var(--text-tertiary)] border-b border-[var(--border)] w-[40px]"></th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field, index) => (
                <tr key={index} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="p-2">
                    <input
                      type="text"
                      value={field.name || ''}
                      onChange={(e) => updateField(index, { name: e.target.value })}
                      placeholder="Field name"
                      className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
                    />
                  </td>
                  <td className="p-2">
                    <select
                      value={field.type || 'string'}
                      onChange={(e) => updateField(index, { type: e.target.value })}
                      className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
                    >
                      {typeOptions.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      type="text"
                      value={field.value || ''}
                      onChange={(e) => updateField(index, { value: e.target.value })}
                      placeholder="Default value (optional)"
                      className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
                    />
                  </td>
                  <td className="p-2">
                    <button
                      type="button"
                      onClick={() => removeField(index)}
                      className="text-red-500 hover:text-red-700 text-lg font-bold px-2"
                      title="Remove field"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

interface PropertyEditorProps {
  blockId: string
  subBlock: SubBlockConfig
  value: SubBlockState['value']
  projectId?: string
}

/**
 * PropertyEditor - Dynamic property editor component
 * Renders appropriate UI controls based on SubBlockConfig type
 */
export function PropertyEditor({ blockId, subBlock, value, projectId }: PropertyEditorProps) {
  const { updateSubBlockValue } = useWorkflowStore()
  const [datasets, setDatasets] = useState<DataSet[]>([])
  const [loadingDatasets, setLoadingDatasets] = useState(false)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loadingBuckets, setLoadingBuckets] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [agents, setAgents] = useState<Agent[]>([])
  const [loadingAgents, setLoadingAgents] = useState(false)

  // Check if this is a dataset_id field that needs a picker
  const isDatasetIdField = useMemo(() => {
    return subBlock.id === 'dataset_id' && projectId
  }, [subBlock.id, projectId])

  // Check if this is a bucket field that needs a picker
  const isBucketField = useMemo(() => {
    return subBlock.id === 'bucket' && projectId
  }, [subBlock.id, projectId])

  const isProjectField = subBlock.id === 'projectId' && subBlock.type === 'dropdown'
  const isAgentField = subBlock.id === 'agentId' && subBlock.type === 'dropdown'

  const selectedProjectId = useWorkflowStore((state) => {
    if (!isAgentField) return undefined
    return state.blocks[blockId]?.subBlocks?.projectId?.value as string | undefined
  })

  // Load datasets if this is a dataset_id field
  useEffect(() => {
    if (isDatasetIdField && projectId) {
      setLoadingDatasets(true)
      datasetApi
        .list(projectId)
        .then((data) => {
          setDatasets(data)
        })
        .catch((err) => {
          console.error('Failed to load datasets:', err)
          setDatasets([])
        })
        .finally(() => {
          setLoadingDatasets(false)
        })
    }
  }, [isDatasetIdField, projectId])

  // Load buckets (volumes) if this is a bucket field
  useEffect(() => {
    if (isBucketField && projectId) {
      setLoadingBuckets(true)
      datasourceApi
        .list(projectId, { type: 'volume' })
        .then((dataSources: DataSourceItem[]) => {
          const mapped: Bucket[] = dataSources.map((ds) => ({
            project_id: ds.project_id,
            name: ds.name,
            region: ds.volume_config?.region || '',
            volume_info: ds.volume_config?.volume_info || { type: '' },
            auth_info: ds.volume_config?.auth_info || { type: '' },
            protocol: ds.volume_config?.protocol || '',
            deployment_config: ds.volume_config?.deployment_config,
            created_at: ds.created_at,
            updated_at: ds.updated_at,
            metadata: ds.metadata,
          }))
          setBuckets(mapped)
        })
        .catch((err) => {
          console.error('Failed to load volumes:', err)
          setBuckets([])
        })
        .finally(() => {
          setLoadingBuckets(false)
        })
    }
  }, [isBucketField, projectId])

  useEffect(() => {
    if (isProjectField) {
      setLoadingProjects(true)
      projectApi
        .list()
        .then(setProjects)
        .catch((err) => {
          console.error('Failed to load projects:', err)
          setProjects([])
        })
        .finally(() => setLoadingProjects(false))
    }
  }, [isProjectField])

  useEffect(() => {
    if (isAgentField && selectedProjectId) {
      setLoadingAgents(true)
      agentApi
        .list(selectedProjectId)
        .then(setAgents)
        .catch((err) => {
          console.error('Failed to load agents:', err)
          setAgents([])
        })
        .finally(() => setLoadingAgents(false))
    } else if (isAgentField) {
      setAgents([])
    }
  }, [isAgentField, selectedProjectId])

  const handleChange = (newValue: SubBlockState['value']) => {
    updateSubBlockValue(blockId, subBlock.id, newValue)
  }

  // Get options for dropdown/combobox
  const options = useMemo(() => {
    if (typeof subBlock.options === 'function') {
      return subBlock.options()
    }
    return subBlock.options || []
  }, [subBlock.options])

  // Render based on subBlock type
  switch (subBlock.type) {
    case 'short-input':
      // Use dataset picker for dataset_id fields
      if (isDatasetIdField) {
        return (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <select
              value={value !== null && value !== undefined ? String(value) : ''}
              onChange={(e) => handleChange(e.target.value)}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              disabled={loadingDatasets}
            >
              <option value="">{loadingDatasets ? 'Loading datasets...' : 'Select dataset...'}</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name || dataset.id}
                </option>
              ))}
            </select>
            {subBlock.description && (
              <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
            )}
          </div>
        )
      }
      // Use bucket picker for bucket fields
      if (isBucketField) {
        return (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <select
              value={value !== null && value !== undefined ? String(value) : ''}
              onChange={(e) => handleChange(e.target.value)}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              disabled={loadingBuckets}
            >
              <option value="">{loadingBuckets ? 'Loading buckets...' : 'Select bucket...'}</option>
              {buckets.map((bucket) => (
                <option key={bucket.name} value={bucket.name}>
                  {bucket.name}
                </option>
              ))}
            </select>
            {subBlock.description && (
              <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
            )}
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <input
            type={subBlock.password ? 'password' : 'text'}
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={subBlock.placeholder}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none"
          />
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'long-input':
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <textarea
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={subBlock.placeholder}
            rows={subBlock.rows || 4}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none resize-y"
          />
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'dropdown':
      if (isProjectField) {
        return (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <select
              value={value !== null && value !== undefined ? String(value) : ''}
              onChange={(e) => {
                handleChange(e.target.value)
                updateSubBlockValue(blockId, 'agentId', '')
              }}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              disabled={loadingProjects}
            >
              <option value="">{loadingProjects ? 'Loading projects...' : (subBlock.placeholder || 'Select a project...')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )
      }

      if (isAgentField) {
        return (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <select
              value={value !== null && value !== undefined ? String(value) : ''}
              onChange={(e) => handleChange(e.target.value)}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
              disabled={loadingAgents || !selectedProjectId}
            >
              <option value="">
                {!selectedProjectId ? 'Select a project first' : loadingAgents ? 'Loading agents...' : (subBlock.placeholder || 'Select an agent...')}
              </option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.description ? ` — ${a.description}` : ''}</option>
              ))}
            </select>
          </div>
        )
      }

      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <select
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
          >
            {subBlock.placeholder && <option value="">{subBlock.placeholder}</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'combobox':
      // For now, render as dropdown. Could be enhanced with search functionality
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <select
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
          >
            {subBlock.placeholder && <option value="">{subBlock.placeholder}</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'code':
      // Check if this is a SQL query subblock (id === 'query' in sql block)
      if (subBlock.id === 'query' && blockId) {
        // Try to detect if this is a SQL block by checking the block type
        // For now, we'll use a simple textarea but could enhance with SQLMonacoEditor
        return (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </label>
            <textarea
              value={value !== null && value !== undefined ? String(value) : ''}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={subBlock.placeholder}
              rows={10}
              className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] font-mono placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none resize-y"
              spellCheck={false}
              style={{ fontFamily: 'monospace' }}
            />
            {subBlock.description && (
              <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
            )}
          </div>
        )
      }
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <textarea
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={(e) => handleChange(e.target.value)}
            placeholder={subBlock.placeholder}
            rows={10}
            className="w-full rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-sm text-[var(--text-primary)] font-mono placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none resize-y"
            spellCheck={false}
          />
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'slider':
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={subBlock.min ?? 0}
              max={subBlock.max ?? 100}
              step={subBlock.step ?? 1}
              value={value !== null && value !== undefined ? Number(value) : subBlock.min ?? 0}
              onChange={(e) => handleChange(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-sm text-[var(--text-secondary)] min-w-[3rem] text-right">
              {value !== null && value !== undefined ? Number(value) : subBlock.min ?? 0}
            </span>
          </div>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'switch':
      // Convert value to boolean for checkbox
      const isChecked = value === 'true' || value === 1
      return (
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => handleChange(e.target.checked ? 'true' : 'false')}
              className="rounded border-[var(--border)] text-[var(--brand-primary-hex)] focus:ring-2 focus:ring-[var(--brand-primary-hex)]"
            />
            <span className="text-xs font-medium text-[var(--text-tertiary)]">
              {subBlock.title || subBlock.id}
              {subBlock.required && <span className="text-red-500 ml-1">*</span>}
            </span>
          </label>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1 ml-6">{subBlock.description}</p>
          )}
        </div>
      )

    case 'text':
      // Read-only text display
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
          </label>
          <div className="text-sm text-[var(--text-secondary)]">
            {value !== null && value !== undefined ? String(value) : '-'}
          </div>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    case 'input-format':
      // Input format editor - table with name, type, and value columns
      return <InputFormatEditor subBlock={subBlock} value={value} onChange={handleChange} />

    case 'sql':
      // SQL code editor with syntax highlighting
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <SQLMonacoEditor
            value={value !== null && value !== undefined ? String(value) : ''}
            onChange={handleChange}
            placeholder={subBlock.placeholder}
            height="300px"
            theme="vs"
          />
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )

    default:
      // Fallback for unsupported types - show as read-only
      return (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-[var(--text-tertiary)] mb-1">
            {subBlock.title || subBlock.id}
            {subBlock.required && <span className="text-red-500 ml-1">*</span>}
          </label>
          <div className="text-sm text-[var(--text-secondary)]">
            {value !== null && value !== undefined ? String(value) : 'Not set'}
          </div>
          {subBlock.description && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1">{subBlock.description}</p>
          )}
        </div>
      )
  }
}

