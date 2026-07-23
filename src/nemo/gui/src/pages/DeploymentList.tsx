import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card,
  CardHeader,
  Text,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  Spinner,
  MessageBar,
  MessageBarBody,
  Badge,
  Button,
  tokens,
} from '@fluentui/react-components'
import {
  ChevronDown24Regular,
  ChevronRight24Regular,
} from '@fluentui/react-icons'
import { deploymentApi, Deployment } from '../services/api'
import styles from '../styles/deploymentList.module.css'

export default function DeploymentList() {
  const navigate = useNavigate()
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedDeployments, setExpandedDeployments] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadData()
    // Refresh every 30 seconds to get updated health status
    const interval = setInterval(loadData, 30000)
    return () => clearInterval(interval)
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await deploymentApi.list()
      // Ensure data is always an array
      setDeployments(Array.isArray(data) ? data : [])
    } catch (err: any) {
      setError(err.message || 'Failed to load deployments')
      // Set empty array on error to prevent undefined errors
      setDeployments([])
    } finally {
      setLoading(false)
    }
  }

  const toggleDeploymentExpand = (deploymentId: string) => {
    const newExpanded = new Set(expandedDeployments)
    if (newExpanded.has(deploymentId)) {
      newExpanded.delete(deploymentId)
    } else {
      newExpanded.add(deploymentId)
    }
    setExpandedDeployments(newExpanded)
  }

  const getStatusBadge = (status: string | undefined) => {
    switch (status) {
      case 'healthy':
        return <Badge appearance="filled" color="success">Healthy</Badge>
      case 'unhealthy':
        return <Badge appearance="filled" color="danger">Unhealthy</Badge>
      case 'unknown':
        return <Badge appearance="outline">Unknown</Badge>
      default:
        return <Badge appearance="outline">Unknown</Badge>
    }
  }

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return 'N/A'
    return new Date(dateStr).toLocaleString()
  }

  const getTimeSince = (dateStr: string | undefined) => {
    if (!dateStr) return 'Never'
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffSecs = Math.floor(diffMs / 1000)
    const diffMins = Math.floor(diffSecs / 60)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffSecs < 60) return `${diffSecs}s ago`
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    return `${diffDays}d ago`
  }

  if (loading && deployments.length === 0) {
    return (
      <div className={styles.loadingContainer}>
        <Spinner label="Loading deployments..." />
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Deployments</h1>
        <Button onClick={loadData} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Deployment Registry</Text>} />
        {deployments.length === 0 ? (
          <Text>No deployments registered</Text>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell style={{ width: '40px' }}></TableHeaderCell>
                <TableHeaderCell>Deployment ID</TableHeaderCell>
                <TableHeaderCell>Region</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Endpoint</TableHeaderCell>
                <TableHeaderCell>Last Health Check</TableHeaderCell>
                <TableHeaderCell>Capacity</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deployments.map((deployment) => {
                const isExpanded = expandedDeployments.has(deployment.id)
                return (
                  <>
                    <TableRow key={deployment.id}>
                      <TableCell>
                        <Button
                          appearance="subtle"
                          icon={isExpanded ? <ChevronDown24Regular /> : <ChevronRight24Regular />}
                          onClick={() => toggleDeploymentExpand(deployment.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <Text
                          weight="semibold"
                          style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }}
                          onClick={() => navigate(`/deployments/${deployment.id}`)}
                        >
                          {deployment.id}
                        </Text>
                      </TableCell>
                      <TableCell>{deployment.region}</TableCell>
                      <TableCell>{getStatusBadge(deployment.status)}</TableCell>
                      <TableCell>
                        <Text style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                          {deployment.endpoint}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <div>
                          <Text>{getTimeSince(deployment.last_health_check)}</Text>
                          {deployment.last_health_check && (
                            <Text className={styles.subText}>
                              {formatDate(deployment.last_health_check)}
                            </Text>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {deployment.capacity ? (
                          <div>
                            {deployment.capacity.max_buckets && (
                              <Text>Buckets: {deployment.capacity.max_buckets}</Text>
                            )}
                            {deployment.capacity.max_storage_gb && (
                              <Text className={styles.subText}>
                                Storage: {deployment.capacity.max_storage_gb} GB
                              </Text>
                            )}
                          </div>
                        ) : (
                          <Text>Unlimited</Text>
                        )}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={7}>
                          <div className={styles.expandableContent}>
                            <div className={styles.detailsGrid}>
                              <div>
                                <Text className={styles.label}>Deployment ID:</Text>
                                <Text>{deployment.id}</Text>
                              </div>
                              <div>
                                <Text className={styles.label}>Region:</Text>
                                <Text>{deployment.region}</Text>
                              </div>
                              <div>
                                <Text className={styles.label}>Endpoint:</Text>
                                <Text style={{ fontFamily: 'monospace' }}>{deployment.endpoint}</Text>
                              </div>
                              <div>
                                <Text className={styles.label}>Status:</Text>
                                {getStatusBadge(deployment.status)}
                              </div>
                              <div>
                                <Text className={styles.label}>Registered:</Text>
                                <Text>{formatDate(deployment.registered_at || deployment.created_at)}</Text>
                              </div>
                              <div>
                                <Text className={styles.label}>Last Health Check:</Text>
                                <Text>
                                  {deployment.last_health_check
                                    ? `${formatDate(deployment.last_health_check)} (${getTimeSince(deployment.last_health_check)})`
                                    : 'Never'}
                                </Text>
                              </div>
                              {deployment.capacity && (
                                <>
                                  {deployment.capacity.max_buckets && (
                                    <div>
                                      <Text className={styles.label}>Max Buckets:</Text>
                                      <Text>{deployment.capacity.max_buckets}</Text>
                                    </div>
                                  )}
                                  {deployment.capacity.max_storage_gb && (
                                    <div>
                                      <Text className={styles.label}>Max Storage:</Text>
                                      <Text>{deployment.capacity.max_storage_gb} GB</Text>
                                    </div>
                                  )}
                                </>
                              )}
                              {deployment.capabilities && deployment.capabilities.length > 0 && (
                                <div>
                                  <Text className={styles.label}>Capabilities:</Text>
                                  <div>
                                    {deployment.capabilities.map((cap, idx) => (
                                      <Badge key={idx} appearance="outline" style={{ marginRight: '4px' }}>
                                        {cap}
                                      </Badge>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  )
}

