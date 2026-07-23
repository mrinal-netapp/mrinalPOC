import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Badge,
  Tooltip,
  ProgressBar,
} from '@fluentui/react-components'
import { Add24Regular, Edit24Regular, Delete24Regular, Document24Regular, Table24Regular, Search24Regular, ErrorCircle24Regular, ArrowClockwise24Regular, ShieldCheckmark24Regular, Play24Regular, CalendarClock24Regular } from '@fluentui/react-icons'
import {
  datasetApi,
  datasourceApi,
  s3Api,
  projectApi,
  acquisitionApi,
  explorerApi,
  DataSet,
  Connector,
  CreateDataSetRequest,
  DataSetFile,
  searchApi,
  manifestApi,
  DataSourceItem,
  DependentsPage,
  ProviderCatalogEntry,
  getApiErrorMessage,
  getDependentsFromError,
} from '../services/api'
import {
  clearManualUploadResume,
  clearAllManualUploadResumeForProject,
  loadManualUploadResume,
  saveManualUploadResumeEntry,
} from '../utils/manualDatasetUploadResume'
import { parseProjectStorageRoot } from '../utils/projectStorage'
import { DependentsCell, DependentsBlockerList } from '../components/DependentsCell'
import { Input } from '@fluentui/react-components'
import { WizardModal } from '../components/wizard/WizardModal'
import { DataSetWizard } from '../components/wizard/DataSetWizard'
import { useToast } from '../contexts/ToastContext'
import { Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions } from '@fluentui/react-components'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  statusBadge: {
    fontSize: tokens.fontSizeBase200,
  },
})

const statusColors: Record<string, 'success' | 'warning' | 'danger' | 'brand'> = {
  ready: 'success',
  in_progress: 'warning',
  errored: 'danger',
  deprecated: 'brand',
}

/** Get the upload-relative path for a File: relative path from directory upload, or name for individual files */
function getFileRelativePath(file: File): string {
  return (file as any).webkitRelativePath || file.name
}

/** Replace spaces/special chars in each path segment with "_" for S3 upload keys. */
function sanitizeUploadRelativePath(relativePath: string): string {
  return relativePath
    .split('/')
    .filter(segment => segment.length > 0)
    .map(segment => {
      const sanitized = segment.replace(/[^A-Za-z0-9._-]/g, '_')
      return sanitized || 'file'
    })
    .join('/')
}

/** Parallel browser uploads for manual datasets (limits concurrent connections; order is preserved in results). */
const MANUAL_UPLOAD_CONCURRENCY = 4

/** Register uploaded S3 objects on the draft manifest; chunk manifest API calls to stay under JSON/proxy limits. */
const MANIFEST_SOURCE_URI_CHUNK = 800

async function registerManualUploadManifestFiles(
  projectId: string,
  datasetId: string,
  allFiles: Array<{ key: string; url: string; size?: number; originalName?: string }>
): Promise<void> {
  if (allFiles.length === 0) {
    await datasetApi.update(projectId, datasetId, { uploadedFiles: [] })
    return
  }
  if (allFiles.length <= MANIFEST_SOURCE_URI_CHUNK) {
    await datasetApi.update(projectId, datasetId, { uploadedFiles: allFiles })
    return
  }
  const allUris = allFiles.map((f) => f.url)
  const manifests = await manifestApi.list(projectId, datasetId)
  let draft = manifests.find((m) => m.status === 'draft')
  if (!draft) {
    draft = await manifestApi.create(projectId, datasetId, { uris: [] })
  }
  for (let i = 0; i < allUris.length; i += MANIFEST_SOURCE_URI_CHUNK) {
    const chunk = allUris.slice(i, i + MANIFEST_SOURCE_URI_CHUNK)
    if (i === 0) {
      await manifestApi.setSourceUris(projectId, datasetId, draft.id, chunk)
    } else {
      await manifestApi.appendSourceUris(projectId, datasetId, draft.id, chunk)
    }
  }
}

