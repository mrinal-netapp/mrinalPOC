import axios, { InternalAxiosRequestConfig } from 'axios'

let tokenGetter: (() => string | null) | null = null

export const setMetricsAuthTokenGetter = (getter: () => string | null) => {
  tokenGetter = getter
}

const metricsApi = axios.create({
  baseURL: '/prometheus/api/v1',
  timeout: 30000,
})

metricsApi.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    if (tokenGetter) {
      const token = tokenGetter()
      if (token && config.headers) {
        config.headers.Authorization = `Bearer ${token}`
      }
    }
    return config
  },
  (error) => Promise.reject(error),
)

// ── Prometheus response types ──

export interface PrometheusResponse<T> {
  status: 'success' | 'error'
  data: T
  errorType?: string
  error?: string
}

export interface VectorResult {
  resultType: 'vector'
  result: Array<{
    metric: Record<string, string>
    value: [number, string] // [unix_timestamp, value]
  }>
}

export interface MatrixResult {
  resultType: 'matrix'
  result: Array<{
    metric: Record<string, string>
    values: Array<[number, string]> // [unix_timestamp, value][]
  }>
}

// ── Query functions ──

function formatMetricsApiError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    if (status === 502 || status === 503) {
      return (
        'Metrics backend unavailable (Prometheus). Install the observability stack ' +
        'with `make deploy-observability` in AgentStudio, then refresh this page.'
      )
    }
    if (status === 401 || status === 403) {
      return 'Not authorized to query metrics. Sign in again and retry.'
    }
    const body = err.response?.data
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return String((body as { message: string }).message)
    }
    if (typeof body === 'string' && body.trim()) return body
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

export async function queryInstant(promql: string): Promise<VectorResult> {
  try {
    const { data } = await metricsApi.get<PrometheusResponse<VectorResult>>(
      '/query',
      { params: { query: promql } },
    )
    if (data.status === 'error') {
      throw new Error(data.error || 'Prometheus query failed')
    }
    return data.data
  } catch (err) {
    throw new Error(formatMetricsApiError(err))
  }
}

export async function queryRange(
  promql: string,
  start: number,
  end: number,
  step: string,
): Promise<MatrixResult> {
  try {
    const { data } = await metricsApi.get<PrometheusResponse<MatrixResult>>(
      '/query_range',
      { params: { query: promql, start, end, step } },
    )
    if (data.status === 'error') {
      throw new Error(data.error || 'Prometheus range query failed')
    }
    return data.data
  } catch (err) {
    throw new Error(formatMetricsApiError(err))
  }
}
