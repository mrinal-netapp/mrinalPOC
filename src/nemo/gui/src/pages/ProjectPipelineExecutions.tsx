import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  MessageBar,
  MessageBarBody,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Badge,
  Button,
} from '@fluentui/react-components'
import { Link24Regular } from '@fluentui/react-icons'
import { pipelineExecutionApi, PipelineExecution } from '../services/api'
import { useToast } from '../contexts/ToastContext'

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
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
})

export default function ProjectPipelineExecutions() {
  const styles = useStyles()
  const { projectId, pipelineId } = useParams<{ projectId: string; pipelineId?: string }>()
  const { showToast } = useToast()
  const [executions, setExecutions] = useState<PipelineExecution[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (projectId && pipelineId) {
      loadExecutions()
    }
  }, [projectId, pipelineId])

  const loadExecutions = async () => {
    if (!projectId || !pipelineId) return
    try {
      setLoading(true)
      const data = await pipelineExecutionApi.list(projectId, pipelineId)
      setExecutions(data)
    } catch (err: any) {
      showToast(`Failed to load executions: ${err.message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = async (execution: PipelineExecution) => {
    if (!projectId || !pipelineId) return
    try {
      await pipelineExecutionApi.cancel(projectId, pipelineId, execution.executionId)
      showToast(`Execution ${execution.executionId} cancelled`, 'success')
      loadExecutions()
    } catch (err: any) {
      showToast(`Failed to cancel execution: ${err.message}`, 'error')
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString()
  }

  const getStatusBadge = (status: string) => {
    const colorMap: Record<string, 'success' | 'danger' | 'informative' | 'warning'> = {
      completed: 'success',
      failed: 'danger',
      running: 'informative',
      cancelled: 'warning',
    }
    return <Badge appearance="filled" color={colorMap[status] || 'informative'}>{status}</Badge>
  }

  const openTemporalUI = () => {
    window.open('/internal/temporal/ui', '_blank', 'noopener,noreferrer')
  }

  if (!projectId) {
    return null
  }

  if (!pipelineId) {
    return (
      <div className={styles.container}>
        <MessageBar intent="info">
          <MessageBarBody>
            Please select a pipeline to view executions.
          </MessageBarBody>
        </MessageBar>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Pipeline Executions</h1>
        <div className={styles.headerActions}>
          <Button
            appearance="secondary"
            icon={<Link24Regular />}
            onClick={openTemporalUI}
          >
            Temporal UI
          </Button>
        </div>
      </div>

      {executions.length === 0 && !loading ? (
        <Card>
          <CardHeader header={<Text weight="semibold">No Executions</Text>} />
          <div style={{ padding: '24px' }}>
            <MessageBar intent="info">
              <MessageBarBody>
                No executions found for this pipeline. Execute the pipeline to see execution history.
              </MessageBarBody>
            </MessageBar>
          </div>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Execution ID</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Started</TableHeaderCell>
              <TableHeaderCell>Ended</TableHeaderCell>
              <TableHeaderCell>Actions</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {executions.map((execution) => (
              <TableRow key={execution.id}>
                <TableCell>
                  <Text weight="semibold">{execution.executionId}</Text>
                </TableCell>
                <TableCell>{getStatusBadge(execution.status)}</TableCell>
                <TableCell>{formatDate(execution.startedAt)}</TableCell>
                <TableCell>{execution.endedAt ? formatDate(execution.endedAt) : '-'}</TableCell>
                <TableCell>
                  {execution.status === 'running' && (
                    <Button
                      size="small"
                      onClick={() => handleCancel(execution)}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

