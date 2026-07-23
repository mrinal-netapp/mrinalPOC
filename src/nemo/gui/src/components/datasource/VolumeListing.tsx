import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  makeStyles,
  Card,
  Text,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
  Badge,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
} from '@fluentui/react-components'
import { Add24Regular } from '@fluentui/react-icons'
import { datasourceApi, CreateDataSourceRequest, DataSourceItem, Bucket } from '../../services/api'
import { useProject } from '../../hooks/useProject'
import { BucketForm } from '../bucket/BucketForm'
import { BucketTable } from '../bucket/BucketTable'
import { BucketFormData, initialBucketFormData } from '../../types/bucket'
import { formDataToCreateRequest, formDataToUpdateRequest, bucketToFormData } from '../../utils/bucketForm'
import { useToast } from '../../contexts/ToastContext'
import { VolumeExplorerDialog } from '../bucket/VolumeExplorerDialog'

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px',
    flexWrap: 'wrap',
  },
})

export interface VolumeListingProps {
  projectId: string
  initialPrefill?: BucketFormData
  refreshKey?: number
}

export function VolumeListing({ projectId, initialPrefill, refreshKey }: VolumeListingProps) {
  const styles = useStyles()
  const { project, buckets, loading, error, reload } = useProject(projectId)
  const { showToast } = useToast()

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingBucket, setEditingBucket] = useState<Bucket | null>(null)
  const [formData, setFormData] = useState<BucketFormData>(initialBucketFormData)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [bucketToDelete, setBucketToDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [volumeSources, setVolumeSources] = useState<DataSourceItem[]>([])

  const refreshVolumeSources = useCallback(async () => {
    if (!projectId) return
    try {
      const volumes = await datasourceApi.list(projectId, { type: 'volume', limit: 500 })
      setVolumeSources(volumes)
    } catch {
      setVolumeSources([])
    }
  }, [projectId])

  useEffect(() => {
    refreshVolumeSources()
  }, [refreshVolumeSources])

  useEffect(() => {
    if (refreshKey !== undefined && refreshKey > 0) {
      reload()
      refreshVolumeSources()
    }
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectId) return
    const intervalMs = 15 * 60 * 1000
    const handle = window.setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      try {
        const vols = await datasourceApi.list(projectId, { type: 'volume', limit: 500 })
        const ontap = vols.filter((v) => v.metadata?.source === 'ontap-connector-explorer')
        for (const v of ontap.slice(0, 40)) {
          try {
            await datasourceApi.preflight(projectId, v.id)
          } catch {
            /* ignore per-volume failures */
          }
        }
      } finally {
        await refreshVolumeSources()
      }
    }, intervalMs)
    return () => window.clearInterval(handle)
  }, [projectId, refreshVolumeSources])

  // Handle initialPrefill (from ONTAP connector explorer single-volume flow)
  useEffect(() => {
    if (!initialPrefill || typeof initialPrefill.name !== 'string') return
    setFormData({ ...initialBucketFormData, ...initialPrefill })
    setSubmitError(null)
    setCreateDialogOpen(true)
  }, [initialPrefill])

  const volumeIds = useMemo(() => {
    const m: Record<string, string> = {}
    volumeSources.forEach((v) => {
      m[v.name] = v.id
    })
    return m
  }, [volumeSources])

  const mountHealthByName = useMemo(() => {
    const m: Record<string, (typeof volumeSources)[0]['mount_health']> = {}
    volumeSources.forEach((v) => {
      m[v.name] = v.mount_health
    })
    return m
  }, [volumeSources])

  const hasOntapExplorerVolumes = useMemo(
    () => volumeSources.some((v) => v.metadata?.source === 'ontap-connector-explorer'),
    [volumeSources]
  )

  const [repairDialogOpen, setRepairDialogOpen] = useState(false)
  const [repairBucketName, setRepairBucketName] = useState<string | null>(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const [repairMessage, setRepairMessage] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)

  const [explorerOpen, setExplorerOpen] = useState(false)
  const [explorerVolume, setExplorerVolume] = useState<{ name: string; id: string } | null>(null)

  const openCreateDialog = () => {
    setFormData(initialBucketFormData)
    setSubmitError(null)
    setCreateDialogOpen(true)
  }

  const openEditDialog = (bucket: Bucket) => {
    setEditingBucket(bucket)
    setFormData(bucketToFormData(bucket))
    setSubmitError(null)
    setEditDialogOpen(true)
  }

  const handleCreate = async (data: BucketFormData) => {
    if (!projectId) return

    try {
      setSubmitting(true)
      setSubmitError(null)
      const request = formDataToCreateRequest(data)

      const dsRequest: CreateDataSourceRequest = {
        name: request.name,
        type: 'volume',
        volume_config: {
          region: request.region,
          volume_info: request.volume_info,
          auth_info: request.auth_info,
          protocol: request.protocol,
          deployment_config: request.deployment_config,
        },
        metadata: request.metadata,
      }

      await datasourceApi.create(projectId, dsRequest)
      setCreateDialogOpen(false)
      setFormData(initialBucketFormData)
      await reload()
      await refreshVolumeSources()
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to create volume')
      throw err
    } finally {
      setSubmitting(false)
    }
  }

  const handleUpdate = async (data: BucketFormData) => {
    if (!projectId || !editingBucket) return

    try {
      setSubmitting(true)
      setSubmitError(null)
      const request = formDataToUpdateRequest(data)
      const dsId = volumeIds[editingBucket.name]

      if (dsId) {
        await datasourceApi.update(projectId, dsId, {
          volume_config: {
            region: request.region,
            volume_info: request.volume_info,
            auth_info: request.auth_info,
            protocol: request.protocol,
            deployment_config: request.deployment_config,
          },
          metadata: request.metadata,
        })
      }

      setEditDialogOpen(false)
      setEditingBucket(null)
      setFormData(initialBucketFormData)
      await reload()
      await refreshVolumeSources()
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to update volume')
      throw err
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteClick = (bucketName: string) => {
    setBucketToDelete(bucketName)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!projectId || !bucketToDelete) return

    try {
      setDeleting(true)
      setSubmitError(null)
      const dsId = volumeIds[bucketToDelete]

      if (dsId) {
        await datasourceApi.delete(projectId, dsId)
      }

      await reload()
      await refreshVolumeSources()
      setDeleteDialogOpen(false)
      setBucketToDelete(null)
      showToast(`Volume "${bucketToDelete}" deleted successfully`, 'success')
    } catch (err: any) {
      setSubmitError(err.response?.data?.error || err.message || 'Failed to delete volume')
      showToast(err.message || 'Failed to delete volume', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const volumeCount = buckets.length

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '48px' }}>
        <Spinner label="Loading volumes..." />
      </div>
    )
  }

  if (error && !project) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{error || 'Project not found'}</MessageBarBody>
      </MessageBar>
    )
  }

  return (
    <>
      <div className={styles.toolbar}>
        <Badge appearance="outline" color="informative">{volumeCount} volume{volumeCount !== 1 ? 's' : ''}</Badge>
        {hasOntapExplorerVolumes && (
          <Button
            appearance="secondary"
            disabled={bulkBusy || !projectId}
            onClick={async () => {
              if (!projectId) return
              setBulkBusy(true)
              try {
                const plan = await datasourceApi.bulkPreflight(projectId, {
                  filter: { source: 'ontap-connector-explorer' },
                })
                const fixable = plan.results.filter(
                  (r: any) => r.would_change && !(r.blocking?.length) && r.id
                )
                if (fixable.length === 0) {
                  showToast('No ONTAP volumes need endpoint updates (or all still blocked).', 'info')
                  return
                }
                const ok = window.confirm(
                  `Apply resolved endpoints for ${fixable.length} volume(s)? This updates volume_info and triggers storage sync.`
                )
                if (!ok) return
                const out = await datasourceApi.bulkApply(projectId, {
                  ids: fixable.map((r: any) => r.id),
                })
                const failed = out.outcomes?.filter((o: any) => !o.ok) || []
                showToast(
                  failed.length
                    ? `Bulk apply: ${out.outcomes?.length - failed.length} ok, ${failed.length} failed`
                    : `Bulk apply completed (${out.outcomes?.length || 0} volumes)`,
                  failed.length ? 'warning' : 'success'
                )
                await reload()
                await refreshVolumeSources()
              } catch (e: any) {
                showToast(e?.message || 'Bulk repair failed', 'error')
              } finally {
                setBulkBusy(false)
              }
            }}
          >
            {bulkBusy ? 'Repairing…' : 'Repair ONTAP volumes'}
          </Button>
        )}
        <Button appearance="primary" icon={<Add24Regular />} onClick={openCreateDialog}>
          Add Volume
        </Button>
      </div>

      {(error || submitError) && (
        <MessageBar intent="error">
          <MessageBarBody>{error || submitError}</MessageBarBody>
        </MessageBar>
      )}

      <Card>
        <BucketTable
          buckets={buckets}
          projectId={projectId}
          onEdit={openEditDialog}
          onDelete={handleDeleteClick}
          onExplore={(name) => {
            const id = volumeIds[name]
            if (!id) {
              showToast('Volume datasource not found — try refreshing the page.', 'error')
              return
            }
            setExplorerVolume({ name, id })
            setExplorerOpen(true)
          }}
          mountHealthByName={mountHealthByName}
          onRepairMount={(name) => {
            setRepairBucketName(name)
            setRepairMessage(null)
            setRepairDialogOpen(true)
          }}
        />
      </Card>

      <BucketForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={handleCreate}
        onCancel={() => setCreateDialogOpen(false)}
        initialData={formData}
        submitting={submitting}
        title="Register Volume"
        submitLabel="Create"
      />

      <BucketForm
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onSubmit={handleUpdate}
        onCancel={() => {
          setEditDialogOpen(false)
          setEditingBucket(null)
        }}
        initialData={formData}
        editingBucket={editingBucket}
        submitting={submitting}
        title={`Edit Volume: ${editingBucket?.name}`}
        submitLabel="Update"
      />

      <Dialog open={deleteDialogOpen} onOpenChange={(_, data) => {
        setDeleteDialogOpen(data.open)
        if (!data.open) {
          setBucketToDelete(null)
        }
      }}>
        <DialogSurface>
          <DialogTitle>Delete Volume</DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text>
                Are you sure you want to delete volume "{bucketToDelete}"? This action cannot be undone.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => setDeleteDialogOpen(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={handleDeleteConfirm}
                disabled={deleting}
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={repairDialogOpen} onOpenChange={(_, data) => {
        setRepairDialogOpen(data.open)
        if (!data.open) setRepairBucketName(null)
      }}>
        <DialogSurface>
          <DialogTitle>Mount repair — {repairBucketName}</DialogTitle>
          <DialogBody>
            <DialogContent>
              <Text block style={{ marginBottom: '12px' }}>
                Re-run ONTAP NFS preflight (same checks as Register Volume). Updates stored mount health; if you change the
                endpoint in Edit Volume, storage-manager will replace the PV on the next sync when safe.
              </Text>
              {repairMessage && (
                <MessageBar intent="info" style={{ marginBottom: '8px' }}>
                  <MessageBarBody>{repairMessage}</MessageBarBody>
                </MessageBar>
              )}
              <Button
                appearance="primary"
                disabled={repairBusy || !repairBucketName || !projectId}
                onClick={async () => {
                  if (!projectId || !repairBucketName) return
                  const id = volumeIds[repairBucketName]
                  if (!id) {
                    setRepairMessage('Volume id not found — refresh the page.')
                    return
                  }
                  setRepairBusy(true)
                  setRepairMessage(null)
                  try {
                    const r = await datasourceApi.preflight(projectId, id)
                    const mh = r.mount_health
                    setRepairMessage(
                      mh
                        ? `Status: ${mh.status}. ${(mh.blocking || []).join('; ') || (mh.warnings || []).join('; ') || 'ok'}`
                        : 'Preflight completed.'
                    )
                    await refreshVolumeSources()
                  } catch (e: any) {
                    setRepairMessage(e?.response?.data?.error || e?.message || 'Preflight failed')
                  } finally {
                    setRepairBusy(false)
                  }
                }}
              >
                {repairBusy ? 'Running…' : 'Re-check mount (preflight)'}
              </Button>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setRepairDialogOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {explorerVolume && projectId && (
        <VolumeExplorerDialog
          open={explorerOpen}
          onOpenChange={(open) => {
            setExplorerOpen(open)
            if (!open) setExplorerVolume(null)
          }}
          projectId={projectId}
          volumeId={explorerVolume.id}
          volumeName={explorerVolume.name}
        />
      )}
    </>
  )
}
