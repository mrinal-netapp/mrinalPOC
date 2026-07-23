import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  Card,
  CardHeader,
  Text,
  Badge,
  Spinner,
  Button,
  Checkbox,
  MessageBar,
  MessageBarBody,
  tokens,
  Divider,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  CheckmarkCircle24Regular,
  DismissCircle24Regular,
  Clock24Regular,
  PersonFeedback24Regular,
} from '@fluentui/react-icons'
import { pipelineExecutionApi } from '@/services/api'
import { PipelineOutputRenderer } from '@/components/pipeline-output/PipelineOutputRenderer'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    padding: '24px',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  stepList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  stepCard: {
    padding: '16px',
    borderLeft: `4px solid ${tokens.colorNeutralStroke1}`,
  },
  stepCompleted: {
    borderLeftColor: tokens.colorPaletteGreenBorder1,
  },
  stepFailed: {
    borderLeftColor: tokens.colorPaletteRedBorder1,
  },
  stepWaiting: {
    borderLeftColor: tokens.colorPaletteYellowBorder1,
  },
  stepRunning: {
    borderLeftColor: tokens.colorBrandStroke1,
  },
  stepHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  approvalSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: '8px',
  },
  approvalActions: {
    display: 'flex',
    gap: '8px',
    marginTop: '8px',
  },
  recommendationRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  outputSection: {
    marginTop: '16px',
  },
})

interface StepResult {
  nodeId: string
  status: string
  output?: Record<string, any>
  results?: Record<string, any>
  error?: string
}

interface Execution {
  executionId: string
  pipelineId: string
  projectId: string
  status: string
  startedAt: string
  endedAt?: string
  stepResults?: StepResult[]
  finalOutput?: Record<string, any>
  error?: string
}

function getStatusBadge(status: string) {
  switch (status) {
    case 'completed':
      return <Badge appearance="filled" color="success" icon={<CheckmarkCircle24Regular />}>Completed</Badge>
    case 'failed':
    case 'timed_out':
      return <Badge appearance="filled" color="danger" icon={<DismissCircle24Regular />}>{status === 'timed_out' ? 'Timed Out' : 'Failed'}</Badge>
    case 'waiting_for_approval':
      return <Badge appearance="filled" color="warning" icon={<PersonFeedback24Regular />}>Waiting for Approval</Badge>
    case 'running':
      return <Badge appearance="filled" color="brand" icon={<Clock24Regular />}>Running</Badge>
    default:
      return <Badge appearance="filled" color="informative">{status}</Badge>
  }
}

