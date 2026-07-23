import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { UploadFileLogPanel } from './UploadFileLogPanel'
import {
  Field,
  Input,
  Textarea,
  Dropdown,
  Option,
  Button,
  Label,
  Checkbox,
  Tooltip,
} from '@fluentui/react-components'
import { FolderOpen24Regular } from '@fluentui/react-icons'
import type {
  CreateDataSetRequest,
  Connector,
  DataSetFile,
  ScheduleConfig,
  DataSourceItem,
  ProviderCatalogEntry,
  DataAccessModel,
} from '../../services/api'
import type { ExplorerNode } from '../../services/api'
import { S3PathSelector } from './S3PathSelector'
import { ConnectorExplorer } from '../connector-explorer'
import { ScrollableDialogShell } from '../dialog'
import { SchemaBuilder } from './SchemaBuilder'
import { ScheduleBuilder } from './ScheduleBuilder'
import { getDatasetNameError } from '../../utils/datasetNameValidation'
import { VolumeBrowser } from './VolumeBrowser'

export interface DataSetWizardProps {
  step: number
  formData: CreateDataSetRequest
  updateFormField: (field: keyof CreateDataSetRequest, value: any) => void
  updateArrayField: (field: 'fileProcessors', index: number, value: string) => void
  addArrayItem: (field: 'fileProcessors') => void
  removeArrayItem: (field: 'fileProcessors', index: number) => void
  updateJsonField: (field: 'filterSpec', key: string, value: string) => void
  availableConnectors: Connector[]
  /** NFS/ONTAP volume data sources (same API as connectors list). */
  volumeDataSources?: DataSourceItem[]
  /** Provider catalog keyed by provider id for data access model lookup. */
  providerCatalog?: Record<string, ProviderCatalogEntry>
  uploadedFiles: File[]
  setUploadedFiles: (files: File[]) => void
  uploadProgress: Record<string, number>
  uploadErrors: Record<string, string>
  existingFiles: DataSetFile[]
  onDeleteExistingFile: (fileId: string) => void
  isEditing: boolean
  filesToDelete?: Set<string>
  projectId?: string
  /** True while create/update (including S3 uploads) is in flight */
  submitting?: boolean
  /** Parallel upload worker count; shown in overall progress when &gt; 1 */
  uploadConcurrency?: number
}

// Helper type for key-value pair entries with stable IDs
interface KeyValueEntry {
  id: string // Stable unique ID that doesn't change
  key: string // The actual key value that can change
}

/** Display URI for object-store-shaped explorer resources (S3 / GCS). */
function formatObjectStoreDisplayUri(
  resource: Record<string, unknown> | undefined,
  scheme: 'gs' | 's3' | null,
): string | null {
  if (!resource) return null
  const bucket = resource.bucket
  const prefix = resource.prefix
  if (typeof bucket !== 'string' || !bucket.trim()) return null
  const p = typeof prefix === 'string' ? prefix.replace(/\/$/, '') : ''
  if (!scheme) {
    return p ? `${bucket}/${p}` : bucket
  }
  const auth = scheme === 'gs' ? 'gs' : 's3'
  return p ? `${auth}://${bucket}/${p}` : `${auth}://${bucket}`
}

