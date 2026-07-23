import { useState, useEffect, useCallback } from 'react'
import {
  datasourceApi,
  pipelineApi,
  knowledgeBaseApi,
  agentApi,
  agentTeamApi,
  modelApi,
  projectApi,
  lineageApi,
  DataSourceItem,
  type Facet,
} from '../services/api'

export interface ProjectOverview {
  buckets: number
  connectors: number
  datasets: number
  datasetsStructured: number
  datasetsUnstructured: number
  manifestVersions: number
  filesInManifests: number
  knowledgeBases: number
  agents: number
  agentTeams: number
  models: number
  pipelines: {
    total: number
    data: number
    agent: number
  }
  storage: {
    totalAllottedGB: number
    totalUsedGB?: number
  }
}

export function useProjectOverview(projectId: string | undefined) {
  const [overview, setOverview] = useState<ProjectOverview>({
    buckets: 0,
    connectors: 0,
    datasets: 0,
    datasetsStructured: 0,
    datasetsUnstructured: 0,
    manifestVersions: 0,
    filesInManifests: 0,
    knowledgeBases: 0,
    agents: 0,
    agentTeams: 0,
    models: 0,
    pipelines: { total: 0, data: 0, agent: 0 },
    storage: { totalAllottedGB: 0 },
  })
  const [lineageFacetState, setLineageFacet] = useState<Facet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    if (!projectId) {
      setLoading(false)
      return
    }

    try {
      setLoading(true)
      setError(null)

      const [
        volumes,
        connectors,
        datasetMetrics,
        knowledgeBases,
        agents,
        agentTeams,
        models,
        dataPipelines,
        agentPipelines,
        lineageFacet,
      ] = await Promise.all([
        datasourceApi.list(projectId, { type: 'volume' }).catch(() => []),
        datasourceApi.list(projectId, { type: 'connector' }).catch(() => []),
        projectApi.getOverviewDatasetMetrics(projectId).catch(() => ({
          structured: 0,
          unstructured: 0,
          datasetsTotal: 0,
          manifestVersions: 0,
          filesInManifests: 0,
        })),
        knowledgeBaseApi.list(projectId).catch(() => []),
        agentApi.list(projectId).catch(() => []),
        agentTeamApi.list(projectId).catch(() => []),
        modelApi.list(projectId).catch(() => []),
        pipelineApi.list(projectId, { type: 'Data' }).catch(() => []),
        pipelineApi.list(projectId, { type: 'API' }).catch(() => []),
        lineageApi.getGraph(projectId).catch(() => null as Facet | null),
      ])

      // Calculate total allotted storage from volumes
      const totalAllottedGB = (volumes as DataSourceItem[]).reduce((total, ds) => {
        const volumeInfo = ds.volume_config?.volume_info
        if (volumeInfo?.storage_size) {
          const sizeStr = volumeInfo.storage_size.toLowerCase()
          const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(gb|gi|tb|ti|mb|mi)?$/)
          if (match) {
            const value = parseFloat(match[1])
            const unit = match[2] || 'gb'
            if (unit === 'tb' || unit === 'ti') return total + value * 1024
            if (unit === 'gb' || unit === 'gi') return total + value
            if (unit === 'mb' || unit === 'mi') return total + value / 1024
          }
        }
        return total
      }, 0)

      setLineageFacet(lineageFacet)

      setOverview({
        buckets: volumes.length,
        connectors: connectors.length,
        datasets: datasetMetrics.datasetsTotal,
        datasetsStructured: datasetMetrics.structured,
        datasetsUnstructured: datasetMetrics.unstructured,
        manifestVersions: datasetMetrics.manifestVersions,
        filesInManifests: datasetMetrics.filesInManifests,
        knowledgeBases: knowledgeBases.length,
        agents: agents.length,
        agentTeams: agentTeams.length,
        models: models.length,
        pipelines: {
          total: dataPipelines.length + agentPipelines.length,
          data: dataPipelines.length,
          agent: agentPipelines.length,
        },
        storage: {
          totalAllottedGB,
          totalUsedGB: undefined,
        },
      })
    } catch (err: any) {
      setError(err.message || 'Failed to load project overview')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadOverview()
  }, [loadOverview])

  return { overview, lineageFacet: lineageFacetState, loading, error, reload: loadOverview }
}
