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
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Button,
  Input,
} from '@fluentui/react-components'
import { Search24Regular, Edit24Regular, ArrowRight16Regular } from '@fluentui/react-icons'
import { pipelineApi, Pipeline } from '../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
    padding: '24px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardsContainer: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '24px',
  },
  card: {
    padding: '16px',
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '16px',
  },
  table: {
    width: '100%',
  },
  emptyState: {
    padding: '32px',
    textAlign: 'center',
    color: 'var(--colorNeutralForeground3)',
  },
  viewAllButton: {
    marginTop: '16px',
  },
})

export default function NamespacePipelines() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()

  const [dataPipelines, setDataPipelines] = useState<Pipeline[]>([])
  const [apiPipelines, setApiPipelines] = useState<Pipeline[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dataSearchQuery, setDataSearchQuery] = useState('')
  const [apiSearchQuery, setApiSearchQuery] = useState('')

  const loadPipelines = useCallback(async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)
      
      // Load both types of pipelines
      const [dataPipelinesData, apiPipelinesData] = await Promise.all([
        pipelineApi.list(projectId, { type: 'Data' }),
        pipelineApi.list(projectId, { type: 'API' }),
      ])
      
      // Sort by updatedAt descending and take top 5
      const sortedData = [...dataPipelinesData].sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ).slice(0, 5)
      
      const sortedApi = [...apiPipelinesData].sort((a, b) => 
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      ).slice(0, 5)
      
      setDataPipelines(sortedData)
      setApiPipelines(sortedApi)
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

  const filterPipelines = (pipelines: Pipeline[], query: string) => {
    if (!query.trim()) {
      return pipelines
    }
    const lowerQuery = query.toLowerCase()
    return pipelines.filter(
      (pipeline) =>
        pipeline.name.toLowerCase().includes(lowerQuery) ||
        pipeline.description?.toLowerCase().includes(lowerQuery) ||
        pipeline.id.toLowerCase().includes(lowerQuery)
    )
  }

  const filteredDataPipelines = filterPipelines(dataPipelines, dataSearchQuery)
  const filteredApiPipelines = filterPipelines(apiPipelines, apiSearchQuery)

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString()
  }

  const getNodeCount = (pipeline: Pipeline) => {
    return pipeline.graph?.nodes?.length || 0
  }

  const handleEdit = (pipeline: Pipeline) => {
    const pipelineType = pipeline.type?.toLowerCase() === 'api' ? 'api' : 'data'
    navigate(`/projects/${projectId}/pipelines/${pipelineType}/editor/${pipeline.id}`)
  }

  const handleViewAll = () => {
    navigate(`/projects/${projectId}/pipelines`)
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
      <div className={styles.header}>
        <Text size={600} weight="semibold">Pipelines</Text>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.cardsContainer}>
        {/* Data Pipelines Card */}
        <Card className={styles.card}>
          <CardHeader
            header={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text weight="semibold">Data</Text>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<ArrowRight16Regular />}
                  iconPosition="after"
                  onClick={handleViewAll}
                >
                  View All
                </Button>
              </div>
            }
          />
          <div className={styles.searchContainer}>
            <Search24Regular />
            <Input
              placeholder="Search data pipelines..."
              value={dataSearchQuery}
              onChange={(_, data) => setDataSearchQuery(data.value)}
              style={{ flex: 1 }}
            />
          </div>
          {filteredDataPipelines.length === 0 ? (
            <div className={styles.emptyState}>
              <Text>
                {dataSearchQuery
                  ? 'No data pipelines found matching your search'
                  : 'No data pipelines found. Create your first data pipeline to get started.'}
              </Text>
            </div>
          ) : (
            <>
              <Table className={styles.table}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Description</TableHeaderCell>
                    <TableHeaderCell>Nodes</TableHeaderCell>
                    <TableHeaderCell>Updated</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDataPipelines.map((pipeline) => (
                    <TableRow key={pipeline.id}>
                      <TableCell>
                        <Text weight="semibold">{pipeline.name}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{pipeline.description || '-'}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{getNodeCount(pipeline)}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{formatDate(pipeline.updatedAt)}</Text>
                      </TableCell>
                      <TableCell>
                        <Button
                          appearance="subtle"
                          icon={<Edit24Regular />}
                          onClick={() => handleEdit(pipeline)}
                          title="Edit Pipeline"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Card>

        {/* API Pipelines Card */}
        <Card className={styles.card}>
          <CardHeader
            header={
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text weight="semibold">API</Text>
                <Button
                  appearance="subtle"
                  size="small"
                  icon={<ArrowRight16Regular />}
                  iconPosition="after"
                  onClick={handleViewAll}
                >
                  View All
                </Button>
              </div>
            }
          />
          <div className={styles.searchContainer}>
            <Search24Regular />
            <Input
              placeholder="Search API pipelines..."
              value={apiSearchQuery}
              onChange={(_, data) => setApiSearchQuery(data.value)}
              style={{ flex: 1 }}
            />
          </div>
          {filteredApiPipelines.length === 0 ? (
            <div className={styles.emptyState}>
              <Text>
                {apiSearchQuery
                  ? 'No API pipelines found matching your search'
                  : 'No API pipelines found. Create your first API pipeline to get started.'}
              </Text>
            </div>
          ) : (
            <>
              <Table className={styles.table}>
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Description</TableHeaderCell>
                    <TableHeaderCell>Nodes</TableHeaderCell>
                    <TableHeaderCell>Updated</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredApiPipelines.map((pipeline) => (
                    <TableRow key={pipeline.id}>
                      <TableCell>
                        <Text weight="semibold">{pipeline.name}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{pipeline.description || '-'}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{getNodeCount(pipeline)}</Text>
                      </TableCell>
                      <TableCell>
                        <Text>{formatDate(pipeline.updatedAt)}</Text>
                      </TableCell>
                      <TableCell>
                        <Button
                          appearance="subtle"
                          icon={<Edit24Regular />}
                          onClick={() => handleEdit(pipeline)}
                          title="Edit Pipeline"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