function ModelDrivenExplorer({
  model,
  projectId,
  connectorId,
  connectorScope,
  selectedResourceNodeIds,
  selectedResourceNodes,
  onToggleNode,
  onSelectSingle,
  initialActionOverride,
  sqlQuery,
  onSqlQueryChange,
  catalogEntry,
  defaultRegion,
  objectStoreUriScheme,
}: {
  model: DataAccessModel
  projectId?: string
  connectorId?: string
  connectorScope: 'account' | 'resource'
  selectedResourceNodeIds: Set<string>
  selectedResourceNodes: ExplorerNode[]
  onToggleNode: (node: ExplorerNode) => void
  onSelectSingle: (node: ExplorerNode) => void
  /** Optional override for `model.rootAction` (e.g. database connector with a configured database starts at schemas). */
  initialActionOverride?: string
  /** Current SQL text — only used when `model.queryEditor` is present. */
  sqlQuery?: string
  /** Editor change handler — only used when `model.queryEditor` is present. */
  onSqlQueryChange?: (sql: string) => void
  /** Provider catalog row for region selector and related explorer flags. */
  catalogEntry?: ProviderCatalogEntry | null
  defaultRegion?: string
  /** When set, show a gs:// or s3:// line for bucket/prefix selections. */
  objectStoreUriScheme?: 'gs' | 's3' | null
}) {
  const isMulti = model.selectionMode === 'multi'
  const singleSelected = !isMulti && selectedResourceNodes.length > 0 ? selectedResourceNodes[0] : null
  const hasQueryEditor = Boolean(model.queryEditor)
  const objectStoreUri = formatObjectStoreDisplayUri(
    singleSelected?.resource as Record<string, unknown> | undefined,
    objectStoreUriScheme ?? null,
  )
  const hasRegionSelector = catalogEntry?.hasRegionSelector === true

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '8px' }}>
      <div style={{
        flex: 1,
        minHeight: '240px',
        maxHeight: '400px',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--colorNeutralStroke1)',
        borderRadius: '8px',
        overflow: 'hidden',
      }}>
        {projectId && connectorId && (
          <ConnectorExplorer
            embedded
            projectId={projectId}
            connectorId={connectorId}
            connectorScope={connectorScope}
            initialAction={initialActionOverride || model.rootAction}
            hasRegionSelector={hasRegionSelector}
            defaultRegion={defaultRegion}
            selectionMode={model.selectionMode}
            selectableTypes={model.selectableTypes}
            selectedNodeIds={isMulti ? selectedResourceNodeIds : undefined}
            onToggleNode={isMulti ? onToggleNode : undefined}
            selectedNodeId={!isMulti ? singleSelected?.id : undefined}
            onSelectNode={!isMulti ? (node) => {
              if (model.selectableTypes.includes(node.type)) {
                onSelectSingle(node)
              }
            } : undefined}
            style={{ border: 'none', borderRadius: 0 }}
          />
        )}
      </div>
      <div style={{
        padding: '8px 12px',
        backgroundColor: 'var(--colorNeutralBackground3)',
        borderRadius: '6px',
        fontSize: '13px',
        minHeight: '36px',
      }}>
        {isMulti ? (
          selectedResourceNodes.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontWeight: 600, marginRight: '4px' }}>Selected:</span>
              {selectedResourceNodes.map((node) => (
                <span
                  key={node.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    padding: '2px 8px',
                    backgroundColor: 'var(--colorNeutralBackground1)',
                    border: '1px solid var(--colorNeutralStroke1)',
                    borderRadius: '12px',
                    fontSize: '12px',
                  }}
                >
                  {node.label}
                  <button
                    type="button"
                    onClick={() => onToggleNode(node)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '0 2px',
                      fontSize: '14px',
                      lineHeight: 1,
                      color: 'var(--colorNeutralForeground3)',
                    }}
                    aria-label={`Remove ${node.label}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <span style={{ color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
              No items selected — all data will be included
            </span>
          )
        ) : singleSelected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <span>
              <span style={{ fontWeight: 600, marginRight: '6px' }}>Selected:</span>
              {singleSelected.label}
              <span style={{ color: 'var(--colorNeutralForeground3)', marginLeft: '8px', fontSize: '11px' }}>
                ({singleSelected.type})
              </span>
            </span>
            {objectStoreUri ? (
              <span style={{ fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all', color: 'var(--colorNeutralForeground2)' }}>
                <span style={{ fontWeight: 600, fontFamily: 'inherit' }}>Source: </span>
                {objectStoreUri}
              </span>
            ) : null}
          </div>
        ) : (
          <span style={{ color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
            Pick an item from the tree to use as the dataset source.
          </span>
        )}
      </div>
      {hasQueryEditor && (
        <Field label={`Query (${model.queryEditor!.language.toUpperCase()})`} required>
          <Textarea
            value={sqlQuery || ''}
            onChange={(e) => onSqlQueryChange?.(e.target.value || '')}
            placeholder='SELECT * FROM "schema"."table" — pick a table above to auto-fill, or write your own query'
            rows={6}
          />
          <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
            Selecting a table from the tree replaces the editor contents with a default <code>SELECT *</code>. Edit freely afterward.
          </div>
        </Field>
      )}
    </div>
  )
}

export function DataSetWizard({
  step,
  formData,
  updateFormField,
  updateArrayField,
  addArrayItem,
  removeArrayItem,
  updateJsonField,
  availableConnectors,
  volumeDataSources = [],
  providerCatalog,
  uploadedFiles,
  setUploadedFiles,
  uploadProgress,
  uploadErrors,
  existingFiles,
  onDeleteExistingFile,
  isEditing,
  filesToDelete,
  projectId,
  submitting = false,
  uploadConcurrency = 1,
}: DataSetWizardProps) {
  const [volumeBrowserOpen, setVolumeBrowserOpen] = useState(false)
  const [s3PathSelectorOpen, setS3PathSelectorOpen] = useState(false)
  const [s3ConnectorPathExplorerOpen, setS3ConnectorPathExplorerOpen] = useState(false)
  const [s3ConnectorPathSelectedNode, setS3ConnectorPathSelectedNode] = useState<ExplorerNode | null>(null)
  const [connectorExplorerOpen, setConnectorExplorerOpen] = useState(false)
  const [selectedResourceNodes, setSelectedResourceNodes] = useState<ExplorerNode[]>([])
  // Tracks the connector id we've already seeded selections for, so the seed
  // effect runs once per connector transition (not on every toggle).
  const seededConnectorRef = useRef<string | null | undefined>(undefined)
  const [datasetNameError, setDatasetNameError] = useState<string | undefined>(undefined)
  // Use stable IDs for entries to prevent React from remounting on key changes
  const [filterSpecEntries, setFilterSpecEntries] = useState<KeyValueEntry[]>(() => {
    const keys = Object.keys(formData.filterSpec || {})
    return keys.map((key, index) => ({ id: `filter-${index}-${key}`, key }))
  })

  // Sync entries with formData when it changes externally (e.g., form reset)
  useEffect(() => {
    const keys = Object.keys(formData.filterSpec || {})
    
    // Update filter spec entries - add new ones, remove deleted ones, keep existing ones
    setFilterSpecEntries((prev) => {
      const existingKeys = new Set(prev.map((e) => e.key))
      const newKeys = new Set(keys)
      
      // Remove entries for keys that no longer exist
      const filtered = prev.filter((e) => newKeys.has(e.key))
      
      // Add entries for new keys
      const addedKeys = keys.filter((k) => !existingKeys.has(k))
      const newEntries = addedKeys.map((key) => ({
        id: `filter-${Date.now()}-${key}`,
        key,
      }))
      
      return [...filtered, ...newEntries]
    })
  }, [formData.filterSpec])

  // Reset validation error when form is reset or editing mode changes
  useEffect(() => {
    if (!formData.name) {
      setDatasetNameError(undefined)
    } else if (!isEditing) {
      // Re-validate when switching to create mode
      const error = getDatasetNameError(formData.name)
      setDatasetNameError(error)
    } else {
      // Clear error when editing (name changes are restricted)
      setDatasetNameError(undefined)
    }
  }, [formData.name, isEditing])

  const addJsonKey = (field: 'filterSpec') => {
    const newKey = `key${Date.now()}`
    updateJsonField(field, newKey, '')
    setFilterSpecEntries([...filterSpecEntries, { id: `filter-${Date.now()}-${newKey}`, key: newKey }])
  }

  const removeJsonKey = (field: 'filterSpec', entryId: string, currentKey: string) => {
    const current = formData[field] || {}
    const updated = { ...current }
    delete updated[currentKey]
    updateFormField(field, updated)
    setFilterSpecEntries(filterSpecEntries.filter((e) => e.id !== entryId))
  }

  const selectedResourceNodeIds = useMemo(
    () => new Set(selectedResourceNodes.map((n) => n.id)),
    [selectedResourceNodes],
  )

  /**
   * A metric_category leaf under the unified ONTAP/GCP "Performance Metrics"
   * service. Used to enforce three wizard guardrails:
   *   - lock dataset kind to `structured` (metrics are time-series rows)
   *   - reject mixing metric_category and other resource picks (the workflow
   *     dispatches metrics-vs-objectstore on selector shape, so a mixed
   *     selector would silently hit one path and miss the other)
   *   - default writeMode to `append` and forbid `overwrite` (the workflow
   *     also rejects overwrite for metrics, but blocking it here gives a
   *     better UX)
   */
  const isMetricCategoryNode = useCallback((node: ExplorerNode): boolean => {
    if (node.type === 'metric_category') return true
    const res = node.resource as Record<string, unknown> | undefined
    return Boolean(res && typeof res.category === 'string' && (res.category as string).length > 0)
  }, [])

  const applyMetricGuardrails = useCallback((nodes: ExplorerNode[]) => {
    const hasMetric = nodes.some(isMetricCategoryNode)
    if (!hasMetric) return
    if (formData.kind !== 'structured') {
      updateFormField('kind', 'structured')
    }
    const wm = formData.acquisitionConfig?.writeMode
    if (wm !== 'append' && wm !== 'incremental') {
      updateFormField('acquisitionConfig', {
        ...formData.acquisitionConfig,
        writeMode: 'append',
      })
    }
  }, [isMetricCategoryNode, formData.kind, formData.acquisitionConfig, updateFormField])

  const handleToggleResourceNode = useCallback((node: ExplorerNode) => {
    setSelectedResourceNodes((prev) => {
      const exists = prev.some((n) => n.id === node.id)
      const next = exists ? prev.filter((n) => n.id !== node.id) : [...prev, node]
      // Reject mixing metric_category with non-metric picks. AcquireMetrics
      // wants a homogeneous selector; an objectstore pipeline cannot consume
      // a category entry. Surface a quick alert and drop the new pick.
      const hasMetric = next.some(isMetricCategoryNode)
      const hasNonMetric = next.some((n) => !isMetricCategoryNode(n))
      if (hasMetric && hasNonMetric) {
        // eslint-disable-next-line no-alert
        alert('Metric categories cannot be combined with volume / folder / table selections in the same dataset. Create a separate dataset for the metric categories.')
        return prev
      }
      updateFormField('resourceSelector', next.map((n) => n.resource).filter(Boolean))
      applyMetricGuardrails(next)
      return next
    })
  }, [updateFormField, isMetricCategoryNode, applyMetricGuardrails])

  const handleSelectResourceNode = useCallback((node: ExplorerNode) => {
    const next = node.resource ? [node] : []
    setSelectedResourceNodes(next)
    updateFormField('resourceSelector', next.map((n) => n.resource).filter(Boolean))
    applyMetricGuardrails(next)
  }, [updateFormField, applyMetricGuardrails])

  /**
   * Selection handler for model-driven providers. Wraps `handleSelectResourceNode`
   * with type-aware side effects that the legacy hard-coded branches used to
   * apply directly:
   *   - Database table/view: auto-fill `sqlQuery`, `sourceDatabase`, `sourceSchema`
   *     so acquisition can connect even when the connector has no default db.
   *   - Objectstore folder: also clear stale `filterSpec.sourcePath` so the new
   *     `resourceSelector` is the single source of truth on this dataset.
   */
  const handleSelectModelNode = useCallback((node: ExplorerNode) => {
    handleSelectResourceNode(node)
    const res = (node.resource || {}) as { database?: string; schema?: string; table?: string }
    if ((node.type === 'table' || node.type === 'view') && res.schema != null && res.table != null) {
      const sql = res.database != null
        ? `-- Database: ${res.database}\nSELECT * FROM "${res.schema}"."${res.table}"`
        : `SELECT * FROM "${res.schema}"."${res.table}"`
      updateFormField('sqlQuery', sql)
      if (res.database != null) updateFormField('sourceDatabase', res.database)
      if (res.schema != null) updateFormField('sourceSchema', res.schema)
    }
    const clearLegacySourcePath = () => {
      const fs = formData.filterSpec
      if (fs && (fs.sourcePath || (fs as Record<string, unknown>).source_path)) {
        const next = { ...fs }
        delete (next as Record<string, unknown>).sourcePath
        delete (next as Record<string, unknown>).source_path
        updateFormField('filterSpec', Object.keys(next).length > 0 ? next : undefined)
      }
    }
    // Object-store shaped picks (S3 folders, GCS buckets/prefixes/objects): resourceSelector is canonical.
    if (
      node.type === 'folder'
      || node.type === 'file'
      || (node.type === 'resource' && node.kind === 'bucket')
    ) {
      clearLegacySourcePath()
    }
  }, [handleSelectResourceNode, updateFormField, formData.filterSpec])

  const resolveDataAccessModel = useCallback((): DataAccessModel | undefined => {
    if (!providerCatalog || !formData.originConnector) return undefined
    const connector = availableConnectors.find((c) => c.id === formData.originConnector)
    const provider = (connector?.connectorConfig as any)?.provider as string | undefined
    return provider ? providerCatalog[provider]?.dataAccessModel : undefined
  }, [providerCatalog, formData.originConnector, availableConnectors])

  // Seed (once per connector) from any pre-existing formData.resourceSelector,
  // then clear it the next time the user picks a different connector. This
  // separation prevents the seeding from clobbering live toggles, which write
  // back into formData.resourceSelector and would otherwise trip a re-seed.
  //
  // Backward-compat: for objectstore datasets created before phase 2 (where
  // selection lived in `filterSpec.sourcePath`), fall back to synthesizing a
  // single folder entry so the user sees their previous choice as a chip and
  // can preserve or replace it without re-typing.
  useEffect(() => {
    const cid = formData.originConnector ?? null
    if (seededConnectorRef.current === cid) {
      return
    }
    seededConnectorRef.current = cid

    if (!cid) {
      setSelectedResourceNodes([])
      return
    }

    let initial = formData.resourceSelector || []

    if (initial.length === 0) {
      const legacyPath = formData.filterSpec?.sourcePath
      if (typeof legacyPath === 'string' && legacyPath.trim()) {
        const parts = legacyPath.split('/').filter(Boolean)
        const bucket = parts.shift() || ''
        const prefix = parts.join('/')
        if (bucket) {
          initial = [{ bucket, prefix }]
        }
      }
    }

    if (initial.length === 0) {
      setSelectedResourceNodes([])
      return
    }

    // Restored entries use synthetic ids; the explorer treats them as
    // unmatched and will re-key when the user re-selects in the live tree.
    const nodes: ExplorerNode[] = initial.map((res, i) => {
      const keys = Object.keys(res)
      // Heuristic: a `bucket`+`prefix` shape is a folder; otherwise the
      // first key is the type discriminator (query_id, dashboard_slug,
      // category, table, ...).
      const type = ('bucket' in res && 'prefix' in res)
        ? 'folder'
        : (keys[0] ?? 'resource')
      return {
        id: `restored-${i}`,
        label: Object.values(res).join(' / ') || `Item ${i + 1}`,
        type,
        resource: res,
        childrenHint: 'leaf' as const,
      }
    })
    setSelectedResourceNodes(nodes)
  }, [formData.originConnector, formData.resourceSelector, formData.filterSpec])

  // Step 1: Basic Information
  if (step === 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Basic Information</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Provide a name and description for your dataset, and select its type.
          </p>
        </div>

        <Field 
          label="Dataset Name" 
          required
          validationMessage={datasetNameError}
          validationState={datasetNameError ? 'error' : 'none'}
        >
          <Input
            value={formData.name}
            onChange={(e) => {
              const newName = e.target.value
              updateFormField('name', newName)
              // Validate dataset name in real-time
              if (!isEditing) {
                const error = getDatasetNameError(newName)
                setDatasetNameError(error)
              }
            }}
            onBlur={() => {
              // Re-validate on blur
              if (!isEditing && formData.name) {
                const error = getDatasetNameError(formData.name)
                setDatasetNameError(error)
              }
            }}
            placeholder="e.g., customer_documents, sales_data"
          />
          {!isEditing && (
            <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              Use lowercase letters, numbers, underscores, and hyphens only. Must start with a letter or underscore.
            </div>
          )}
        </Field>

        <Field label="Description">
          <Textarea
            value={formData.description}
            onChange={(e) => updateFormField('description', e.target.value)}
            placeholder="Describe what this dataset contains and how it will be used... (optional)"
            rows={4}
          />
        </Field>

        <Field label="Dataset Kind" required>
          <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
            <Button
              appearance={formData.kind === 'unstructured' ? 'primary' : 'secondary'}
              onClick={() => updateFormField('kind', 'unstructured')}
              disabled={isEditing || (formData.resourceSelector || []).some((r) => r && typeof (r as Record<string, unknown>).category === 'string')}
              style={{ flex: 1 }}
            >
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>Unstructured</div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                  Documents, files, text, images
                </div>
              </div>
            </Button>
            <Button
              appearance={formData.kind === 'structured' ? 'primary' : 'secondary'}
              onClick={() => updateFormField('kind', 'structured')}
              disabled={isEditing}
              style={{ flex: 1 }}
            >
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>Structured</div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                  Database tables, CSV files
                </div>
              </div>
            </Button>
          </div>
          {(formData.resourceSelector || []).some((r) => r && typeof (r as Record<string, unknown>).category === 'string') && (
            <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              Locked to <strong>structured</strong> because this dataset includes performance metric categories.
            </div>
          )}
        </Field>

        <Field label="Storage Location">
          <div style={{
            padding: '8px 12px',
            backgroundColor: 'var(--colorNeutralBackground2)',
            borderRadius: '4px',
            fontSize: '13px',
            color: 'var(--colorNeutralForeground2)',
          }}>
            {projectId ? 'Project storage' : 'Derived from project home'}
          </div>
          <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--colorNeutralForeground3)' }}>
            Storage is automatically managed under the project home directory.
          </div>
        </Field>
      </div>
    )
  }

  // Step 2: Data Source
  if (step === 2) {
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length > 0) {
        setUploadedFiles([...uploadedFiles, ...files])
      }
      // Reset input so same files can be re-selected
      e.target.value = ''
    }

    const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || [])
      if (files.length > 0) {
        setUploadedFiles([...uploadedFiles, ...files])
      }
      // Reset input so same folder can be re-selected
      e.target.value = ''
    }

    const removeFile = (index: number) => {
      setUploadedFiles(uploadedFiles.filter((_, i) => i !== index))
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Data Source</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Choose how data will be provided for this dataset.
          </p>
        </div>

        <Field label="Data Source Type" required>
          <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
            <Button
              appearance={formData.type === 'acquired' ? 'primary' : 'secondary'}
              onClick={() => {
                updateFormField('type', 'acquired')
                setUploadedFiles([])
              }}
              disabled={isEditing}
              style={{ flex: 1 }}
            >
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>Acquired</div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                  From a connector or a mounted NFS/ONTAP volume
                </div>
              </div>
            </Button>
            <Button
              appearance={formData.type === 'manual' ? 'primary' : 'secondary'}
              onClick={() => {
                updateFormField('type', 'manual')
                updateFormField('originConnector', undefined)
                updateFormField('originVolume', undefined)
              }}
              disabled={isEditing}
              style={{ flex: 1 }}
            >
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>Manual</div>
                <div style={{ fontSize: '12px', opacity: 0.8 }}>
                  Upload files directly
                </div>
              </div>
            </Button>
          </div>
        </Field>

        {formData.type === 'acquired' ? (
          (() => {
            const acqOptions = [
              ...availableConnectors.map((c) => ({
                kind: 'connector' as const,
                id: c.id,
                label: `${c.name} (${c.type})`,
                token: `c:${c.id}`,
              })),
              ...volumeDataSources.map((v) => ({
                kind: 'volume' as const,
                id: v.id,
                label: `${v.name} (volume)`,
                token: `v:${v.id}`,
              })),
            ]
            const selectedToken = formData.originVolume
              ? `v:${formData.originVolume}`
              : formData.originConnector
                ? `c:${formData.originConnector}`
                : ''
            const selectedOpt = acqOptions.find((o) => o.token === selectedToken)

            if (acqOptions.length === 0) {
              return (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--colorNeutralForeground3)' }}>
                  <p>No connectors or volume data sources found. Add one under project data sources.</p>
                </div>
              )
            }

            return (
              <>
                <Field label="Acquired data source" required>
                  <Dropdown
                    value={selectedOpt?.label || ''}
                    onOptionSelect={(_, data) => {
                      const opt = acqOptions.find((o) => o.label === data.optionValue)
                      if (!opt) return
                      if (opt.kind === 'connector') {
                        updateFormField('originConnector', opt.id)
                        updateFormField('originVolume', undefined)
                      } else {
                        updateFormField('originVolume', opt.id)
                        updateFormField('originConnector', undefined)
                      }
                    }}
                    placeholder="Select a connector or volume..."
                  >
                    {acqOptions.map((o) => (
                      <Option key={o.token} value={o.label}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                  {formData.originConnector && (
                    <div style={{ marginTop: '12px', padding: '12px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
                      {(() => {
                        const selectedConnector = availableConnectors.find(
                          (c) => c.id === formData.originConnector
                        )
                        return selectedConnector ? (
                          <>
                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                              {selectedConnector.name}
                            </div>
                            <div style={{ fontSize: '14px', color: 'var(--colorNeutralForeground3)' }}>
                              {selectedConnector.description}
                            </div>
                          </>
                        ) : null
                      })()}
                    </div>
                  )}
                  {formData.originVolume && (
                    <div style={{ marginTop: '12px', padding: '12px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
                      {(() => {
                        const v = volumeDataSources.find((x) => x.id === formData.originVolume)
                        return v ? (
                          <>
                            <div style={{ fontWeight: 600, marginBottom: '4px' }}>{v.name}</div>
                            <div style={{ fontSize: '14px', color: 'var(--colorNeutralForeground3)' }}>
                              {v.description || 'Mounted NFS / ONTAP volume (read-only at acquisition).'}
                            </div>
                          </>
                        ) : null
                      })()}
                    </div>
                  )}
                </Field>
              </>
            )
          })()
        ) : (
          <>
            <div style={{ marginBottom: '12px', padding: '12px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
              <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginBottom: '4px' }}>
                Storage Location
              </div>
              <div style={{ fontWeight: 600 }}>Project storage</div>
              <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginTop: '4px' }}>
                Managed under project home directory
              </div>
            </div>

            {/* Show existing files when editing */}
            {isEditing && existingFiles.length > 0 && (
              <Field label="Existing Files">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  {existingFiles.map((file) => {
                    const fileName = file.originalName || file.fileKey.split('/').pop() || file.fileKey
                    const uploadDate = new Date(file.createdAt).toLocaleString()
                    
                    return (
                      <div
                        key={file.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '12px',
                          backgroundColor: 'var(--colorNeutralBackground2)',
                          borderRadius: '4px',
                          border: '1px solid var(--colorNeutralStroke2)',
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {fileName}
                            <span style={{ fontSize: '11px', color: 'var(--colorNeutralForeground3)', fontWeight: 'normal' }}>
                              (existing)
                            </span>
                          </div>
                          <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginTop: '4px' }}>
                            {file.size ? `${(file.size / 1024).toFixed(2)} KB` : 'Size unknown'} • Uploaded: {uploadDate}
                          </div>
                        </div>
                        <Button
                          appearance="subtle"
                          onClick={() => onDeleteExistingFile(file.id)}
                          aria-label="Delete file"
                          style={{ color: 'var(--colorPaletteRedForeground1)' }}
                        >
                          Delete
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </Field>
            )}

            <Field label={isEditing ? "Add More Files" : "Upload Files or Folders"} required={!isEditing}>
              <input
                type="file"
                multiple
                onChange={handleFileChange}
                style={{ display: 'none' }}
                id="dataset-file-input"
              />
              <input
                type="file"
                ref={(input) => {
                  if (input) {
                    input.setAttribute('webkitdirectory', '')
                    input.setAttribute('directory', '')
                  }
                }}
                multiple
                onChange={handleFolderChange}
                style={{ display: 'none' }}
                id="dataset-folder-input"
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                <Button
                  appearance="secondary"
                  onClick={() => document.getElementById('dataset-file-input')?.click()}
                  disabled={submitting}
                >
                  Add Files
                </Button>
                <Button
                  appearance="secondary"
                  icon={<FolderOpen24Regular />}
                  onClick={() => document.getElementById('dataset-folder-input')?.click()}
                  disabled={submitting}
                >
                  Add Folder
                </Button>
                {uploadedFiles.length > 0 && (
                  <Button
                    appearance="subtle"
                    onClick={() => setUploadedFiles([])}
                    disabled={submitting}
                  >
                    Clear All
                  </Button>
                )}
              </div>
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                {isEditing
                  ? 'Select additional files or folders to add to this dataset'
                  : 'Select files individually or choose entire folders. You can add multiple folders.'}
              </div>
            </Field>

            {uploadedFiles.length > 0 && (
              <div>
                <Label>Selected Files ({uploadedFiles.length})</Label>
                <div style={{ marginTop: '8px' }}>
                  <UploadFileLogPanel
                    files={uploadedFiles}
                    uploadProgress={uploadProgress}
                    uploadErrors={uploadErrors}
                    onRemove={removeFile}
                    showOverallProgress={
                      submitting && formData.type === 'manual' && uploadedFiles.length > 0
                    }
                    removeDisabled={submitting}
                    parallelUploadLimit={uploadConcurrency}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  // Step 3: Configuration
  if (step === 3) {
    // Find the selected connector to check its type
    const selectedConnector = availableConnectors.find(
      (connector) => connector.id === formData.originConnector
    )
    const isDatabaseConnector = selectedConnector?.type === 'database'
    const selectedVolume = volumeDataSources.find((v) => v.id === formData.originVolume)
    const isVolumeSource = Boolean(formData.originVolume && selectedVolume)

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Configuration</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Configure how your {formData.kind} dataset should be processed.
          </p>
        </div>

        {/* Volume-sourced dataset configuration */}
        {formData.type === 'acquired' && isVolumeSource ? (
          <>
            <Field label="Source Path (optional)">
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <Input
                  value={formData.filterSpec?.sourcePath || ''}
                  onChange={(e) => {
                    updateJsonField('filterSpec', 'sourcePath', e.target.value)
                  }}
                  placeholder="e.g. data/reports (leave empty for entire volume)"
                  style={{ flex: 1 }}
                />
                {projectId && formData.originVolume && (
                  <Button
                    appearance="secondary"
                    icon={<FolderOpen24Regular />}
                    onClick={() => setVolumeBrowserOpen(true)}
                  >
                    Browse
                  </Button>
                )}
              </div>
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Sub-path within the mounted volume. All files under this path will be included. Leave empty to use the volume root.
              </div>
            </Field>

            {volumeBrowserOpen && projectId && formData.originVolume && selectedVolume && (
              <VolumeBrowser
                open={volumeBrowserOpen}
                onOpenChange={setVolumeBrowserOpen}
                projectId={projectId}
                volumeId={formData.originVolume}
                volumeName={selectedVolume.name}
                onSelect={(path: string) => {
                  updateJsonField('filterSpec', 'sourcePath', path)
                }}
              />
            )}

            <Field label="File include pattern (optional)">
              <Input
                value={formData.acquisitionConfig?.fileGlob ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  updateFormField('acquisitionConfig', {
                    ...formData.acquisitionConfig,
                    fileGlob: v || undefined,
                    fileExcludePattern: formData.acquisitionConfig?.fileExcludePattern,
                    writeMode: formData.acquisitionConfig?.writeMode,
                  })
                }}
                placeholder="e.g. *.csv, *.parquet (comma-separated; leave empty for all files)"
                style={{ maxWidth: '480px' }}
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Only include files whose names match these glob patterns.
              </div>
            </Field>

            <Field label="File exclude pattern (optional)">
              <Input
                value={formData.acquisitionConfig?.fileExcludePattern ?? ''}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  updateFormField('acquisitionConfig', {
                    ...formData.acquisitionConfig,
                    fileGlob: formData.acquisitionConfig?.fileGlob,
                    fileExcludePattern: v || undefined,
                    writeMode: formData.acquisitionConfig?.writeMode,
                  })
                }}
                placeholder="e.g. *.tmp, .DS_Store (comma-separated)"
                style={{ maxWidth: '480px' }}
              />
              <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Exclude files whose names match these glob patterns.
              </div>
            </Field>

            <Field label="Write Mode">
              {(() => {
                const isMetrics = (formData.resourceSelector || []).some(
                  (r) => r && typeof (r as Record<string, unknown>).category === 'string',
                )
                return (
                  <>
                    <Dropdown
                      value={formData.acquisitionConfig?.writeMode || 'append'}
                      onOptionSelect={(_, data) => {
                        const next = data.optionValue as string
                        if (isMetrics && next === 'overwrite') return
                        updateFormField('acquisitionConfig', {
                          ...formData.acquisitionConfig,
                          writeMode: next,
                        })
                      }}
                    >
                      <Option value="append">Append (add new files alongside existing)</Option>
                      {!isMetrics && (
                        <Option value="overwrite">Overwrite (replace all data on each run)</Option>
                      )}
                      <Option value="incremental">Incremental (only new/modified files via mtime)</Option>
                    </Dropdown>
                    <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                      {isMetrics
                        ? 'Metrics datasets only support append/incremental in v1; each run appends a new snapshot of metric samples (the watermark drives the time-range query so you do not get duplicates).'
                        : 'Controls how data from the volume is merged with existing dataset content on subsequent runs.'}
                    </div>
                  </>
                )
              })()}
            </Field>

            {formData.kind === 'unstructured' && (
              <Field label="File Processors (Optional)">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Button
                    appearance="secondary"
                    onClick={() => addArrayItem('fileProcessors')}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    + Add Processor
                  </Button>
                  {(formData.fileProcessors || []).map((item, index) => (
                    <div key={index} style={{ display: 'flex', gap: '8px' }}>
                      <Input
                        value={item}
                        onChange={(e) => updateArrayField('fileProcessors', index, e.target.value)}
                        placeholder="Processor name"
                        style={{ flex: 1 }}
                      />
                      <Button
                        appearance="subtle"
                        onClick={() => removeArrayItem('fileProcessors', index)}
                        aria-label="Remove processor"
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                  {(!formData.fileProcessors || formData.fileProcessors.length === 0) && (
                    <p style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                      No processors added.
                    </p>
                  )}
                </div>
              </Field>
            )}

            <div style={{
              padding: '12px',
              backgroundColor: 'var(--colorNeutralBackground2)',
              borderRadius: '4px',
              fontSize: '13px',
              color: 'var(--colorNeutralForeground2)',
            }}>
              <strong>Zero-copy acquisition:</strong> Files are read directly from the mounted volume — no data is copied during acquisition.
              Only processed outputs (Parquet, stats, metadata) are written to the project storage.
            </div>
          </>
        ) : formData.type === 'acquired' && resolveDataAccessModel() ? (
          <>
            <ModelDrivenExplorer
              model={resolveDataAccessModel()!}
              projectId={projectId}
              connectorId={formData.originConnector}
              connectorScope={(() => {
                const c = availableConnectors.find((x) => x.id === formData.originConnector)
                return ((c?.connectorConfig as { scope?: string })?.scope || 'account') as 'account' | 'resource'
              })()}
              initialActionOverride={(() => {
                // Database connectors with a configured database start at schemas
                // so the user doesn't have to re-pick the database every time.
                const c = availableConnectors.find((x) => x.id === formData.originConnector)
                const cfg = (c?.connectorConfig || {}) as { database?: string }
                const model = resolveDataAccessModel()
                if (model?.queryEditor && cfg.database) return 'listSchemas'
                return undefined
              })()}
              selectedResourceNodeIds={selectedResourceNodeIds}
              selectedResourceNodes={selectedResourceNodes}
              onToggleNode={handleToggleResourceNode}
              onSelectSingle={handleSelectModelNode}
              sqlQuery={formData.sqlQuery || ''}
              onSqlQueryChange={(sql) => updateFormField('sqlQuery', sql || undefined)}
              catalogEntry={(() => {
                const c = availableConnectors.find((x) => x.id === formData.originConnector)
                const pid = (c?.connectorConfig as { provider?: string })?.provider
                return pid && providerCatalog ? providerCatalog[pid] : undefined
              })()}
              defaultRegion={(selectedConnector?.connectorConfig as { default_region?: string })?.default_region}
              objectStoreUriScheme={
                (selectedConnector?.connectorConfig as { provider?: string })?.provider === 'gcp'
                  ? 'gs'
                  : (selectedConnector?.connectorConfig as { provider?: string })?.provider === 's3'
                    ? 's3'
                    : null
              }
            />
            {formData.kind === 'unstructured'
              && (selectedConnector?.type === 'objectstore' || selectedConnector?.type === 'cloud')
              && (
              <>
                <Field label="File include pattern (optional)">
                  <Input
                    value={formData.acquisitionConfig?.fileGlob ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      updateFormField('acquisitionConfig', {
                        ...formData.acquisitionConfig,
                        fileGlob: v || undefined,
                        fileExcludePattern: formData.acquisitionConfig?.fileExcludePattern,
                      })
                    }}
                    placeholder="e.g. *.csv, *.parquet (comma-separated; leave empty for all files)"
                    style={{ maxWidth: '480px' }}
                  />
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                    Only include files whose names match these glob patterns. Examples: <code>*.csv</code>, <code>*.parquet</code>, <code>*.json,*.jsonl</code>
                  </div>
                </Field>
                <Field label="File exclude pattern (optional)">
                  <Input
                    value={formData.acquisitionConfig?.fileExcludePattern ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      updateFormField('acquisitionConfig', {
                        ...formData.acquisitionConfig,
                        fileGlob: formData.acquisitionConfig?.fileGlob,
                        fileExcludePattern: v || undefined,
                      })
                    }}
                    placeholder="e.g. *.tmp, .DS_Store (comma-separated)"
                    style={{ maxWidth: '480px' }}
                  />
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                    Exclude files whose names match these glob patterns. Applied after the include filter.
                  </div>
                </Field>
                <Field label="File Processors (Optional)">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <Button
                      appearance="secondary"
                      onClick={() => addArrayItem('fileProcessors')}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      + Add Processor
                    </Button>
                    {(formData.fileProcessors || []).map((item, index) => (
                      <div key={index} style={{ display: 'flex', gap: '8px' }}>
                        <Input
                          value={item}
                          onChange={(e) => updateArrayField('fileProcessors', index, e.target.value)}
                          placeholder="Processor name"
                          style={{ flex: 1 }}
                        />
                        <Button
                          appearance="subtle"
                          onClick={() => removeArrayItem('fileProcessors', index)}
                          aria-label="Remove processor"
                        >
                          ×
                        </Button>
                      </div>
                    ))}
                    {(!formData.fileProcessors || formData.fileProcessors.length === 0) && (
                      <p style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                        No processors added. Click "Add Processor" to add entries.
                      </p>
                    )}
                  </div>
                </Field>
              </>
            )}
          </>
        ) : formData.type === 'acquired' && isDatabaseConnector ? (
          <Field label="SQL Query" required>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
              <Textarea
                value={formData.sqlQuery || ''}
                onChange={(e) => updateFormField('sqlQuery', e.target.value || undefined)}
                placeholder='SELECT * FROM "schema"."table" or use Browse to pick a table'
                rows={6}
                style={{ flex: 1 }}
              />
              {projectId && formData.originConnector && (
                <Button
                  appearance="secondary"
                  icon={<FolderOpen24Regular />}
                  onClick={() => setConnectorExplorerOpen(true)}
                  title="Browse connector to pick a table"
                >
                  Browse
                </Button>
              )}
            </div>
            <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
              SQL query to extract structured data from your database connector. Use Browse to select a table and fill the query.
            </div>
          </Field>
        ) : formData.type === 'acquired' && (formData.resourceSelector || []).some(
          (r) => r && typeof (r as Record<string, unknown>).category === 'string',
        ) ? (
          <div style={{ padding: '16px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '8px' }}>
            <span style={{ display: 'block', marginBottom: '8px', fontWeight: 600, fontSize: '13px' }}>
              Metrics Collection
            </span>
            <span style={{ color: 'var(--colorNeutralForeground3)', fontSize: '12px' }}>
              This dataset will automatically collect the selected metric categories from the connector&#39;s monitoring API on each acquisition run.
              No source path is needed.
              <br /><br />
              <strong>Acquisition modes:</strong> append/incremental are supported. Each run appends a new snapshot of metric samples
              (the watermark drives the time-range query so you do not get duplicates). Overwrite is not supported in v1
              because the downstream Iceberg table currently only appends.
            </span>
          </div>
        ) : formData.kind === 'unstructured' && formData.type === 'acquired' && selectedConnector ? (
          <>
            {/* Path selection for unstructured datasets with connectors */}
            <Field label="Source Path" required>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                <Input
                  value={formData.filterSpec?.sourcePath || ''}
                  onChange={(e) => {
                    updateJsonField('filterSpec', 'sourcePath', e.target.value)
                  }}
                  placeholder={selectedConnector.type === 'objectstore'
                    ? "e.g. my-bucket/folder or use Browse (if available)"
                    : "Enter path (e.g., bucket/path/to/files)"}
                  style={{ flex: 1 }}
                />
                {selectedConnector.type === 'objectstore' && projectId && (
                  <Button
                    appearance="secondary"
                    icon={<FolderOpen24Regular />}
                    onClick={() => {
                      setS3ConnectorPathSelectedNode(null)
                      setS3ConnectorPathExplorerOpen(true)
                    }}
                  >
                    Browse
                  </Button>
                )}
              </div>
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                {selectedConnector.type === 'objectstore'
                  ? 'Type bucket/prefix (e.g. my-bucket/data/) or use Browse to select a path from your S3 connector. Use the filters below to include or exclude by file name/extension.'
                  : 'Enter the path where files are located. All files under this path will be included.'}
              </div>
            </Field>

            {selectedConnector.type === 'objectstore' && (
              <>
                <Field label="File include pattern (optional)">
                  <Input
                    value={formData.acquisitionConfig?.fileGlob ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      updateFormField('acquisitionConfig', {
                        ...formData.acquisitionConfig,
                        fileGlob: v || undefined,
                        fileExcludePattern: formData.acquisitionConfig?.fileExcludePattern,
                      })
                    }}
                    placeholder="e.g. *.csv, *.parquet (comma-separated; leave empty for all files)"
                    style={{ maxWidth: '480px' }}
                  />
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                    Only include files whose names match these glob patterns. Examples: <code>*.csv</code>, <code>*.parquet</code>, <code>*.json,*.jsonl</code>
                  </div>
                </Field>
                <Field label="File exclude pattern (optional)">
                  <Input
                    value={formData.acquisitionConfig?.fileExcludePattern ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      updateFormField('acquisitionConfig', {
                        ...formData.acquisitionConfig,
                        fileGlob: formData.acquisitionConfig?.fileGlob,
                        fileExcludePattern: v || undefined,
                      })
                    }}
                    placeholder="e.g. *.tmp, .DS_Store (comma-separated)"
                    style={{ maxWidth: '480px' }}
                  />
                  <div style={{ marginTop: '4px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                    Exclude files whose names match these glob patterns. Applied after the include filter.
                  </div>
                </Field>
              </>
            )}

            <Field label="File Processors (Optional)">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <Button
                  appearance="secondary"
                  onClick={() => addArrayItem('fileProcessors')}
                  style={{ alignSelf: 'flex-start' }}
                >
                  + Add Processor
                </Button>
                {(formData.fileProcessors || []).map((item, index) => (
                  <div key={index} style={{ display: 'flex', gap: '8px' }}>
                    <Input
                      value={item}
                      onChange={(e) => updateArrayField('fileProcessors', index, e.target.value)}
                      placeholder="Processor name"
                      style={{ flex: 1 }}
                    />
                    <Button
                      appearance="subtle"
                      onClick={() => removeArrayItem('fileProcessors', index)}
                      aria-label="Remove processor"
                    >
                      ×
                    </Button>
                  </div>
                ))}
                {(!formData.fileProcessors || formData.fileProcessors.length === 0) && (
                  <p style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                    No processors added. Click "Add Processor" to add entries.
                  </p>
                )}
              </div>
            </Field>
          </>
        ) : formData.kind === 'unstructured' ? (
          <Field label="File Processors (Optional)">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <Button
                appearance="secondary"
                onClick={() => addArrayItem('fileProcessors')}
                style={{ alignSelf: 'flex-start' }}
              >
                + Add Processor
              </Button>
              {(formData.fileProcessors || []).map((item, index) => (
                <div key={index} style={{ display: 'flex', gap: '8px' }}>
                  <Input
                    value={item}
                    onChange={(e) => updateArrayField('fileProcessors', index, e.target.value)}
                    placeholder="Processor name"
                    style={{ flex: 1 }}
                  />
                  <Button
                    appearance="subtle"
                    onClick={() => removeArrayItem('fileProcessors', index)}
                    aria-label="Remove processor"
                  >
                    ×
                  </Button>
                </div>
              ))}
              {(!formData.fileProcessors || formData.fileProcessors.length === 0) && (
                <p style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                  No processors added. Click "Add Processor" to add entries.
                </p>
              )}
            </div>
          </Field>
        ) : null}

        {s3ConnectorPathExplorerOpen && projectId && formData.originConnector && (
          <ScrollableDialogShell
            open={s3ConnectorPathExplorerOpen}
            onOpenChange={setS3ConnectorPathExplorerOpen}
            title="Select S3 path"
            bodyPadding="flush"
            resizable
            initialWidth="min(1100px, 95vw)"
            initialHeight="min(80vh, 800px)"
            minWidth={640}
            minHeight={480}
            body={
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <p style={{ margin: '12px 16px', fontSize: '13px', color: 'var(--colorNeutralForeground3)' }}>
                  Browse your S3 connector and select a bucket folder or prefix. All files under the selected path will be included in the dataset.
                </p>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <ConnectorExplorer
                    embedded
                    projectId={projectId}
                    connectorId={formData.originConnector}
                    connectorScope={((availableConnectors.find((c) => c.id === formData.originConnector)?.connectorConfig as { scope?: string })?.scope || 'resource') as 'account' | 'resource'}
                    initialAction="listBuckets"
                    onSelectNode={setS3ConnectorPathSelectedNode}
                    selectedNodeId={s3ConnectorPathSelectedNode?.id}
                    style={{ border: 'none', borderRadius: 0 }}
                  />
                </div>
              </div>
            }
            footer={
              s3ConnectorPathSelectedNode ? (
                <div style={{ padding: '8px 12px', backgroundColor: 'var(--colorNeutralBackground3)', borderRadius: '4px', fontSize: '13px' }}>
                  <span style={{ fontWeight: 600 }}>Selected: </span>
                  <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {s3ConnectorPathSelectedNode.id.startsWith('s3://')
                      ? s3ConnectorPathSelectedNode.id.slice(5)
                      : s3ConnectorPathSelectedNode.label}
                  </span>
                </div>
              ) : null
            }
            actions={
              <>
                <Button appearance="secondary" onClick={() => setS3ConnectorPathExplorerOpen(false)}>
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  disabled={!s3ConnectorPathSelectedNode}
                  onClick={() => {
                    if (s3ConnectorPathSelectedNode?.id) {
                      const path = s3ConnectorPathSelectedNode.id.startsWith('s3://')
                        ? s3ConnectorPathSelectedNode.id.slice(5)
                        : s3ConnectorPathSelectedNode.id
                      updateJsonField('filterSpec', 'sourcePath', path)
                    }
                    setS3ConnectorPathExplorerOpen(false)
                    setS3ConnectorPathSelectedNode(null)
                  }}
                >
                  Select path
                </Button>
              </>
            }
          />
        )}

        {s3PathSelectorOpen && projectId && (
          <S3PathSelector
            open={s3PathSelectorOpen}
            onOpenChange={setS3PathSelectorOpen}
            onSelect={(bucket, path) => {
              const fullPath = path ? `${bucket}/${path}` : bucket
              updateJsonField('filterSpec', 'sourcePath', fullPath)
              setS3PathSelectorOpen(false)
            }}
            projectId={projectId}
            initialBucket={formData.filterSpec?.sourcePath?.split('/')[0]}
            initialPath={formData.filterSpec?.sourcePath?.split('/').slice(1).join('/')}
          />
        )}

        {connectorExplorerOpen && projectId && formData.originConnector && (
          <ScrollableDialogShell
            open={connectorExplorerOpen}
            onOpenChange={setConnectorExplorerOpen}
            title="Select table"
            bodyPadding="flush"
            resizable
            initialWidth="min(1100px, 95vw)"
            initialHeight="min(80vh, 800px)"
            minWidth={640}
            minHeight={480}
            body={
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <p style={{ margin: '12px 16px', fontSize: '13px', color: 'var(--colorNeutralForeground3)' }}>
                  Browse databases, schemas and tables, then select a table to use <code>SELECT * FROM &quot;schema&quot;.&quot;table&quot;</code>.
                </p>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                  <ConnectorExplorer
                    embedded
                    projectId={projectId}
                    connectorId={formData.originConnector}
                    connectorScope="resource"
                    initialAction={
                      (() => {
                        const connector = availableConnectors.find((c) => c.id === formData.originConnector)
                        const db = (connector?.connectorConfig as { database?: string })?.database
                        return db ? 'listSchemas' : 'listDatabases'
                      })()
                    }
                    onSelectNode={(node: ExplorerNode) => {
                      const res = node.resource as { database?: string; schema?: string; table?: string } | undefined
                      if ((node.type === 'table' || node.type === 'view') && res?.schema != null && res?.table != null) {
                        const sql =
                          res.database != null
                            ? `-- Database: ${res.database}\nSELECT * FROM "${res.schema}"."${res.table}"`
                            : `SELECT * FROM "${res.schema}"."${res.table}"`
                        updateFormField('sqlQuery', sql)
                        if (res.database != null) updateFormField('sourceDatabase', res.database)
                        if (res.schema != null) updateFormField('sourceSchema', res.schema)
                        setConnectorExplorerOpen(false)
                      }
                    }}
                    style={{ border: 'none', borderRadius: 0 }}
                  />
                </div>
              </div>
            }
            actions={
              <Button appearance="secondary" onClick={() => setConnectorExplorerOpen(false)}>
                Close
              </Button>
            }
          />
        )}

        <Field label="Filter Specification (Optional)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <Button
              appearance="secondary"
              onClick={() => addJsonKey('filterSpec')}
              style={{ alignSelf: 'flex-start' }}
            >
              + Add Filter
            </Button>
            {filterSpecEntries.map((entry) => (
              <div key={entry.id} style={{ display: 'flex', gap: '8px' }}>
                <Input
                  value={entry.key}
                  onChange={(e) => {
                    const oldValue = formData.filterSpec?.[entry.key] || ''
                    const newKey = e.target.value
                    const updated = { ...formData.filterSpec || {} }
                    delete updated[entry.key]
                    updated[newKey] = oldValue
                    updateFormField('filterSpec', updated)
                    // Update the entry's key without changing its ID
                    setFilterSpecEntries(filterSpecEntries.map((e) => 
                      e.id === entry.id ? { ...e, key: newKey } : e
                    ))
                  }}
                  placeholder="Filter key"
                  style={{ flex: 1 }}
                />
                <Input
                  value={formData.filterSpec?.[entry.key] || ''}
                  onChange={(e) => updateJsonField('filterSpec', entry.key, e.target.value)}
                  placeholder="Filter value"
                  style={{ flex: 1 }}
                />
                <Button
                  appearance="subtle"
                  onClick={() => removeJsonKey('filterSpec', entry.id, entry.key)}
                  aria-label="Remove filter"
                >
                  ×
                </Button>
              </div>
            ))}
            {filterSpecEntries.length === 0 && (
              <p style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                No filters added. Click "Add Filter" to add entries.
              </p>
            )}
          </div>
        </Field>

        {formData.kind === 'unstructured' && (
          <div style={{
            padding: '16px',
            backgroundColor: 'var(--colorNeutralBackground2)',
            borderRadius: '8px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}>
            <div>
              <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>PII Analysis</h4>
              <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
                Scan files for personally identifiable information (SSN, addresses, names, etc.) during import.
              </p>
            </div>
            <Tooltip
              relationship="description"
              content="When enabled, each file is scanned for PII using NLP and pattern matching. Results are stored in the dataset metadata table."
            >
              <Checkbox
                checked={formData.enablePiiAnalysis ?? false}
                onChange={(_e, data) => updateFormField('enablePiiAnalysis', data.checked === true)}
                label="Enable PII detection"
              />
            </Tooltip>
            {formData.enablePiiAnalysis && (
              <Tooltip
                relationship="description"
                content="When checked, only image files are analyzed (via OCR). Text files are skipped. Useful for large datasets where only images may contain sensitive data."
              >
                <Checkbox
                  checked={formData.piiAnalysisImageOnly ?? false}
                  onChange={(_e, data) => updateFormField('piiAnalysisImageOnly', data.checked === true)}
                  label="Analyze images only (skip text files)"
                  style={{ marginLeft: '24px' }}
                />
              </Tooltip>
            )}
          </div>
        )}

        <Field label="Schema (Optional)">
          <SchemaBuilder
            value={formData.schema}
            onChange={(schema) => updateFormField('schema', schema)}
          />
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--colorNeutralForeground3)' }}>
            Define the structure of your data by adding fields with their types and constraints. This schema will be associated with the dataset's manifest.
          </div>
        </Field>

        {isEditing && formData.type === 'acquired' && (formData.originConnector || formData.originVolume) && (
          <ScheduleBuilder
            value={formData.scheduleConfig as ScheduleConfig | undefined}
            onChange={(config) => updateFormField('scheduleConfig', config)}
          />
        )}
      </div>
    )
  }

  // Step 4: Review
  if (step === 4) {
    const selectedConnector = availableConnectors.find(
      (connector) => connector.id === formData.originConnector
    )
    const reviewVolume = volumeDataSources.find((v) => v.id === formData.originVolume)

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <div>
          <h3 style={{ marginBottom: '8px' }}>Review & Confirm</h3>
          <p style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '20px' }}>
            Please review your dataset configuration before creating it.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div>
            <h4 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
              Basic Information
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>Name:</span>
                <span style={{ fontWeight: 500 }}>{formData.name}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>Description:</span>
                <span style={{ fontWeight: 500 }}>{formData.description}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>Type:</span>
                <span style={{ fontWeight: 500 }}>{formData.type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>Kind:</span>
                <span style={{ fontWeight: 500 }}>{formData.kind}</span>
              </div>
            </div>
          </div>

          <div>
            <h4 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
              Data Source
            </h4>
            {formData.type === 'acquired' ? (
              reviewVolume ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--colorNeutralForeground3)' }}>Volume:</span>
                    <span style={{ fontWeight: 500 }}>{reviewVolume.name}</span>
                  </div>
                  {formData.filterSpec?.sourcePath && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--colorNeutralForeground3)' }}>Source Path:</span>
                      <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{formData.filterSpec.sourcePath}</span>
                    </div>
                  )}
                  {formData.acquisitionConfig?.writeMode && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--colorNeutralForeground3)' }}>Write Mode:</span>
                      <span style={{ fontWeight: 500 }}>{formData.acquisitionConfig.writeMode}</span>
                    </div>
                  )}
                  {formData.acquisitionConfig?.fileGlob && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--colorNeutralForeground3)' }}>Include Pattern:</span>
                      <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{formData.acquisitionConfig.fileGlob}</span>
                    </div>
                  )}
                  {formData.acquisitionConfig?.fileExcludePattern && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: 'var(--colorNeutralForeground3)' }}>Exclude Pattern:</span>
                      <span style={{ fontWeight: 500, fontFamily: 'monospace' }}>{formData.acquisitionConfig.fileExcludePattern}</span>
                    </div>
                  )}
                  <div style={{
                    marginTop: '4px',
                    padding: '8px 12px',
                    backgroundColor: 'var(--colorNeutralBackground2)',
                    borderRadius: '4px',
                    fontSize: '12px',
                    color: 'var(--colorNeutralForeground3)',
                  }}>
                    Zero-copy: files are read directly from the mounted volume.
                  </div>
                </div>
              ) : selectedConnector ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--colorNeutralForeground3)' }}>Connector:</span>
                    <span style={{ fontWeight: 500 }}>{selectedConnector.name}</span>
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--colorNeutralForeground3)' }}>No connector or volume selected</p>
              )
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--colorNeutralForeground3)' }}>Files:</span>
                  <span style={{ fontWeight: 500 }}>
                    {isEditing 
                      ? `${(existingFiles?.filter(f => !filesToDelete?.has(f.id)).length || 0) + uploadedFiles.length} file(s)`
                      : `${uploadedFiles.length} file(s)`
                    }
                  </span>
                </div>
                {isEditing && existingFiles && existingFiles.length > 0 && (
                  <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginTop: '4px' }}>
                    {existingFiles.filter(f => !filesToDelete?.has(f.id)).length} existing, {uploadedFiles.length} new
                  </div>
                )}
                {uploadedFiles.length > 0 && (
                  <div style={{ marginTop: '12px' }}>
                    <div
                      style={{
                        fontSize: '12px',
                        fontWeight: 600,
                        marginBottom: '6px',
                        color: 'var(--colorNeutralForeground2)',
                      }}
                    >
                      Files to upload
                    </div>
                    <UploadFileLogPanel
                      files={uploadedFiles}
                      uploadProgress={uploadProgress}
                      uploadErrors={uploadErrors}
                      compact
                      showOverallProgress={
                        submitting && formData.type === 'manual' && uploadedFiles.length > 0
                      }
                      parallelUploadLimit={uploadConcurrency}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <h4 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
              Storage
            </h4>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--colorNeutralForeground3)' }}>Location:</span>
              <span style={{ fontWeight: 500 }}>Project storage</span>
            </div>
          </div>

          <div>
            <h4 style={{ marginBottom: '12px', fontSize: '16px', fontWeight: 600 }}>
              Configuration
            </h4>
            {(() => {
              const selectedConnector = availableConnectors.find(
                (connector) => connector.id === formData.originConnector
              )
              const isDatabaseConnector = selectedConnector?.type === 'database'

              if (formData.type === 'acquired' && isDatabaseConnector && formData.sqlQuery) {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <span style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '4px' }}>
                      SQL Query:
                    </span>
                    <pre
                      style={{
                        padding: '12px',
                        backgroundColor: 'var(--colorNeutralBackground2)',
                        borderRadius: '4px',
                        fontSize: '12px',
                        overflow: 'auto',
                      }}
                    >
                      {formData.sqlQuery}
                    </pre>
                  </div>
                )
              } else if (formData.kind === 'unstructured' && formData.fileProcessors) {
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--colorNeutralForeground3)' }}>File Processors:</span>
                    <span style={{ fontWeight: 500 }}>
                      {formData.fileProcessors.length > 0
                        ? formData.fileProcessors.join(', ')
                        : 'None'}
                    </span>
                  </div>
                )
              } else {
                return (
                  <p style={{ color: 'var(--colorNeutralForeground3)', fontStyle: 'italic' }}>
                    No configuration specified
                  </p>
                )
              }
            })()}
            {formData.kind === 'unstructured' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)' }}>PII Analysis:</span>
                <span style={{ fontWeight: 500 }}>
                  {formData.enablePiiAnalysis
                    ? formData.piiAnalysisImageOnly
                      ? 'Enabled (images only)'
                      : 'Enabled'
                    : 'Disabled'}
                </span>
              </div>
            )}
            {formData.filterSpec && Object.keys(formData.filterSpec).length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '8px', display: 'block' }}>
                  Filters:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {Object.entries(formData.filterSpec).map(([key, value]) => (
                    <div key={key} style={{ fontSize: '14px' }}>
                      <strong>{key}:</strong> {String(value)}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {formData.schema && formData.schema.properties && Object.keys(formData.schema.properties).length > 0 && (
              <div style={{ marginTop: '12px' }}>
                <span style={{ color: 'var(--colorNeutralForeground3)', marginBottom: '8px', display: 'block' }}>
                  Schema Fields:
                </span>
                <div style={{ padding: '12px', backgroundColor: 'var(--colorNeutralBackground2)', borderRadius: '4px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {Object.entries(formData.schema.properties).map(([fieldName, fieldSchema]: [string, any]) => (
                      <div key={fieldName} style={{ fontSize: '14px', padding: '8px', backgroundColor: 'var(--colorNeutralBackground1)', borderRadius: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <strong>{fieldName}</strong>
                          <span style={{ color: 'var(--colorNeutralForeground3)' }}>({fieldSchema.type || 'string'})</span>
                          {formData.schema?.required?.includes(fieldName) && (
                            <span style={{ color: 'var(--colorPaletteRedForeground1)', fontSize: '12px' }}>• required</span>
                          )}
                        </div>
                        {fieldSchema.description && (
                          <div style={{ fontSize: '12px', color: 'var(--colorNeutralForeground3)', marginTop: '4px' }}>
                            {fieldSchema.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return null
}

