import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  Card,
  CardHeader,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components'
import { pipelineApi, Pipeline } from '../services/api'
import { PipelineList } from '../components/pipeline/PipelineList'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  card: {
    padding: '16px',
  },
})

export default function ApiPipelineList() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPipelines = useCallback(async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)
      const data = await pipelineApi.list(projectId, { type: 'API' })
      setPipelines(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load pipelines')
      console.error('Failed to load pipelines:', err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadPipelines()
  }, [loadPipelines])

  const handleCreate = () => {
    navigate(`/projects/${projectId}/pipelines/api/editor`)
  }

  const handleEdit = (pipeline: Pipeline) => {
    // Determine pipeline type from the pipeline object or default to 'api'
    const pipelineType = pipeline.type?.toLowerCase() || 'api'
    navigate(`/projects/${projectId}/pipelines/${pipelineType}/editor/${pipeline.id}`)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
        <Spinner label="Loading pipelines..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Agent Flows</Text>} />
        <PipelineList
          pipelines={pipelines}
          onCreate={handleCreate}
          projectId={projectId!}
          onPipelineUpdated={loadPipelines}
          onEdit={handleEdit}
          createButtonLabel="+New Flow"
        />
      </Card>
    </div>
  )
}

