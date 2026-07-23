import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import {
  makeStyles,
  tokens,
  Card,
  CardHeader,
  Text,
  Spinner,
  MessageBar,
  MessageBarBody,
  Badge,
} from '@fluentui/react-components'
import { deploymentApi, Deployment } from '../services/api'

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
  card: {
    marginTop: '16px',
  },
  detailsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
    gap: '16px',
    padding: '16px',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  label: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    fontWeight: 600,
  },
  value: {
    fontSize: '14px',
    color: tokens.colorNeutralForeground1,
  },
})

export default function DeploymentDetail() {
  const styles = useStyles()
  const { deploymentId } = useParams<{ deploymentId: string }>()
  const [deployment, setDeployment] = useState<Deployment | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (deploymentId) {
      loadDeployment()
    }
  }, [deploymentId])

  const loadDeployment = async () => {
    if (!deploymentId) return

    try {
      setLoading(true)
      setError(null)
      const data = await deploymentApi.get(deploymentId)
      setDeployment(data)
    } catch (err: any) {
      setError(err.message || 'Failed to load deployment')
    } finally {
      setLoading(false)
    }
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

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading deployment..." />
      </div>
    )
  }

  if (error || !deployment) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error || 'Deployment not found'}</MessageBarBody>
      </MessageBar>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Deployment: {deployment.id}</h1>
      </div>

      <Card className={styles.card}>
        <CardHeader header={<Text weight="semibold">Deployment Details</Text>} />
        <div className={styles.detailsGrid}>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Deployment ID</Text>
            <Text className={styles.value}>{deployment.id}</Text>
          </div>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Region</Text>
            <Text className={styles.value}>{deployment.region}</Text>
          </div>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Status</Text>
            {getStatusBadge(deployment.status)}
          </div>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Endpoint</Text>
            <Text className={styles.value} style={{ fontFamily: 'monospace', fontSize: '12px' }}>
              {deployment.endpoint}
            </Text>
          </div>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Registered</Text>
            <Text className={styles.value}>
              {formatDate(deployment.registered_at || deployment.created_at)}
            </Text>
          </div>
          <div className={styles.detailItem}>
            <Text className={styles.label}>Last Health Check</Text>
            <Text className={styles.value}>
              {formatDate(deployment.last_health_check)}
            </Text>
          </div>
          {deployment.capacity && (
            <>
              {deployment.capacity.max_buckets && (
                <div className={styles.detailItem}>
                  <Text className={styles.label}>Max Buckets</Text>
                  <Text className={styles.value}>{deployment.capacity.max_buckets}</Text>
                </div>
              )}
              {deployment.capacity.max_storage_gb && (
                <div className={styles.detailItem}>
                  <Text className={styles.label}>Max Storage</Text>
                  <Text className={styles.value}>{deployment.capacity.max_storage_gb} GB</Text>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {deployment.capabilities && deployment.capabilities.length > 0 && (
        <Card className={styles.card}>
          <CardHeader header={<Text weight="semibold">Capabilities</Text>} />
          <div style={{ padding: '16px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {deployment.capabilities.map((cap, idx) => (
              <Badge key={idx} appearance="outline">
                {cap}
              </Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

