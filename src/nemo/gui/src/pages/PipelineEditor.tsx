import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  makeStyles,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Field,
  Input,
  Button,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import { Dismiss24Regular } from '@fluentui/react-icons'
import { PipelineEditor as PipelineEditorComponent } from '@/components/pipeline-editor/pipeline-editor'
import { Serializer } from '@/serializer'
import type { SerializedWorkflow } from '@/serializer/types'
import { useWorkflowStore } from '@/stores/workflow/store'
import type { WorkflowState } from '@/stores/workflow/types'
import { pipelineApi, Pipeline } from '../services/api'

/**
 * Convert SerializedWorkflow to Pipeline graph format
 * Stores the full SerializedWorkflow in the graph structure for round-trip conversion
 */
function serializeWorkflowToGraph(serialized: SerializedWorkflow): Pipeline['graph'] {
  return {
    nodes: serialized.blocks.map((block) => {
      const blockType = block.metadata?.id || 'code'
      
      return {
        id: block.id,
        type: blockType, // Use original block type directly (no mapping needed)
        config: {
          ...block.config,
        },
        metadata: {
          ...block.metadata,
          position: block.position,
          inputs: block.inputs,
          outputs: block.outputs,
          enabled: block.enabled,
        },
      }
    }),
    edges: serialized.connections.map((conn) => ({
      from: conn.source,
      to: conn.target,
      config: {
        sourceHandle: conn.sourceHandle,
        targetHandle: conn.targetHandle,
      },
    })),
  }
}

/**
 * Convert Pipeline graph format to SerializedWorkflow
 * Restores the full SerializedWorkflow from the graph structure
 */
function graphToSerializedWorkflow(graph: Pipeline['graph']): SerializedWorkflow {
  return {
    version: '1.0',
    blocks: graph.nodes.map((node) => {
      // Reconstruct from node data
      // Use node.type directly (which now stores the original block type)
      const blockType = node.type || node.metadata?.id || 'code'
      
      // Extract params from node.config - node.config should have { tool, params } structure
      // If node.config.params exists, use it; otherwise fall back to node.config (for backward compatibility)
      const configParams = (node.config as any)?.params || node.config || {}
      
      return {
        id: node.id,
        position: (node.metadata as any)?.position || { x: 0, y: 0 },
        config: {
          tool: (node.config as any)?.tool || blockType,
          params: configParams,
        },
        inputs: (node.metadata as any)?.inputs || {},
        outputs: (node.metadata as any)?.outputs || {},
        metadata: {
          ...node.metadata,
          id: blockType,
        },
        enabled: (node.metadata as any)?.enabled !== false,
      }
    }),
    connections: graph.edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
      sourceHandle: edge.config?.sourceHandle,
      targetHandle: edge.config?.targetHandle,
    })),
  }
}

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
  },
  editorContainer: {
    flex: 1,
    overflow: 'hidden',
  },
})

/**
 * PipelineEditor - Main component for editing pipelines
 * 
 * Handles:
 * - Loading existing pipelines from the API
 * - Creating new pipelines
 * - Saving pipeline workflows
 * - Loading workflows from JSON files
 * 
 * Uses a single workflow store instance (no tab management)
 */