async function runWithConcurrency(
  taskCount: number,
  concurrency: number,
  runIndex: (index: number) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (taskCount <= 0) return
  const workers = Math.min(Math.max(1, concurrency), taskCount)
  let next = 0
  const worker = async () => {
    while (true) {
      if (signal?.aborted) return
      const i = next++
      if (i >= taskCount) return
      await runIndex(i)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

export default function ProjectDatasets() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const { showToast } = useToast()
  
  const [datasets, setDatasets] = useState<DataSet[]>([])
  const [filteredDatasets, setFilteredDatasets] = useState<DataSet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editingDataSetId, setEditingDataSetId] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [datasetToDelete, setDatasetToDelete] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteBlockers, setDeleteBlockers] = useState<DependentsPage | null>(null)
  const [wizardStep, setWizardStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitHint, setSubmitHint] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [availableConnectors, setAvailableConnectors] = useState<Connector[]>([])
  const [volumeDataSources, setVolumeDataSources] = useState<DataSourceItem[]>([])
  const [providerCatalog, setProviderCatalog] = useState<Record<string, ProviderCatalogEntry>>({})
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({})
  const [uploadErrors, setUploadErrors] = useState<Record<string, string>>({})
  const [existingFiles, setExistingFiles] = useState<DataSetFile[]>([])
  const [originalExistingFiles, setOriginalExistingFiles] = useState<DataSetFile[]>([]) // Store original files to restore on cancel
  const [filesToDelete, setFilesToDelete] = useState<Set<string>>(new Set())
  const [createdDatasetId, setCreatedDatasetId] = useState<string | null>(null) // Track dataset created during wizard flow for cleanup
  const [uploadPhaseActive, setUploadPhaseActive] = useState(false)
  const uploadAbortControllerRef = useRef<AbortController | null>(null)
  const [acquiringIds, setAcquiringIds] = useState<Set<string>>(new Set())
  const [formData, setFormData] = useState<CreateDataSetRequest>({
    name: '',
    description: '',
    type: 'acquired',
    kind: 'unstructured',
    originConnector: undefined,
    originVolume: undefined,
    filterSpec: undefined,
    fileProcessors: undefined,
    sqlQuery: undefined,
    sourceDatabase: undefined,
    sourceSchema: undefined,
    uploadedFiles: undefined,
    schema: undefined,
    resourceSelector: undefined,
    enablePiiAnalysis: false,
    piiAnalysisImageOnly: false,
    acquisitionConfig: undefined,
  })

  const loadDatasets = async (silent = false) => {
    if (!projectId) return
    try {
      if (!silent) setLoading(true)
      setError(null)
      const data = await datasetApi.list(projectId)
      setDatasets(data)
      setFilteredDatasets(data)
    } catch (err: any) {
      if (!silent) {
        setError(err.message || 'Failed to load datasets')
        console.error('Failed to load datasets:', err)
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadDatasets()
  }, [projectId])

  // Poll when any dataset or facet is in_progress so progress updates are shown
  useEffect(() => {
    const hasInProgress = datasets.some(
      ds => ds.status === 'in_progress' || ds.facets?.some(f => f.state === 'in_progress')
    )
    if (!hasInProgress) return

    const interval = setInterval(() => {
      loadDatasets(true)
    }, 5000)

    return () => clearInterval(interval)
  }, [datasets])

  // Handle search using search API
  useEffect(() => {
    if (!projectId) return

    const performSearch = async () => {
      if (!searchQuery.trim()) {
        setFilteredDatasets(datasets)
        return
      }

      try {
        setSearching(true)
        const results = await searchApi.search<DataSet>({
          entityType: 'datasets',
          nameRegex: searchQuery,
          fields: { projectId: projectId },
          limit: 100,
        })
        setFilteredDatasets(results)
      } catch (err: any) {
        console.error('Search failed, falling back to client-side filter:', err)
        // Fallback to client-side filtering
        const query = searchQuery.toLowerCase()
        setFilteredDatasets(
          datasets.filter(
            (dataset) =>
              dataset.name.toLowerCase().includes(query) ||
              dataset.description?.toLowerCase().includes(query) ||
              dataset.id.toLowerCase().includes(query)
          )
        )
      } finally {
        setSearching(false)
      }
    }

    const timeoutId = setTimeout(performSearch, 300) // Debounce search
    return () => clearTimeout(timeoutId)
  }, [searchQuery, projectId, datasets])

  // Load connectors (from datasource API)
  const loadVolumeDataSources = useCallback(async () => {
    if (!projectId) return
    try {
      const vols = await datasourceApi.list(projectId, { type: 'volume' })
      setVolumeDataSources(vols)
    } catch (err: any) {
      console.error('Failed to load volume data sources:', err)
      setVolumeDataSources([])
    }
  }, [projectId])

  const loadConnectors = useCallback(async () => {
    if (!projectId) return
    try {
      const dataSources = await datasourceApi.list(projectId, { type: 'connector' })
      // Map DataSourceItem to Connector interface for backward compatibility
      const mapped: Connector[] = dataSources.map((ds: DataSourceItem) => ({
        id: ds.id,
        name: ds.name,
        description: ds.description || '',
        type: ds.connector_config?.connector_type || 'database',
        connectorConfig: ds.connector_config,
        createdAt: ds.created_at,
        updatedAt: ds.updated_at,
      }))
      setAvailableConnectors(mapped)
    } catch (err: any) {
      console.error('Failed to load connectors:', err)
    }
  }, [projectId])

  useEffect(() => {
    loadConnectors()
    loadVolumeDataSources()
  }, [loadConnectors, loadVolumeDataSources])

  useEffect(() => {
    explorerApi.getProviders().then(({ providers }) => {
      const map: Record<string, ProviderCatalogEntry> = {}
      for (const p of providers) map[p.id] = p
      setProviderCatalog(map)
    }).catch((err) => console.error('Failed to load provider catalog:', err))
  }, [])

  const handleDeleteClick = (id: string, name: string) => {
    setDatasetToDelete({ id, name })
    setDeleteBlockers(null)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !datasetToDelete) return

    try {
      setDeleting(true)
      setError(null)
      await datasetApi.delete(projectId, datasetToDelete.id)
      await loadDatasets()
      setDeleteDialogOpen(false)
      setDatasetToDelete(null)
      setDeleteBlockers(null)
      showToast(`Dataset "${datasetToDelete.name}" deleted successfully`, 'success')
    } catch (err: unknown) {
      const msg = getApiErrorMessage(err, 'Failed to delete dataset')
      const blockers = getDependentsFromError(err)
      setError(msg)
      if (blockers) {
        // Keep the dialog open so the user can see what's blocking the delete.
        setDeleteBlockers(blockers)
        showToast(msg, 'warning')
      } else {
        showToast(msg, 'error')
      }
    } finally {
      setDeleting(false)
    }
  }


  // Reset form
  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      type: 'acquired',
      kind: 'unstructured',
      originConnector: undefined,
      originVolume: undefined,
      filterSpec: undefined,
      fileProcessors: undefined,
      sqlQuery: undefined,
      sourceDatabase: undefined,
      sourceSchema: undefined,
      uploadedFiles: undefined,
      schema: undefined,
      enablePiiAnalysis: false,
      piiAnalysisImageOnly: false,
      acquisitionConfig: undefined,
    })
    setUploadedFiles([])
    setUploadProgress({})
    setUploadErrors({})
    // Restore original files if editing was cancelled
    setExistingFiles(originalExistingFiles)
    setOriginalExistingFiles([])
    setFilesToDelete(new Set())
    setFormError(null)
    setWizardStep(1)
    setEditingDataSetId(null)
    setCreatedDatasetId(null) // Clear created dataset tracking
    if (projectId) {
      clearAllManualUploadResumeForProject(projectId)
    }
  }

  // Cleanup dataset if creation failed or wizard was cancelled
  const cleanupCreatedDataset = async (datasetId: string | null) => {
    if (!datasetId || !projectId) return
    
    try {
      console.log(`[Dataset Cleanup] Cleaning up dataset ${datasetId} due to wizard cancellation or error`)
      await datasetApi.delete(projectId, datasetId)
      console.log(`[Dataset Cleanup] Successfully deleted dataset ${datasetId}`)
    } catch (err: any) {
      // Log error but don't throw - cleanup failure shouldn't block UI
      console.error(`[Dataset Cleanup] Failed to delete dataset ${datasetId}:`, err)
    }
  }

  // Load dataset for editing
  const handleEdit = async (id: string) => {
    if (!projectId) return
    
    try {
      setError(null)
      const dataset = await datasetApi.get(projectId, id)
      
      // Populate form with dataset data
      setFormData({
        name: dataset.name,
        description: dataset.description,
        type: dataset.type,
        kind: dataset.kind,
        originConnector: dataset.originConnector,
        originVolume: dataset.originVolume,
        filterSpec: dataset.filterSpec,
        fileProcessors: dataset.fileProcessors,
        sqlQuery: dataset.sqlQuery,
        sourceDatabase: dataset.sourceDatabase,
        sourceSchema: dataset.sourceSchema,
        uploadedFiles: undefined, // Files are not returned from API
        schema: dataset.manifest?.schema,
        resourceSelector: dataset.resourceSelector,
        enablePiiAnalysis: dataset.enablePiiAnalysis ?? false,
        piiAnalysisImageOnly: dataset.piiAnalysisImageOnly ?? false,
        acquisitionConfig: dataset.acquisitionConfig,
      })
      
      // Load existing files if this is a manual dataset
      if (dataset.type === 'manual') {
        // Use files from response (converted from manifest)
        if (dataset.files) {
          setExistingFiles(dataset.files)
          setOriginalExistingFiles(dataset.files) // Store original to restore on cancel
        } else {
          setExistingFiles([])
          setOriginalExistingFiles([])
        }
      } else {
        setExistingFiles([])
        setOriginalExistingFiles([])
      }
      
      setEditingDataSetId(id)
      setFilesToDelete(new Set())
      setWizardStep(1)
      setShowCreateModal(true)
    } catch (err: any) {
      setError(err.message || 'Failed to load dataset')
      console.error('Failed to load dataset:', err)
    }
  }

  // Handle deleting an existing file
  // Note: This only marks the file for removal from the manifest - the file remains in S3
  // A new manifest will be created with the updated file list when the user clicks Update
  const handleDeleteExistingFile = (fileId: string) => {
    if (!editingDataSetId) return
    
    const file = existingFiles.find(f => f.id === fileId)
    if (!file) return
    
    if (!confirm(`Are you sure you want to remove "${file.originalName || file.fileKey.split('/').pop()}" from this dataset? The file will remain in S3 storage.`)) {
      return
    }
    
    // Mark for removal from manifest (file stays in S3, only manifest is updated)
    setFilesToDelete(prev => new Set(prev).add(fileId))
    
    // Remove from UI (will be restored if user cancels)
    setExistingFiles(prev => prev.filter(f => f.id !== fileId))
  }

  // Wizard navigation
  const nextStep = () => {
    if (wizardStep === 1) {
      if (!formData.name || !formData.name.trim()) {
        setFormError('Name is required')
        return
      }
      const trimmedName = formData.name.trim()
      const nameExists = datasets.some(
        (d) =>
          d.name === trimmedName &&
          d.id !== editingDataSetId &&
          d.id !== createdDatasetId
      )
      if (nameExists) {
        setFormError('A dataset with this name already exists in this project')
        return
      }
    } else if (wizardStep === 2) {
      if (formData.type === 'acquired') {
        const hasConnector = Boolean(formData.originConnector?.trim())
        const hasVolume = Boolean(formData.originVolume?.trim())
        if (!hasConnector && !hasVolume) {
          setFormError('Select a connector or a mounted volume for acquired datasets')
          return
        }
      } else if (formData.type === 'manual') {
        // For manual datasets, require files unless editing and files already exist
        const hasExistingFiles = editingDataSetId && existingFiles.length > 0
        const hasNewFiles = uploadedFiles && uploadedFiles.length > 0
        
        if (!hasExistingFiles && !hasNewFiles) {
          setFormError('Please upload at least one file for manual datasets')
          return
        }
        
        // Bucket is now derived from project home_dir; no need to validate selection
        
        // Validate for duplicate file paths (check both new files and existing files)
        // Uses relative path (from directory uploads) or file name for individual files
        if (hasNewFiles) {
          const filePaths = uploadedFiles.map(f => getFileRelativePath(f))
          const filePathCounts = new Map<string, number>()
          
          // Count occurrences of each file path
          filePaths.forEach(path => {
            filePathCounts.set(path, (filePathCounts.get(path) || 0) + 1)
          })
          
          // Check for duplicates within new files
          const duplicates: string[] = []
          filePathCounts.forEach((count, path) => {
            if (count > 1) {
              duplicates.push(path)
            }
          })
          
          // Check for conflicts with existing files (compare by key path, not basename)
          if (hasExistingFiles) {
            const existingFilePaths = new Set(existingFiles.map(f => f.originalName || f.fileKey.split('/').pop() || ''))
            filePaths.forEach(path => {
              if (existingFilePaths.has(path)) {
                duplicates.push(path)
              }
            })
          }
          
          if (duplicates.length > 0) {
            const uniqueDuplicates = [...new Set(duplicates)]
            setFormError(
              `Duplicate file paths detected: ${uniqueDuplicates.join(', ')}. ` +
              `Files with the same path will overwrite each other in S3. ` +
              `Please rename the files or use different directories.`
            )
            return
          }
        }
      }
    } else if (wizardStep === 3) {
      // Check if SQL query is required (only for database connectors)
      if (formData.type === 'acquired' && formData.originConnector && !formData.originVolume) {
        const selectedConnector = availableConnectors.find(
          (connector) => connector.id === formData.originConnector
        )
        if (selectedConnector?.type === 'database' && (!formData.sqlQuery || !formData.sqlQuery.trim())) {
          setFormError('SQL Query is required for database connectors')
          return
        }
        const cfg = selectedConnector?.connectorConfig as { provider?: string } | undefined
        const needsGcsSource =
          formData.kind === 'unstructured'
          && selectedConnector?.type === 'cloud'
          && cfg?.provider === 'gcp'
        if (needsGcsSource) {
          const rs = formData.resourceSelector
          const hasBucket =
            Array.isArray(rs)
            && rs.some(
              (r: unknown) =>
                r
                && typeof r === 'object'
                && typeof (r as { bucket?: string }).bucket === 'string'
                && (r as { bucket: string }).bucket.trim() !== '',
            )
          if (!hasBucket) {
            setFormError('Select a Cloud Storage bucket, folder, or object in the explorer')
            return
          }
        }
      }
    }
    setFormError(null)
    setWizardStep((prev) => Math.min(prev + 1, 4))
  }

  const prevStep = () => {
    setFormError(null)
    setWizardStep((prev) => Math.max(prev - 1, 1))
  }

  // Update form field
  const updateFormField = (field: keyof CreateDataSetRequest, value: any) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  // Update array fields
  const updateArrayField = (field: 'fileProcessors', index: number, value: string) => {
    setFormData((prev) => {
      const current = prev[field] || []
      const updated = [...current]
      updated[index] = value
      return { ...prev, [field]: updated }
    })
  }

  const addArrayItem = (field: 'fileProcessors') => {
    setFormData((prev) => {
      const current = prev[field] || []
      return { ...prev, [field]: [...current, ''] }
    })
  }

  const removeArrayItem = (field: 'fileProcessors', index: number) => {
    setFormData((prev) => {
      const current = prev[field] || []
      const updated = current.filter((_, i) => i !== index)
      return { ...prev, [field]: updated }
    })
  }

  // Update JSON fields
  const updateJsonField = (field: 'filterSpec', key: string, value: string) => {
    setFormData((prev) => {
      const current = prev[field] || {}
      const updated = { ...current, [key]: value }
      return { ...prev, [field]: updated }
    })
  }

  const handleAbortUpload = useCallback(() => {
    uploadAbortControllerRef.current?.abort()
    setUploadPhaseActive(false)
    setSubmitting(false)
    setFormError('Upload cancelled. Successfully uploaded files have been saved. Click Retry to resume remaining files.')
  }, [])

  // Handle create or update
  const handleSubmit = async () => {
    if (!projectId) return

    try {
      setSubmitting(true)
      setSubmitHint(null)
      setFormError(null)
      setUploadErrors({})

      // Create dataset first to get the ID (needed for file paths)
      let createdDataset: DataSet | undefined
      const submitDataWithoutFiles: CreateDataSetRequest = {
        name: formData.name,
        description: formData.description,
        type: formData.type,
        kind: formData.kind,
        originConnector: formData.originConnector,
        originVolume: formData.originVolume,
        filterSpec: formData.filterSpec,
        fileProcessors: formData.fileProcessors,
        sqlQuery: formData.sqlQuery,
        sourceDatabase: formData.sourceDatabase,
        sourceSchema: formData.sourceSchema,
        resourceSelector: formData.resourceSelector,
        uploadedFiles: undefined, // Will be updated after file uploads
        enablePiiAnalysis: formData.enablePiiAnalysis,
        piiAnalysisImageOnly: formData.piiAnalysisImageOnly,
        acquisitionConfig: formData.acquisitionConfig,
      }

      if (editingDataSetId) {
        // Update existing dataset (files handled separately if needed)
        await datasetApi.update(projectId, editingDataSetId, submitDataWithoutFiles)
        createdDataset = await datasetApi.get(projectId, editingDataSetId)
      } else if (createdDatasetId) {
        // Resume: row was created on a prior submit; sync metadata then continue uploads.
        // Only fall back to POST when the row is gone (404). Any other error (timeout, 5xx,
        // rename duplicate 409) must not clear createdDatasetId — otherwise we POST again and
        // hit checkDuplicateName on the still-existing row.
        try {
          await datasetApi.update(projectId, createdDatasetId, submitDataWithoutFiles)
          createdDataset = await datasetApi.get(projectId, createdDatasetId)
        } catch (err: unknown) {
          const status = (err as { response?: { status?: number } })?.response?.status
          if (status === 404) {
            setCreatedDatasetId(null)
            createdDataset = await datasetApi.create(projectId, submitDataWithoutFiles)
            if (createdDataset?.id) {
              setCreatedDatasetId(createdDataset.id)
            }
          } else {
            throw err
          }
        }
      } else {
        // Create new dataset first to get ID (needed for S3 paths)
        createdDataset = await datasetApi.create(projectId, submitDataWithoutFiles)
        // Track created dataset ID for cleanup on explicit cancel (onClose) and for resume-on-retry
        if (createdDataset?.id) {
          setCreatedDatasetId(createdDataset.id)
        }
      }

      const uploadedFileKeys: Array<{ key: string; url: string; size?: number; originalName?: string }> = []

      // Manual uploads: resolve bucket + path prefix from project home_dir (same source as config-service).
      let bucketForUploads: string | undefined
      let pathPrefix = ''
      if (uploadedFiles.length > 0 && createdDataset) {
        try {
          const project = await projectApi.get(projectId)
          const root = parseProjectStorageRoot(project?.home_dir)
          if (root) {
            bucketForUploads = root.bucketName
            pathPrefix = root.pathPrefix
          }
        } catch (err) {
          console.warn('Failed to fetch project for storage root:', err)
        }
        if (!bucketForUploads) {
          setFormError(
            'Could not determine project storage from the project home directory. Check project settings and try again.',
          )
          return
        }
      }

      // Upload new files if any
      if (uploadedFiles.length > 0 && bucketForUploads && createdDataset) {
        // Validate for duplicate file paths BEFORE uploading to S3
        // Uses relative path (from directory uploads) or file name for individual files
        const filePaths = uploadedFiles.map(f => sanitizeUploadRelativePath(getFileRelativePath(f)))
        const filePathCounts = new Map<string, number>()
        filePaths.forEach(path => {
          filePathCounts.set(path, (filePathCounts.get(path) || 0) + 1)
        })
        
        const duplicates: string[] = []
        filePathCounts.forEach((count, path) => {
          if (count > 1) {
            duplicates.push(path)
          }
        })
        
        // Also check for conflicts with existing files if editing
        if (editingDataSetId && existingFiles.length > 0) {
          const existingFilePaths = new Set(existingFiles.map(f => f.originalName || f.fileKey.split('/').pop() || ''))
          filePaths.forEach(path => {
            if (existingFilePaths.has(path)) {
              duplicates.push(path)
            }
          })
        }
        
        if (duplicates.length > 0) {
          const uniqueDuplicates = [...new Set(duplicates)]
          setFormError(
            `Duplicate upload paths detected after filename normalization: ${uniqueDuplicates.join(', ')}. ` +
            `Files with the same normalized path will overwrite each other in S3. ` +
            `Please rename the files or use different directories.`
          )
          return
        }

        // Upload files with bounded parallelism (see MANUAL_UPLOAD_CONCURRENCY)
        // Include pathPrefix so files land at: <pathPrefix>/datasets/<dset_id>/data_files/<filename>
        const filePath = pathPrefix
          ? `${pathPrefix}/datasets/${createdDataset.id}/data_files`
          : `datasets/${createdDataset.id}/data_files`
        const uploadErrorsLocal: Record<string, string> = {}

        const resumeMap =
          projectId && createdDataset.id
            ? loadManualUploadResume(projectId, createdDataset.id)
            : {}

        // Create AbortController for this upload session
        const ac = new AbortController()
        uploadAbortControllerRef.current = ac
        setUploadPhaseActive(true)

        type UploadedEntry = { key: string; url: string; size?: number; originalName?: string }
        const uploadedByIndex: (UploadedEntry | undefined)[] = new Array(uploadedFiles.length)

        const uploadOne = async (index: number) => {
          if (ac.signal.aborted) return

          const file = uploadedFiles[index]
          const relativePath = getFileRelativePath(file)
          const sanitizedRelativePath = sanitizeUploadRelativePath(relativePath)
          const fileId = `${relativePath}-${file.size}-${index}`
          const s3Key = `${filePath}/${sanitizedRelativePath}`

          try {
            if (projectId && createdDataset.id) {
              const cached = resumeMap[fileId]
              if (cached && cached.key === s3Key) {
                uploadedByIndex[index] = cached
                setUploadProgress((prev) => ({ ...prev, [fileId]: 100 }))
                setUploadErrors((prev) => {
                  const next = { ...prev }
                  delete next[fileId]
                  return next
                })
                return
              }
            }

            setUploadProgress((prev) => ({ ...prev, [fileId]: 0 }))

            await s3Api.putObjectAdaptive(
              bucketForUploads,
              s3Key,
              file,
              projectId,
              (uploaded: number, total: number) => {
                const progress = total > 0 ? Math.round((uploaded / total) * 100) : 0
                setUploadProgress((prev) => ({ ...prev, [fileId]: progress }))
              },
              ac.signal
            )

            setUploadProgress((prev) => ({ ...prev, [fileId]: 100 }))

            const entry: UploadedEntry = {
              key: s3Key,
              url: `s3://${bucketForUploads}/${s3Key}`,
              size: file.size,
              originalName: relativePath,
            }
            uploadedByIndex[index] = entry

            if (projectId && createdDataset.id) {
              saveManualUploadResumeEntry(projectId, createdDataset.id, fileId, entry)
            }

            setUploadErrors((prev) => {
              const next = { ...prev }
              delete next[fileId]
              return next
            })
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === 'AbortError') {
              setUploadErrors((prev) => ({ ...prev, [fileId]: 'Cancelled' }))
              return
            }
            const errorMessage = err instanceof Error ? err.message : 'Failed to upload file'
            uploadErrorsLocal[fileId] = errorMessage
            setUploadErrors((prev) => ({ ...prev, [fileId]: errorMessage }))
          }
        }

        await runWithConcurrency(uploadedFiles.length, MANUAL_UPLOAD_CONCURRENCY, uploadOne, ac.signal)
        setUploadPhaseActive(false)
        uploadAbortControllerRef.current = null

        // If user aborted, stop here but keep the dataset for retry
        if (ac.signal.aborted) {
          setFormError('Upload cancelled. Successfully uploaded files have been saved. Click Retry to resume remaining files.')
          setSubmitting(false)
          return
        }

        for (let i = 0; i < uploadedByIndex.length; i++) {
          const entry = uploadedByIndex[i]
          if (entry) {
            uploadedFileKeys.push(entry)
          }
        }

        // Check if any uploads failed
        if (Object.keys(uploadErrorsLocal).length > 0) {
          setFormError(`Failed to upload ${Object.keys(uploadErrorsLocal).length} file(s). Your progress has been saved — click Retry to resume.`)
          setSubmitting(false)
          return
        }

        setSubmitHint(
          'Saving file list to the server and finalizing the dataset. This step can take several minutes for many files.'
        )

        // Update dataset with file information (combining existing and new files)
        // Note: Files are NOT deleted from S3 - only a new manifest is created with the updated file list
        if (createdDataset) {
          // Get current files (excluding removed ones) and add new ones
          // Files marked for deletion are excluded from the new manifest but remain in S3
          const remainingFiles = originalExistingFiles
            .filter(f => !filesToDelete.has(f.id))
            .map(f => ({ 
              key: f.fileKey, 
              url: f.fileUrl,
              size: f.size,
              originalName: f.originalName,
            }))
          
          const allFiles = [...remainingFiles, ...uploadedFileKeys]
          
          // Only update if there are file changes
          // This will create a new manifest with the updated file list
          if (uploadedFileKeys.length > 0 || filesToDelete.size > 0) {
            await registerManualUploadManifestFiles(projectId, createdDataset.id, allFiles)
          }

          // Update manifest schema if provided
          if (formData.schema !== undefined) {
            try {
              // Get the latest manifest (draft or committed)
              const manifests = await manifestApi.list(projectId, createdDataset.id)
              const latestManifest = manifests.length > 0 
                ? manifests.sort((a, b) => b.manifestId - a.manifestId)[0]
                : null
              
              if (latestManifest) {
                await manifestApi.updateSchema(
                  projectId,
                  createdDataset.id,
                  latestManifest.id,
                  formData.schema || undefined
                )
              }
            } catch (err: any) {
              // Log error but don't fail the entire operation
              console.warn('Failed to update manifest schema:', err)
            }
          }
        }
      } else if (editingDataSetId && (filesToDelete.size > 0 || uploadedFileKeys.length > 0)) {
        // Note: Files are NOT deleted from S3 - only a new manifest is created with the updated file list
        // Files marked for deletion are excluded from the new manifest but remain in S3 storage
        
        // Get remaining files (excluding removed ones) and add new ones
        const remainingFiles = originalExistingFiles
          .filter(f => !filesToDelete.has(f.id))
          .map(f => ({ 
            key: f.fileKey, 
            url: f.fileUrl,
            size: f.size,
            originalName: f.originalName,
          }))
        
        // Add any newly uploaded files
        const allFiles = [...remainingFiles, ...uploadedFileKeys]
        
        // Validate for duplicate file paths in the combined list before updating
        const allFilePaths = allFiles.map(f => f.originalName || f.key.split('/').pop() || '')
        const filePathCounts = new Map<string, number>()
        allFilePaths.forEach(path => {
          filePathCounts.set(path, (filePathCounts.get(path) || 0) + 1)
        })
        
        const duplicates: string[] = []
        filePathCounts.forEach((count, path) => {
          if (count > 1) {
            duplicates.push(path)
          }
        })
        
        if (duplicates.length > 0) {
          setFormError(
            `Duplicate file paths detected in the file list: ${duplicates.join(', ')}. ` +
            `Files with the same path will overwrite each other in S3. ` +
            `Please remove or rename the duplicate files.`
          )
          return
        }
        
        // This will create a new manifest with the updated file list
        await registerManualUploadManifestFiles(projectId, editingDataSetId, allFiles)
      }

      // Update manifest schema if provided (for both create and update scenarios)
      if (formData.schema !== undefined && createdDataset) {
        try {
          // Get the latest manifest (draft or committed)
          const manifests = await manifestApi.list(projectId, createdDataset.id)
          const latestManifest = manifests.length > 0 
            ? manifests.sort((a, b) => b.manifestId - a.manifestId)[0]
            : null
          
          if (latestManifest) {
            await manifestApi.updateSchema(
              projectId,
              createdDataset.id,
              latestManifest.id,
              formData.schema || undefined
            )
          } else if (!editingDataSetId && uploadedFiles.length === 0) {
            // If no manifest exists and we're creating without files, create one with schema
            await manifestApi.create(projectId, createdDataset.id, {
              uris: [],
              schema: formData.schema,
            })
          }
        } catch (err: any) {
          // Log error but don't fail the entire operation
          console.warn('Failed to update manifest schema:', err)
        }
      }

      // Commit the manifest for new datasets with files uploaded.
      // This triggers the dataset import workflow. The backend also auto-commits when
      // the first batch of files is added (updateManifestWithFiles), but we commit here
      // so the workflow is triggered immediately from the UI path.
      if (!editingDataSetId && createdDataset && uploadedFiles.length > 0) {
        try {
          const manifests = await manifestApi.list(projectId, createdDataset.id)
          const draftManifest = manifests.find(m => m.status === 'draft')
          if (draftManifest) {
            await manifestApi.commit(projectId, createdDataset.id, draftManifest.id)
          } else {
            // Fallback: backend may have already auto-committed; if no draft, trigger import directly
            await datasetApi.import(projectId, createdDataset.id)
          }
        } catch (err: any) {
          console.warn('Failed to commit manifest or trigger import:', err)
        }
      }

      if (projectId && createdDataset?.id && uploadedFiles.length > 0) {
        clearManualUploadResume(projectId, createdDataset.id)
      }

      // Auto-trigger acquisition for newly-created acquired datasets
      if (!editingDataSetId && createdDataset && formData.type === 'acquired'
          && (formData.originVolume || formData.originConnector)) {
        try {
          await acquisitionApi.acquire(projectId!, createdDataset.id)
          showToast(`Dataset "${formData.name}" created and acquisition started`, 'success')
        } catch (acqErr: any) {
          console.warn('Auto-acquisition trigger failed:', acqErr)
          showToast(`Dataset created but acquisition failed to start: ${acqErr.message}`, 'warning')
        }
      }

      setShowCreateModal(false)
      resetForm()
      loadDatasets()
    } catch (err: any) {
      // Extract error message from API response
      let errorMessage = `Failed to ${editingDataSetId ? 'update' : 'create'} dataset`
      if (err.response?.data?.error) {
        errorMessage = err.response.data.error
      } else if (err.message) {
        errorMessage = err.message
      }
      setFormError(errorMessage)
      // Do not delete the dataset here — user may Retry; cleanup only on explicit cancel (onClose).
    } finally {
      setSubmitHint(null)
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading datasets..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Datasets</h1>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button 
            appearance="subtle" 
            icon={<ArrowClockwise24Regular />} 
            onClick={() => loadDatasets()}
            disabled={loading}
            title="Refresh datasets"
          >
            Refresh
          </Button>
          <Button appearance="primary" icon={<Add24Regular />} onClick={() => {
            resetForm()
            setShowCreateModal(true)
          }}>
            Create Dataset
          </Button>
        </div>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '16px', paddingBottom: '0' }}>
          <Search24Regular />
          <Input
            placeholder="Search datasets..."
            value={searchQuery}
            onChange={(_, data) => setSearchQuery(data.value)}
            style={{ flex: 1 }}
            disabled={searching}
          />
        </div>
        {filteredDatasets.length === 0 ? (
          <div style={{ padding: '24px' }}>
            <Text>No datasets found</Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Description</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Kind</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>PII Analysis</TableHeaderCell>
                <TableHeaderCell>Origin Connector</TableHeaderCell>
                <TableHeaderCell>Used by</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredDatasets.map((dataset) => (
                <TableRow key={dataset.id}>
                  <TableCell>
                    <Text
                      weight="semibold"
                      style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }}
                      onClick={() => navigate(`/projects/${projectId}/datasets/${dataset.id}`)}
                    >
                      {dataset.name}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <Text>{dataset.description || '-'}</Text>
                  </TableCell>
                  <TableCell>
                    <Text>{dataset.type}</Text>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {dataset.kind === 'unstructured' ? (
                        <Document24Regular />
                      ) : (
                        <Table24Regular />
                      )}
                      <Text>
                        {dataset.kind === 'unstructured' ? 'Unstructured' : 'Structured'}
                      </Text>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      {(() => {
                        const acqFacet = dataset.facets?.find(f => f.facetType === 'acquisition')
                        const isAcquiring = acqFacet?.state === 'in_progress'

                        if (dataset.status === 'in_progress') {
                          const phaseLabel = isAcquiring ? 'Acquiring'
                            : dataset.progress?.phase === 'pii_analysis' ? 'PII Analysis'
                            : 'Importing'
                          return (
                            <>
                              <Tooltip content="Click to view workflow details" relationship="label">
                                <Badge
                                  color={statusColors[dataset.status] || 'brand'}
                                  className={styles.statusBadge}
                                  style={{ cursor: 'pointer' }}
                                  onClick={(e: React.MouseEvent) => {
                                    e.stopPropagation()
                                    const wfId = dataset.jobId || `dataset-import-${projectId}-${dataset.id}`
                                    navigate(`/projects/${projectId}/workflows/${wfId}`)
                                  }}
                                >
                                  <Spinner size="tiny" style={{ marginRight: '4px' }} />
                                  {phaseLabel} ↗
                                </Badge>
                              </Tooltip>
                              {dataset.progress?.percentage != null ? (
                                (() => {
                                  const pct = Math.round(dataset.progress.percentage * 100) / 100
                                  return (
                                    <Tooltip
                                      content={`${dataset.progress.phase || 'Processing'}: ${pct}%`}
                                      relationship="label"
                                    >
                                      <div style={{ width: '100px' }}>
                                        <ProgressBar
                                          value={dataset.progress.percentage}
                                          max={100}
                                          thickness="medium"
                                        />
                                        <Text size={100} style={{ marginTop: '2px', color: tokens.colorNeutralForeground3 }}>
                                          {pct}%
                                        </Text>
                                      </div>
                                    </Tooltip>
                                  )
                                })()
                              ) : (
                                <div style={{ width: '100px' }}>
                                  <ProgressBar thickness="medium" />
                                  <Text size={100} style={{ marginTop: '2px', color: tokens.colorNeutralForeground3 }}>
                                    {isAcquiring ? 'Acquiring...' : 'Processing...'}
                                  </Text>
                                </div>
                              )}
                            </>
                          )
                        }

                        return (
                          <Badge
                            color={statusColors[dataset.status || 'ready'] || 'brand'}
                            className={styles.statusBadge}
                          >
                            {dataset.status === 'ready' ? 'Ready' : dataset.status === 'errored' ? 'Errored' : dataset.status === 'deprecated' ? 'Deprecated' : dataset.status || 'Ready'}
                          </Badge>
                        )
                      })()}
                      {dataset.status === 'errored' && dataset.errorMessage && (
                        <Tooltip relationship="label" content={dataset.errorMessage}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'help' }}>
                            <ErrorCircle24Regular style={{ color: tokens.colorPaletteRedForeground1, fontSize: '14px' }} />
                            <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, maxWidth: '200px', wordBreak: 'break-word' }}>
                              {dataset.errorMessage.length > 50 ? `${dataset.errorMessage.substring(0, 50)}...` : dataset.errorMessage}
                            </Text>
                          </div>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const piiFacet = dataset.facets?.find(f => f.facetType === 'pii');
                      const piiSummary = piiFacet?.summary as { filesWithPii?: number; totalFiles?: number } | undefined;
                      if (piiFacet && piiSummary) {
                        const filesWithPii = piiSummary.filesWithPii ?? 0;
                        const totalFiles = piiSummary.totalFiles ?? 0;
                        return (
                          <Tooltip
                            relationship="label"
                            content={`${filesWithPii} of ${totalFiles} files contain PII`}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <ShieldCheckmark24Regular
                                style={{
                                  color: filesWithPii > 0
                                    ? tokens.colorPaletteRedForeground1
                                    : tokens.colorPaletteGreenForeground1,
                                  fontSize: '16px',
                                }}
                              />
                              <Badge
                                color={filesWithPii > 0 ? 'danger' : 'success'}
                                className={styles.statusBadge}
                              >
                                {filesWithPii > 0
                                  ? `${filesWithPii} files with PII`
                                  : 'No PII found'}
                              </Badge>
                            </div>
                          </Tooltip>
                        );
                      }
                      if (piiFacet && piiFacet.state === 'in_progress') {
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <Badge color="warning" className={styles.statusBadge}>
                              <Spinner size="tiny" style={{ marginRight: '4px' }} />
                              Analyzing...
                            </Badge>
                            {piiFacet.progress?.percentage != null ? (
                              (() => {
                                const pct = Math.round(piiFacet.progress.percentage * 100) / 100
                                return (
                                  <Tooltip
                                    content={`PII Analysis: ${pct}%`}
                                    relationship="label"
                                  >
                                    <div style={{ width: '100px' }}>
                                      <ProgressBar
                                        value={piiFacet.progress.percentage}
                                        max={100}
                                        thickness="medium"
                                      />
                                      <Text size={100} style={{ marginTop: '2px', color: tokens.colorNeutralForeground3 }}>
                                        {pct}%
                                      </Text>
                                    </div>
                                  </Tooltip>
                                )
                              })()
                            ) : (
                              <div style={{ width: '100px' }}>
                                <ProgressBar thickness="medium" />
                                <Text size={100} style={{ marginTop: '2px', color: tokens.colorNeutralForeground3 }}>
                                  Analyzing...
                                </Text>
                              </div>
                            )}
                          </div>
                        );
                      }
                      return (
                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                          {dataset.kind === 'unstructured' ? 'Not enabled' : '-'}
                        </Text>
                      );
                    })()}
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <Text>
                        {dataset.originVolume
                          ? volumeDataSources.find((v) => v.id === dataset.originVolume)?.name || dataset.originVolume
                          : dataset.originConnector
                            ? availableConnectors.find((c) => c.id === dataset.originConnector)?.name || dataset.originConnector
                            : '-'}
                      </Text>
                      {dataset.scheduleConfig?.enabled && dataset.scheduleConfig?.cronExpression && (
                        <Tooltip content={`Cron: ${dataset.scheduleConfig.cronExpression} (${dataset.scheduleConfig.timezone || 'UTC'})`} relationship="label">
                          <Badge appearance="outline" color="informative" size="small" icon={<CalendarClock24Regular />}>
                            {dataset.scheduleConfig.cronExpression} {dataset.scheduleConfig.timezone || 'UTC'}
                          </Badge>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {projectId && (
                      <DependentsCell
                        projectId={projectId}
                        targetKind="dataset"
                        targetId={dataset.id}
                        summary={dataset.dependentsSummary}
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <Text>
                      {new Date(dataset.createdAt).toLocaleDateString()}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      {dataset.type === 'acquired' && (dataset.originConnector || dataset.originVolume) && (
                        <Tooltip content="Acquire data now" relationship="label">
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={acquiringIds.has(dataset.id) ? <Spinner size="tiny" /> : <Play24Regular />}
                            disabled={acquiringIds.has(dataset.id)}
                            onClick={async (e: React.MouseEvent) => {
                              e.stopPropagation()
                              setAcquiringIds((prev) => new Set(prev).add(dataset.id))
                              try {
                                await acquisitionApi.acquire(projectId!, dataset.id)
                                showToast(`Acquisition started for "${dataset.name}"`, 'success')
                                loadDatasets()
                              } catch (err: any) {
                                showToast(err.message || 'Failed to start acquisition', 'error')
                              } finally {
                                setAcquiringIds((prev) => {
                                  const next = new Set(prev)
                                  next.delete(dataset.id)
                                  return next
                                })
                              }
                            }}
                            title="Acquire Now"
                          />
                        </Tooltip>
                      )}
                      {dataset.status === 'errored' && (
                        <Tooltip content="Retry import" relationship="label">
                          <Button
                            appearance="subtle"
                            size="small"
                            icon={<ArrowClockwise24Regular />}
                            onClick={async (e: React.MouseEvent) => {
                              e.stopPropagation()
                              try {
                                await datasetApi.import(projectId!, dataset.id)
                                showToast(`Import re-triggered for "${dataset.name}"`, 'success')
                                loadDatasets()
                              } catch (err: any) {
                                showToast(err.message || 'Failed to retry import', 'error')
                              }
                            }}
                            title="Retry Import"
                          />
                        </Tooltip>
                      )}
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<Edit24Regular />}
                        onClick={() => handleEdit(dataset.id)}
                        title="Edit Dataset"
                      />
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<Delete24Regular />}
                        onClick={() => handleDeleteClick(dataset.id, dataset.name)}
                        title="Delete Dataset"
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* Create/Edit Modal - Wizard */}
      {showCreateModal && (
        <WizardModal
          title={editingDataSetId ? 'Edit Dataset' : 'Create Dataset'}
          onClose={async () => {
            // Cleanup created dataset if wizard is closed/cancelled during creation
            if (!editingDataSetId && createdDatasetId) {
              await cleanupCreatedDataset(createdDatasetId)
            }
            setShowCreateModal(false)
            resetForm()
            // Refresh dataset list when wizard closes
            loadDatasets()
          }}
          onSubmit={handleSubmit}
          submitting={submitting}
          submittingHint={submitHint}
          formError={formError}
          currentStep={wizardStep}
          onNext={nextStep}
          onPrev={prevStep}
          steps={[
            { number: 1, title: 'Basic Info', description: 'Name and type' },
            { number: 2, title: 'Data Source', description: 'Select source' },
            { number: 3, title: 'Configuration', description: 'Settings' },
            { number: 4, title: 'Review', description: 'Confirm' },
          ]}
          submitLabel={
            editingDataSetId ? 'Update Dataset' : createdDatasetId ? 'Retry' : 'Create Dataset'
          }
          mode={editingDataSetId ? 'edit' : 'create'}
          onStepClick={(s) => { setFormError(null); setWizardStep(s) }}
          onAbort={uploadPhaseActive ? handleAbortUpload : undefined}
        >
          <DataSetWizard
            step={wizardStep}
            formData={formData}
            updateFormField={updateFormField}
            updateArrayField={updateArrayField}
            addArrayItem={addArrayItem}
            removeArrayItem={removeArrayItem}
            updateJsonField={updateJsonField}
            availableConnectors={availableConnectors}
            volumeDataSources={volumeDataSources}
            providerCatalog={providerCatalog}
            uploadedFiles={uploadedFiles}
            setUploadedFiles={setUploadedFiles}
            uploadProgress={uploadProgress}
            uploadErrors={uploadErrors}
            existingFiles={existingFiles}
            onDeleteExistingFile={handleDeleteExistingFile}
            isEditing={!!editingDataSetId}
            filesToDelete={filesToDelete}
            projectId={projectId}
            submitting={submitting}
            uploadConcurrency={MANUAL_UPLOAD_CONCURRENCY}
          />
        </WizardModal>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setDatasetToDelete(null)
          setDeleteBlockers(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Dataset</DialogTitle>
          <DialogBody>
            <DialogContent>
              {deleteBlockers ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <Text>
                    Cannot delete &quot;{datasetToDelete?.name}&quot; while it is still in use by:
                  </Text>
                  {projectId && (
                    <DependentsBlockerList projectId={projectId} page={deleteBlockers} />
                  )}
                  <Text style={{ marginTop: 4, color: tokens.colorNeutralForeground2 }}>
                    Update or remove these references, then try deleting again.
                  </Text>
                </div>
              ) : (
                <Text>
                  Are you sure you want to delete dataset &quot;{datasetToDelete?.name}&quot;? This action cannot be undone.
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
              >
                {deleteBlockers ? 'Close' : 'Cancel'}
              </Button>
              {!deleteBlockers && (
                <Button
                  appearance="primary"
                  onClick={handleDeleteConfirm}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