export default function PipelineRunDetail() {
  const classes = useStyles()
  const { projectId, pipelineId, executionId } = useParams<{
    projectId: string
    pipelineId: string
    executionId: string
  }>()
  const navigate = useNavigate()

  const [execution, setExecution] = useState<Execution | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [resuming, setResuming] = useState(false)

  const fetchExecution = useCallback(async () => {
    if (!projectId || !pipelineId || !executionId) return
    try {
      const data = await pipelineExecutionApi.get(projectId, pipelineId, executionId)
      setExecution(data as Execution)
      setError(null)
    } catch (e: any) {
      setError(e.message || 'Failed to fetch execution')
    } finally {
      setLoading(false)
    }
  }, [projectId, pipelineId, executionId])

  useEffect(() => {
    fetchExecution()
    const interval = setInterval(fetchExecution, 5000)
    return () => clearInterval(interval)
  }, [fetchExecution])

  const handleApprove = async () => {
    if (!projectId || !pipelineId || !executionId || !execution) return
    setResuming(true)

    const allRecommendationIds = getRecommendationIds(execution)
    const approvedIds = Array.from(selectedIds)
    const rejectedIds = allRecommendationIds.filter((id) => !selectedIds.has(id))

    try {
      await pipelineExecutionApi.resume(projectId, pipelineId, executionId, {
        approvedIds,
        rejectedIds,
      })
      await fetchExecution()
    } catch (e: any) {
      setError(e.message || 'Failed to resume execution')
    } finally {
      setResuming(false)
    }
  }

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    if (!execution) return
    const allIds = getRecommendationIds(execution)
    setSelectedIds(new Set(allIds))
  }

  if (loading) return <Spinner label="Loading execution..." />
  if (error) return <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
  if (!execution) return <MessageBar intent="warning"><MessageBarBody>Execution not found</MessageBarBody></MessageBar>

  const pendingStep = execution.stepResults?.find((s) => s.status === 'waiting_for_approval')
  const recommendations = getRecommendations(execution)
  const hasFinalOutput = execution.finalOutput && execution.finalOutput['$schema']

  return (
    <div className={classes.root}>
      <div className={classes.header}>
        <Button
          icon={<ArrowLeft24Regular />}
          appearance="subtle"
          onClick={() => navigate(-1)}
        />
        <Text size={600} weight="semibold">Pipeline Run</Text>
        {getStatusBadge(execution.status)}
      </div>

      <Card>
        <CardHeader
          header={<Text weight="semibold">Execution: {execution.executionId}</Text>}
          description={`Started: ${new Date(execution.startedAt).toLocaleString()}${execution.endedAt ? ` | Ended: ${new Date(execution.endedAt).toLocaleString()}` : ''}`}
        />
      </Card>

      {execution.error && (
        <MessageBar intent="error">
          <MessageBarBody>{execution.error}</MessageBarBody>
        </MessageBar>
      )}

      <Text size={500} weight="semibold">Steps</Text>
      <div className={classes.stepList}>
        {execution.stepResults?.map((step) => (
          <Card
            key={step.nodeId}
            className={`${classes.stepCard} ${
              step.status === 'completed' ? classes.stepCompleted :
              step.status === 'failed' || step.status === 'timed_out' ? classes.stepFailed :
              step.status === 'waiting_for_approval' ? classes.stepWaiting :
              classes.stepRunning
            }`}
          >
            <div className={classes.stepHeader}>
              <Text weight="semibold">{step.nodeId}</Text>
              {getStatusBadge(step.status)}
            </div>
            {step.error && (
              <Text size={200} style={{ color: tokens.colorPaletteRedForeground1, marginTop: 4 }}>
                {step.error}
              </Text>
            )}
          </Card>
        ))}
      </div>

      {pendingStep && recommendations.length > 0 && (
        <>
          <Divider />
          <Text size={500} weight="semibold">Approval Required</Text>
          <div className={classes.approvalSection}>
            <Text>
              Select recommendations to approve. Unselected items will be rejected.
            </Text>
            <Button appearance="subtle" size="small" onClick={selectAll}>
              Select All ({recommendations.length})
            </Button>
            {recommendations.map((rec: any) => (
              <div key={rec.id} className={classes.recommendationRow}>
                <Checkbox
                  checked={selectedIds.has(rec.id)}
                  onChange={() => toggleSelection(rec.id)}
                />
                <div style={{ flex: 1 }}>
                  <Text weight="semibold">{rec.volume_name || rec.id}</Text>
                  <Text size={200} style={{ display: 'block' }}>
                    {rec.action} — {rec.justification}
                  </Text>
                </div>
                <Text size={200}>
                  ${rec.estimated_monthly_savings_usd}/mo
                </Text>
                <Badge
                  appearance="outline"
                  color={rec.risk_level === 'high' ? 'danger' : rec.risk_level === 'medium' ? 'warning' : 'success'}
                >
                  {rec.risk_level}
                </Badge>
              </div>
            ))}
            <div className={classes.approvalActions}>
              <Button
                appearance="primary"
                onClick={handleApprove}
                disabled={selectedIds.size === 0 || resuming}
              >
                {resuming ? 'Resuming...' : `Approve Selected (${selectedIds.size})`}
              </Button>
              <Button
                appearance="secondary"
                onClick={() => {
                  setSelectedIds(new Set())
                  handleApprove()
                }}
                disabled={resuming}
              >
                Reject All
              </Button>
            </div>
          </div>
        </>
      )}

      {hasFinalOutput && (
        <div className={classes.outputSection}>
          <Divider />
          <Text size={500} weight="semibold" style={{ marginTop: 16, display: 'block' }}>
            Pipeline Output
          </Text>
          <PipelineOutputRenderer data={execution.finalOutput!} />
        </div>
      )}
    </div>
  )
}

function getRecommendations(execution: Execution): any[] {
  if (!execution.stepResults) return []
  for (const step of execution.stepResults) {
    const output = step.output || step.results
    if (output && Array.isArray(output.recommendations)) {
      return output.recommendations
    }
  }
  return []
}

function getRecommendationIds(execution: Execution): string[] {
  return getRecommendations(execution).map((r: any) => r.id).filter(Boolean)
}