export default function PipelineEditor() {
  const styles = useStyles()
  const { projectId, pipelineId, pipelineType } = useParams<{
    projectId: string
    pipelineId?: string
    pipelineType?: string
  }>()
  const { replaceWorkflowState, updateLastSaved, getWorkflowState } = useWorkflowStore()
  const serializerRef = useRef(new Serializer())
  const isInitializingRef = useRef(false)
  const [pipelineName, setPipelineName] = useState<string>('New pipeline')
  const [pipelineDescription, setPipelineDescription] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [saveNameValue, setSaveNameValue] = useState('')
  const [saveDescriptionValue, setSaveDescriptionValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  const [editDescriptionValue, setEditDescriptionValue] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [currentPipelineId, setCurrentPipelineId] = useState<string | undefined>(pipelineId)

  /**
   * Handle direct save (for updates) - saves without showing modal
   */
  const handleSaveDirect = useCallback(
    async () => {
      if (!projectId) {
        setUpdateError('Project ID is required to save pipeline')
        return
      }

      // Use currentPipelineId (state) instead of pipelineId (from params)
      const idToUse = currentPipelineId || pipelineId
      if (!idToUse) {
        // Should not happen - this function should only be called for updates
        console.error('handleSaveDirect called without pipelineId')
        return
      }

      if (saving) {
        return // Prevent multiple simultaneous saves
      }

      setSaving(true)
      setUpdateError(null)
      try {
        const workflow = getWorkflowState()
        
        // Serialize the workflow to JSON format
        const serialized = serializerRef.current.serializeWorkflow(workflow.blocks, workflow.edges)
        
        // Convert SerializedWorkflow to Pipeline graph format
        const graph = serializeWorkflowToGraph(serialized)
        
        // Update existing pipeline
        await pipelineApi.update(projectId, idToUse, {
          name: pipelineName,
          description: pipelineDescription || undefined,
          graph: graph,
        })
        console.log('Pipeline updated successfully via config-service API')
        
        // Update last saved timestamp in workflow store
        updateLastSaved()
      } catch (error: any) {
        console.error('Failed to save pipeline to config-service:', error)
        const errorMessage = error?.response?.data?.error || error?.message || 'Failed to save pipeline'
        setUpdateError(errorMessage)
      } finally {
        setSaving(false)
      }
    },
    [currentPipelineId, pipelineId, projectId, pipelineName, pipelineDescription, saving, getWorkflowState, updateLastSaved]
  )

  /**
   * Handle opening the save dialog (only for new pipelines)
   * For updates, saves directly without showing modal
   */
  const handleSaveClick = useCallback(() => {
    // Use currentPipelineId (state) instead of pipelineId (from params) to handle newly created pipelines
    // If currentPipelineId exists, this is an update - save directly without modal
    if (currentPipelineId) {
      handleSaveDirect()
      return
    }

    // For new pipelines, show the modal
    // Pre-populate with current values
    setSaveNameValue(pipelineName !== 'New pipeline' ? pipelineName : '')
    setSaveDescriptionValue(pipelineDescription)
    setSaveError(null)
    setSaveDialogOpen(true)
  }, [pipelineName, pipelineDescription, currentPipelineId, handleSaveDirect])

  /**
   * Handle saving the workflow to the API
   * Serializes the pipeline into JSON and calls config-service API to create/update pipeline
   */
  const handleSaveConfirm = useCallback(
    async () => {
      if (!saveNameValue.trim()) {
        setSaveError('Pipeline name is required')
        return
      }

      if (!projectId) {
        setSaveError('Project ID is required to save pipeline')
        return
      }

      if (saving) {
        return // Prevent multiple simultaneous saves
      }

      setSaving(true)
      setSaveError(null)
      try {
        const workflow = getWorkflowState()
        
        // Step 1: Serialize the workflow to JSON format (SerializedWorkflow)
        const serialized = serializerRef.current.serializeWorkflow(workflow.blocks, workflow.edges)
        
        // Step 2: Convert SerializedWorkflow to Pipeline graph format (DAG of nodes and edges)
        // The graph is a JSON object with nodes and edges arrays
        const graph = serializeWorkflowToGraph(serialized)
        
        // Step 3: Determine pipeline type from route
        // Convert "data" -> "Data", "api" -> "API", default to "Data"
        const type: 'Data' | 'API' = pipelineType === 'api' ? 'API' : 'Data'

        // Step 4: Prepare the pipeline payload as JSON
        const pipelinePayload = {
          name: saveNameValue.trim(),
          description: saveDescriptionValue.trim() || undefined,
          type: type,
          graph: graph, // This is the serialized DAG as JSON
        }

        // Step 5: Call config-service API to create or update pipeline
        if (pipelineId && projectId) {
          // Update existing pipeline
          await pipelineApi.update(projectId, pipelineId, {
            name: saveNameValue.trim(),
            description: saveDescriptionValue.trim() || undefined,
            graph: graph,
          })
          console.log('Pipeline updated successfully via config-service API')
          // Update local state
          setPipelineName(saveNameValue.trim())
          setPipelineDescription(saveDescriptionValue.trim())
        } else if (projectId) {
          // Create new pipeline
          const savedPipeline = await pipelineApi.create(projectId, pipelinePayload)
          console.log('Pipeline created successfully via config-service API:', savedPipeline)
          
          // Update local state
          setPipelineName(savedPipeline.name)
          if (savedPipeline.description) {
            setPipelineDescription(savedPipeline.description)
          }
          
          // Update currentPipelineId state so subsequent saves are treated as updates
          if (savedPipeline.id) {
            setCurrentPipelineId(savedPipeline.id)
          }
          
          // Update the URL to include the new pipeline ID for future saves
          // Preserve the pipelineType in the URL
          if (savedPipeline.id && pipelineType) {
            window.history.replaceState(
              {},
              '',
              `/projects/${projectId}/pipelines/${pipelineType}/editor/${savedPipeline.id}`
            )
          }
        }

        // Step 6: Update last saved timestamp in workflow store
        updateLastSaved()
        
        // Close the dialog
        setSaveDialogOpen(false)
      } catch (error: any) {
        console.error('Failed to save pipeline to config-service:', error)
        const errorMessage = error?.response?.data?.error || error?.message || 'Failed to save pipeline'
        setSaveError(errorMessage)
      } finally {
        setSaving(false)
      }
    },
    [pipelineId, projectId, pipelineType, saveNameValue, saveDescriptionValue, saving, getWorkflowState, updateLastSaved]
  )

  /**
   * Load pipeline data when component mounts or route params change
   * - For new pipelines: initializes with empty workflow state
   * - For existing pipelines: loads workflow from API
   */
  useEffect(() => {
    if (!projectId) return
    if (isInitializingRef.current) return
    isInitializingRef.current = true

    const loadPipeline = async () => {
      // Initialize with empty workflow state
      let initialWorkflowState: WorkflowState = {
        blocks: {},
        edges: [],
        lastSaved: undefined,
      }

      // Load pipeline data if editing existing pipeline
      if (pipelineId && projectId) {
        try {
          const pipeline = await pipelineApi.get(projectId, pipelineId)
          // Update currentPipelineId state
          setCurrentPipelineId(pipelineId)
          // Set pipeline name and description from loaded pipeline
          if (pipeline.name) {
            setPipelineName(pipeline.name)
          }
          if (pipeline.description) {
            setPipelineDescription(pipeline.description)
          }
          if (pipeline.graph) {
            // Convert Pipeline graph to SerializedWorkflow format
            const serializedWorkflow = graphToSerializedWorkflow(pipeline.graph)
            const deserialized = serializerRef.current.deserializeWorkflow(serializedWorkflow)
            initialWorkflowState = {
              blocks: deserialized.blocks,
              edges: deserialized.edges,
              lastSaved: Date.now(),
            }
          }
        } catch (error) {
          console.error('Failed to load pipeline:', error)
        }
      } else {
        // Reset to default name for new pipelines
        setPipelineName('New pipeline')
        setCurrentPipelineId(undefined)
      }

      // Load the workflow state into the workflow store
      replaceWorkflowState(initialWorkflowState, { updateLastSaved: false })
      isInitializingRef.current = false
    }

    loadPipeline()

    return () => {
      isInitializingRef.current = false
    }
  }, [projectId, pipelineId, replaceWorkflowState])

  /**
   * Handle pipeline name change
   */
  const handleNameChange = useCallback(
    async (name: string) => {
      setPipelineName(name)
      
      // Update pipeline name in API if editing existing pipeline
      const idToUse = currentPipelineId || pipelineId
      if (idToUse && projectId && name && name !== 'New pipeline') {
        try {
          await pipelineApi.update(projectId, idToUse, {
            name: name,
          })
        } catch (error) {
          console.error('Failed to update pipeline name:', error)
          // Revert to previous name on error
          // Note: We could show a toast/notification here
        }
      }
    },
    [currentPipelineId, pipelineId, projectId]
  )

  /**
   * Handle opening the edit dialog
   */
  const handleEditClick = useCallback(() => {
    setEditNameValue(pipelineName)
    setEditDescriptionValue(pipelineDescription)
    setEditError(null)
    setEditDialogOpen(true)
  }, [pipelineName, pipelineDescription])

  /**
   * Handle confirming the edit dialog
   */
  const handleEditConfirm = useCallback(async () => {
    if (!editNameValue.trim()) {
      setEditError('Pipeline name is required')
      return
    }

    const idToUse = currentPipelineId || pipelineId
    if (!idToUse || !projectId) {
      setEditError('Cannot edit pipeline: missing pipeline ID or project ID')
      return
    }

    if (saving) {
      return
    }

    setSaving(true)
    setEditError(null)
    try {
      await pipelineApi.update(projectId, idToUse, {
        name: editNameValue.trim(),
        description: editDescriptionValue.trim() || undefined,
      })
      
      // Update local state
      setPipelineName(editNameValue.trim())
      setPipelineDescription(editDescriptionValue.trim())
      
      // Close the dialog
      setEditDialogOpen(false)
    } catch (error: any) {
      console.error('Failed to update pipeline:', error)
      const errorMessage = error?.response?.data?.error || error?.message || 'Failed to update pipeline'
      setEditError(errorMessage)
    } finally {
      setSaving(false)
    }
  }, [editNameValue, editDescriptionValue, currentPipelineId, pipelineId, projectId, saving])

  return (
    <div className={styles.container}>
      {/* Error message for update saves (outside modal) */}
      {updateError && (
        <div style={{ padding: '16px', position: 'fixed', top: '16px', right: '16px', zIndex: 1000, maxWidth: '400px' }}>
          <MessageBar intent="error" style={{ position: 'relative' }}>
            <MessageBarBody>{updateError}</MessageBarBody>
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={() => setUpdateError(null)}
              style={{ position: 'absolute', top: '8px', right: '8px', minWidth: 'auto', padding: '4px' }}
              title="Dismiss"
            />
          </MessageBar>
        </div>
      )}
      <div className={styles.editorContainer}>
        <PipelineEditorComponent 
          pipelineName={pipelineName}
          onNameChange={handleNameChange}
          onSave={handleSaveClick} 
          onEdit={handleEditClick}
          saving={saving}
          saveButtonLabel={pipelineType === 'api' ? 'Save' : 'Save Pipeline'}
        />
      </div>

      {/* Save Dialog - only shown for new pipelines */}
      <Dialog open={saveDialogOpen} onOpenChange={(_, data) => {
        setSaveDialogOpen(data.open)
        if (!data.open) {
          setSaveError(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>{pipelineType === 'api' ? 'Save Flow' : 'Save Pipeline'}</DialogTitle>
          <DialogBody>
            <DialogContent>
              {saveError && (
                <MessageBar intent="error" style={{ marginBottom: '16px' }}>
                  <MessageBarBody>{saveError}</MessageBarBody>
                </MessageBar>
              )}
              <Field label={pipelineType === 'api' ? 'Flow Name' : 'Pipeline Name'} required style={{ marginBottom: '16px' }}>
                <Input
                  value={saveNameValue}
                  onChange={(_, data) => setSaveNameValue(data.value)}
                  placeholder={pipelineType === 'api' ? 'Enter flow name' : 'Enter pipeline name'}
                  disabled={saving}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && saveNameValue.trim() && !saving) {
                      handleSaveConfirm()
                    }
                  }}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={saveDescriptionValue}
                  onChange={(_, data) => setSaveDescriptionValue(data.value)}
                  placeholder={pipelineType === 'api' ? 'Enter flow description' : 'Enter pipeline description'}
                  disabled={saving}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setSaveDialogOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleSaveConfirm}
                disabled={!saveNameValue.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit Dialog - for editing name and description */}
      <Dialog open={editDialogOpen} onOpenChange={(_, data) => {
        setEditDialogOpen(data.open)
        if (!data.open) {
          setEditError(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>{pipelineType === 'api' ? 'Edit Flow' : 'Edit Pipeline'}</DialogTitle>
          <DialogBody>
            <DialogContent>
              {editError && (
                <MessageBar intent="error" style={{ marginBottom: '16px' }}>
                  <MessageBarBody>{editError}</MessageBarBody>
                </MessageBar>
              )}
              <Field label={pipelineType === 'api' ? 'Flow Name' : 'Pipeline Name'} required style={{ marginBottom: '16px' }}>
                <Input
                  value={editNameValue}
                  onChange={(_, data) => setEditNameValue(data.value)}
                  placeholder={pipelineType === 'api' ? 'Enter flow name' : 'Enter pipeline name'}
                  disabled={saving}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editNameValue.trim() && !saving) {
                      handleEditConfirm()
                    }
                  }}
                />
              </Field>
              <Field label="Description">
                <Input
                  value={editDescriptionValue}
                  onChange={(_, data) => setEditDescriptionValue(data.value)}
                  placeholder={pipelineType === 'api' ? 'Enter flow description' : 'Enter pipeline description'}
                  disabled={saving}
                />
              </Field>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setEditDialogOpen(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleEditConfirm}
                disabled={!editNameValue.trim() || saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  )
}

