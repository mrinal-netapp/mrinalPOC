import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Spinner,
  MessageBar,
  MessageBarBody,
  Card,
  CardHeader,
  Text,
  Button,
  Badge,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
} from '@fluentui/react-components'
import {
  ArrowLeft24Regular,
  CheckmarkCircle24Filled,
  ErrorCircle24Filled,
  Warning24Filled,
} from '@fluentui/react-icons'
import { projectApi, datasourceApi, deploymentApi, BucketRoutingResponse, Deployment, Bucket, DataSourceItem } from '../services/api'

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  title: {
    fontSize: '24px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  card: {
    padding: '16px',
  },
  healthBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
})

export default function RayExplorer() {
  const styles = useStyles()
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [project, setProject] = useState<any>(null)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [routingInfo, setRoutingInfo] = useState<Record<string, BucketRoutingResponse>>({})
  const [deployments, setDeployments] = useState<Record<string, Deployment>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (projectId) {
      loadData()
    }
  }, [projectId])

  const loadData = async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)

      const [projectData, dataSources] = await Promise.all([
        projectApi.get(projectId),
        datasourceApi.list(projectId, { type: 'volume' }),
      ])

      setProject(projectData)
      const mappedBuckets: Bucket[] = dataSources.map((ds: DataSourceItem) => ({
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
      setBuckets(mappedBuckets)

      // Load routing info for each bucket
      const routingPromises = mappedBuckets.map(async (bucket) => {
        try {
          const routing = await datasourceApi.getRouting(projectId, bucket.name)
          return { bucketName: bucket.name, routing }
        } catch (err) {
          return { bucketName: bucket.name, routing: null }
        }
      })

      const routingResults = await Promise.all(routingPromises)
      
      const routingMap: Record<string, BucketRoutingResponse> = {}
      const deploymentIds = new Set<string>()

      routingResults.forEach(({ bucketName, routing }) => {
        if (routing) {
          routingMap[bucketName] = routing
          routing.deployments.forEach((d) => deploymentIds.add(d.deployment_id))
        }
      })

      setRoutingInfo(routingMap)

      // Load deployment details
      const deploymentPromises = Array.from(deploymentIds).map(async (id) => {
        try {
          const deployment = await deploymentApi.get(id)
          return { id, deployment }
        } catch (err) {
          return { id, deployment: null }
        }
      })

      const deploymentResults = await Promise.all(deploymentPromises)
      
      const deploymentMap: Record<string, Deployment> = {}
      deploymentResults.forEach(({ id, deployment }) => {
        if (deployment) {
          deploymentMap[id] = deployment
        }
      })

      setDeployments(deploymentMap)
    } catch (err: any) {
      setError(err.message || 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const getHealthIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return <CheckmarkCircle24Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />
      case 'unhealthy':
        return <ErrorCircle24Filled style={{ color: tokens.colorPaletteRedForeground1 }} />
      default:
        return <Warning24Filled style={{ color: tokens.colorPaletteYellowForeground1 }} />
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading ray information..." />
      </div>
    )
  }

  if (error) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error}</MessageBarBody>
      </MessageBar>
    )
  }

  // Collect all unique deployments across all buckets
  const allDeployments = new Set<string>()
  Object.values(routingInfo).forEach((routing) => {
    routing.deployments.forEach((d) => allDeployments.add(d.deployment_id))
  })

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft24Regular />}
          onClick={() => navigate(`/projects/${projectId}`)}
        >
          Back
        </Button>
        <h1 className={styles.title}>Rays Supporting {project?.name}</h1>
      </div>

      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Deployments (Rays)</Text>} />
        {allDeployments.size === 0 ? (
          <Text>No deployments found for this project</Text>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Deployment ID</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Endpoint</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Buckets</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from(allDeployments).map((deploymentId) => {
                const deployment = deployments[deploymentId]
                const bucketsForDeployment = Object.entries(routingInfo)
                  .filter(([_, routing]) =>
                    routing.deployments.some((d) => d.deployment_id === deploymentId)
                  )
                  .map(([bucketName]) => bucketName)

                return (
                  <TableRow key={deploymentId}>
                    <TableCell>
                      <Text weight="semibold">{deploymentId}</Text>
                    </TableCell>
                    <TableCell>{deployment?.region || 'N/A'}</TableCell>
                    <TableCell>
                      <Text size={200}>{deployment?.endpoint || 'N/A'}</Text>
                    </TableCell>
                    <TableCell>
                      <Badge
                        appearance="filled"
                        color={
                          deployment?.status === 'healthy'
                            ? 'success'
                            : deployment?.status === 'unhealthy'
                            ? 'danger'
                            : 'warning'
                        }
                      >
                        {deployment?.status || 'unknown'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {bucketsForDeployment.map((bucketName) => (
                          <Badge key={bucketName} appearance="outline">
                            {bucketName}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Bucket Routing Details</Text>} />
        {buckets.length === 0 ? (
          <Text>No buckets in this project</Text>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {buckets.map((bucket) => {
              const routing = routingInfo[bucket.name]
              if (!routing) {
                return (
                  <div key={bucket.name} style={{ padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
                    <Text weight="semibold">{bucket.name}</Text>
                    <Text size={200} style={{ color: tokens.colorNeutralForeground2 }}>
                      No routing information available
                    </Text>
                  </div>
                )
              }

              return (
                <div
                  key={bucket.name}
                  style={{
                    padding: '12px',
                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                    borderRadius: tokens.borderRadiusMedium,
                  }}
                >
                  <Text weight="semibold" style={{ marginBottom: '8px' }}>
                    {bucket.name}
                  </Text>
                  <Text size={200} style={{ marginBottom: '8px', color: tokens.colorNeutralForeground2 }}>
                    Routing Strategy: {routing.routing_strategy}
                  </Text>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {routing.deployments.map((deployment) => (
                      <div
                        key={deployment.deployment_id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '4px 8px',
                          backgroundColor: tokens.colorNeutralBackground2,
                          borderRadius: tokens.borderRadiusSmall,
                        }}
                      >
                        {getHealthIcon(deployment.health_status)}
                        <Text size={200}>
                          {deployment.deployment_id} ({deployment.role}) - Priority: {deployment.priority}
                        </Text>
                        <Badge appearance="outline" size="small">
                          {deployment.endpoint}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

