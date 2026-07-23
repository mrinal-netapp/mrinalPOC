import { useState, useEffect, useCallback, useRef } from 'react'
import { queryInstant, queryRange, VectorResult, MatrixResult } from '../services/metricsApi'
import { getRuntimeConfig } from '../services/runtimeConfig'

/**
 * Prometheus `namespace=` label for kube-state / cadvisor series.
 * Prefer runtime injection (Docker entrypoint + Helm NAMESPACE on the GUI pod), then VITE at build time, then agentstudio.
 */
function k8sMetricsNamespaceRaw(): string {
  const fromRuntime = getRuntimeConfig().k8sMetricsNamespace?.trim()
  if (fromRuntime) return fromRuntime
  const fromVite = (import.meta.env.VITE_K8S_METRICS_NAMESPACE as string | undefined)?.trim()
  if (fromVite) return fromVite
  return 'agentstudio'
}

export function k8sMetricsNamespaceSelector(): string {
  return `namespace="${k8sMetricsNamespaceRaw()}"`
}

interface QueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export function usePrometheusQuery(promql: string, refreshInterval = 30000) {
  const [state, setState] = useState<QueryState<VectorResult>>({
    data: null,
    loading: true,
    error: null,
  })
  const mountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    if (!promql) return
    try {
      const data = await queryInstant(promql)
      if (mountedRef.current) {
        setState({ data, loading: false, error: null })
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: (err as Error).message }))
      }
    }
  }, [promql])

  useEffect(() => {
    mountedRef.current = true
    setState({ data: null, loading: true, error: null })
    fetchData()
    const id = setInterval(fetchData, refreshInterval)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [fetchData, refreshInterval])

  return state
}

export interface TimeRange {
  label: string
  seconds: number
  step: string
}

export const TIME_RANGES: TimeRange[] = [
  { label: '15m', seconds: 900, step: '15s' },
  { label: '1h', seconds: 3600, step: '60s' },
  { label: '6h', seconds: 21600, step: '300s' },
  { label: '24h', seconds: 86400, step: '600s' },
  { label: '7d', seconds: 604800, step: '3600s' },
]

export function usePrometheusRangeQuery(
  promql: string,
  timeRange: TimeRange,
  refreshInterval = 30000,
) {
  const [state, setState] = useState<QueryState<MatrixResult>>({
    data: null,
    loading: true,
    error: null,
  })
  const mountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    if (!promql) return
    const now = Math.floor(Date.now() / 1000)
    try {
      const data = await queryRange(promql, now - timeRange.seconds, now, timeRange.step)
      if (mountedRef.current) {
        setState({ data, loading: false, error: null })
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, loading: false, error: (err as Error).message }))
      }
    }
  }, [promql, timeRange])

  useEffect(() => {
    mountedRef.current = true
    setState({ data: null, loading: true, error: null })
    fetchData()
    const id = setInterval(fetchData, refreshInterval)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [fetchData, refreshInterval])

  return state
}

export function useClusterMetrics() {
  const ns = k8sMetricsNamespaceSelector()
  const podCount = usePrometheusQuery(
    `count(kube_pod_status_phase{${ns},phase="Running"})`,
  )
  const cpuUsage = usePrometheusQuery(
    `sum(rate(container_cpu_usage_seconds_total{${ns},container!="POD",container!=""}[5m]))`,
  )
  const memoryUsage = usePrometheusQuery(
    `sum(container_memory_working_set_bytes{${ns},container!="POD",container!=""})`,
  )
  const requestRate = usePrometheusQuery(
    `sum(rate(http_requests_total{${ns}}[5m]))`,
  )

  return {
    podCount,
    cpuUsage,
    memoryUsage,
    requestRate,
    loading: podCount.loading || cpuUsage.loading || memoryUsage.loading || requestRate.loading,
  }
}

export function useServiceMetrics(serviceName?: string) {
  const jobFilter = serviceName ? `job="${serviceName}"` : ''
  const filter = [k8sMetricsNamespaceSelector(), jobFilter].filter(Boolean).join(',')

  const upStatus = usePrometheusQuery(`up{${filter}}`)
  const requestRate = usePrometheusQuery(
    `sum(rate(http_requests_total{${filter}}[5m])) by (job)`,
  )
  const errorRate = usePrometheusQuery(
    `sum(rate(http_requests_total{${filter},status=~"5.."}[5m])) by (job)`,
  )
  const p95Latency = usePrometheusQuery(
    `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{${filter}}[5m])) by (job, le))`,
  )

  return {
    upStatus,
    requestRate,
    errorRate,
    p95Latency,
    loading: upStatus.loading || requestRate.loading || errorRate.loading || p95Latency.loading,
  }
}
