import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  makeStyles,
  Card,
  CardHeader,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
  TabList,
  Tab,
  TabValue,
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

type FilterType = 'all' | 'Data' | 'API'

export default function PipelineListPage() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const typeParam = searchParams.get('type') as FilterType | null

  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterType>(typeParam === 'Data' || typeParam === 'API' ? typeParam : 'all')

  useEffect(() => {
    const t = typeParam === 'Data' || typeParam === 'API' ? typeParam : 'all'
    setFilter(t)
  }, [typeParam])

  const loadPipelines = useCallback(async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)
      const [dataPipelines, apiPipelines] = await Promise.all([
        pipelineApi.list(projectId, { type: 'Data' }),
        pipelineApi.list(projectId, { type: 'API' }),
      ])
      const merged = [...dataPipelines, ...apiPipelines].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      setPipelines(merged)
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

  const filteredPipelines =
    filter === 'all'
      ? pipelines
      : pipelines.filter((p) => (p.type ?? 'Data') === filter)

  const handleFilterChange = (_: any, data: { value: TabValue }) => {
    const v = data.value as FilterType
    setFilter(v)
    if (v === 'all') setSearchParams({})
    else setSearchParams({ type: v })
  }

  const handleCreate = () => {
    navigate(`/projects/${projectId}/pipelines/data/editor`)
  }

  const handleEdit = (pipeline: Pipeline) => {
    const pipelineType = (pipeline.type ?? 'Data').toLowerCase() as 'data' | 'api'
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
        <CardHeader
          header={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
              <Text weight="semibold">Pipelines</Text>
              <TabList selectedValue={filter} onTabSelect={handleFilterChange}>
                <Tab value="all">All</Tab>
                <Tab value="Data">Data</Tab>
                <Tab value="API">API</Tab>
              </TabList>
            </div>
          }
        />
        <PipelineList
          pipelines={filteredPipelines}
          onCreate={handleCreate}
          projectId={projectId!}
          onPipelineUpdated={loadPipelines}
          onEdit={handleEdit}
          createButtonLabel="Create Pipeline"
          showTypeColumn={filter === 'all'}
        />
      </Card>
    </div>
  )
}
