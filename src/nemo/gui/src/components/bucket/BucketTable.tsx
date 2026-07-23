import { useState, useEffect } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
  TableHeader,
  TableHeaderCell,
  TableCellLayout,
  Button,
  Text,
  Spinner,
  Badge,
  Tooltip,
} from '@fluentui/react-components'
import {
  Edit24Regular,
  Delete24Regular,
  FolderOpen24Regular,
} from '@fluentui/react-icons'
import { Bucket, datasourceApi, BucketRoutingResponse, deploymentApi, Deployment, DataSourceMountHealth } from '../../services/api'
import styles from '../../styles/bucketTable.module.css'

interface BucketTableProps {
  buckets: Bucket[]
  projectId: string
  onEdit: (bucket: Bucket) => void
  onDelete: (bucketName: string) => void
  onExplore?: (bucketName: string) => void
  mountHealthByName?: Record<string, DataSourceMountHealth | undefined>
  onRepairMount?: (bucketName: string) => void
}

export function BucketTable({ buckets, projectId, onEdit, onDelete, onExplore, mountHealthByName, onRepairMount }: BucketTableProps) {
  const [routingInfo, setRoutingInfo] = useState<Map<string, BucketRoutingResponse>>(new Map())
  const [loadingRouting, setLoadingRouting] = useState<Set<string>>(new Set())
  const [deployments, setDeployments] = useState<Map<string, Deployment>>(new Map())

  useEffect(() => {
    const fetchDeployments = async () => {
      try {
        const deploymentList = await deploymentApi.list()
        const deploymentMap = new Map<string, Deployment>()
        deploymentList.forEach(deployment => {
          deploymentMap.set(deployment.id, deployment)
        })
        setDeployments(deploymentMap)
      } catch (error) {
        console.error('Failed to fetch deployments:', error)
      }
    }
    fetchDeployments()
  }, [])

  useEffect(() => {
    const fetchRoutingInfo = async () => {
      const bucketsToFetch = buckets.filter(
        bucket => !routingInfo.has(bucket.name) && !loadingRouting.has(bucket.name)
      )
      
      for (const bucket of bucketsToFetch) {
        setLoadingRouting(prev => new Set(prev).add(bucket.name))
        try {
          const routing = await datasourceApi.getRouting(projectId, bucket.name)
          setRoutingInfo(prev => new Map(prev).set(bucket.name, routing))
        } catch (error: any) {
          console.debug(`No routing info for bucket ${bucket.name}:`, error.message)
        } finally {
          setLoadingRouting(prev => {
            const next = new Set(prev)
            next.delete(bucket.name)
            return next
          })
        }
      }
    }
    fetchRoutingInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, projectId])

  /** Deployment routing regions only — not NFS mount health (see Mount column). */
  const getDeploymentsDisplay = (bucketName: string) => {
    const routing = routingInfo.get(bucketName)
    if (!routing || !routing.deployments || routing.deployments.length === 0) {
      return <Text>Not assigned</Text>
    }

    const regions = new Set<string>()
    routing.deployments.forEach((deployment) => {
      const deploymentInfo = deployments.get(deployment.deployment_id)
      const region = deploymentInfo?.region || deployment.deployment_id
      regions.add(region)
    })

    if (regions.size === 0) {
      return <Text>No deployments</Text>
    }

    const regionsText = Array.from(regions).sort((a, b) => a.localeCompare(b)).join(', ')

    return (
      <Tooltip
        content="Regions where this volume is routed for storage sync. This is not the same as NFS mount readiness — use Mount for ONTAP preflight / mount health."
        relationship="description"
      >
        <Text>{regionsText}</Text>
      </Tooltip>
    )
  }

  const mountHealthTooltip = (mh: DataSourceMountHealth): string => {
    const parts: string[] = []
    if (mh.last_checked_at) {
      try {
        parts.push(`Last checked: ${new Date(mh.last_checked_at).toLocaleString()}`)
      } catch {
        parts.push(`Last checked: ${mh.last_checked_at}`)
      }
    }
    if (mh.blocking?.length) parts.push(`Blocking: ${mh.blocking.join('; ')}`)
    if (mh.warnings?.length) parts.push(`Warnings: ${mh.warnings.join('; ')}`)
    return parts.join(' · ') || 'Mount health snapshot from datasource service'
  }

  if (buckets.length === 0) {
    return <Text>No buckets in this project</Text>
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Region</TableHeaderCell>
          <TableHeaderCell>Protocol</TableHeaderCell>
          <TableHeaderCell>Volume Type</TableHeaderCell>
          <TableHeaderCell>
            <Tooltip
              content="ONTAP NFS preflight / mount readiness stored on the volume (not deployment routing)."
              relationship="description"
            >
              <span>Mount</span>
            </Tooltip>
          </TableHeaderCell>
          <TableHeaderCell>
            <Tooltip
              content="Which deployments host storage routing for this volume."
              relationship="description"
            >
              <span>Deployments</span>
            </Tooltip>
          </TableHeaderCell>
          <TableHeaderCell>Actions</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {buckets.map((bucket) => (
          <TableRow key={bucket.name}>
            <TableCell>
              <TableCellLayout>
                <Text weight="semibold">{bucket.name}</Text>
              </TableCellLayout>
            </TableCell>
            <TableCell>{bucket.region}</TableCell>
            <TableCell>{bucket.protocol}</TableCell>
            <TableCell>{bucket.volume_info.type}</TableCell>
            <TableCell>
              {(() => {
                const mh = mountHealthByName?.[bucket.name]
                if (!mh) {
                  return (
                    <Tooltip
                      content="No mount health snapshot yet. Run ONTAP preflight from Repair (unhealthy volumes) or register/repair flows; background refresh may populate this for explorer-registered volumes."
                      relationship="description"
                    >
                      <Badge appearance="outline" color="informative">
                        Not checked
                      </Badge>
                    </Tooltip>
                  )
                }
                const label =
                  mh.status === 'healthy' ? 'Healthy' : mh.status === 'unhealthy' ? 'Unhealthy' : 'Unknown'
                const color =
                  mh.status === 'healthy' ? 'success' : mh.status === 'unhealthy' ? 'danger' : 'informative'
                return (
                  <Tooltip content={mountHealthTooltip(mh)} relationship="description">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <Badge appearance="outline" color={color as 'success' | 'danger' | 'informative'}>
                        {label}
                      </Badge>
                      {mh.status === 'unhealthy' && onRepairMount && (
                        <Button
                          size="small"
                          appearance="secondary"
                          onClick={() => onRepairMount(bucket.name)}
                        >
                          Repair
                        </Button>
                      )}
                    </div>
                  </Tooltip>
                )
              })()}
            </TableCell>
            <TableCell>
              {loadingRouting.has(bucket.name) ? (
                <Spinner size="tiny" />
              ) : (
                getDeploymentsDisplay(bucket.name)
              )}
            </TableCell>
            <TableCell>
              <div className={styles.actionButtons}>
                <Button
                  appearance="subtle"
                  icon={<FolderOpen24Regular />}
                  onClick={() => onExplore?.(bucket.name)}
                  title="Explore Volume"
                />
                <Button
                  appearance="subtle"
                  icon={<Edit24Regular />}
                  onClick={() => onEdit(bucket)}
                  title="Edit Bucket"
                />
                <Button
                  appearance="subtle"
                  icon={<Delete24Regular />}
                  onClick={() => onDelete(bucket.name)}
                  title="Delete Bucket"
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
