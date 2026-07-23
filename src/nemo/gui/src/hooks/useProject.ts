import { useState, useEffect } from 'react'
import { projectApi, datasourceApi, Project, DataSourceItem, Bucket } from '../services/api'

/**
 * Maps a DataSource (volume) item to the legacy Bucket interface
 * for backward compatibility with BucketForm/BucketTable components.
 */
function dataSourceToBucket(ds: DataSourceItem): Bucket {
  return {
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
  }
}

export function useProject(projectId: string | undefined) {
  const [project, setProject] = useState<Project | null>(null)
  const [buckets, setBuckets] = useState<Bucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = async () => {
    if (!projectId) return

    try {
      setLoading(true)
      setError(null)
      const [projectData, volumeData] = await Promise.all([
        projectApi.get(projectId),
        datasourceApi.list(projectId, { type: 'volume' }),
      ])
      setProject(projectData)
      setBuckets(volumeData.map(dataSourceToBucket))
    } catch (err: any) {
      setError(err.message || 'Failed to load project')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (projectId) {
      loadData()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  return {
    project,
    buckets,
    loading,
    error,
    reload: loadData,
  }
}
