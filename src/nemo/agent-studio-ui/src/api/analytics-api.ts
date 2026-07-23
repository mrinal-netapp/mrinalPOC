import { buildNemoContextHeaders } from './api.slice';

/**
 * Analytics Engine endpoints are routed through apigateway-service at the /analytics prefix.
 * The gateway strips /analytics before forwarding to analytics-engine, so:
 *   POST /analytics/api/v1/datasets/preview  →  analytics-engine: POST /api/v1/datasets/preview
 *   POST /analytics/api/flightsql/query      →  analytics-engine: POST /api/flightsql/query
 *
 * In dev: Vite proxies /analytics directly to analytics-engine (default http://localhost:5001,
 * override via VITE_DEV_ANALYTICS_PROXY_TARGET), stripping the /analytics prefix to match the
 * gateway rewrite. Run: kubectl port-forward -n agentstudio svc/analytics-engine 5001:5000.
 */
const ANALYTICS_BASE: string =
  (import.meta.env.VITE_ANALYTICS_API_BASE_URL as string | undefined) ?? '/analytics';

function buildAnalyticsHeaders(): HeadersInit {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'application/json',
  });
  // Attach Authorization + nemo-context headers using the same mechanism as RTK Query.
  buildNemoContextHeaders(headers);
  return headers;
}

async function analyticsPost<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAnalyticsHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Analytics API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// -- Types --

export interface FilterCriteria {
  column: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'NOT LIKE' | 'IS NULL' | 'IS NOT NULL' | 'IN';
  value?: string;
}

export interface OrderBy {
  column: string;
  direction: 'asc' | 'desc';
}

export interface PreviewResponse {
  columns: string[];
  columnTypes: string[];
  /** Row data; null when the result set is empty on some backends. */
  rows: unknown[][] | null;
  rowCount: number;
  totalCount: number;
  offsetCapped: boolean;
}

export interface PreviewOptions {
  limit?: number;
  offset?: number;
  filters?: FilterCriteria[];
  orderBy?: OrderBy;
}

export interface HistogramBucket {
  label: string;
  count: number;
}

export interface HistogramResponse {
  buckets: HistogramBucket[];
}

// -- API calls --

/**
 * Fetch a paginated preview of a dataset table.
 * POST /analytics/api/v1/datasets/preview
 */
/** POST /analytics/api/v1/datasets/preview → gateway strips /analytics → analytics-engine */
export async function previewDataset(
  namespace: string,
  tableName: string,
  options?: PreviewOptions,
): Promise<PreviewResponse> {
  return analyticsPost<PreviewResponse>(`${ANALYTICS_BASE}/api/v1/datasets/preview`, {
    namespace,
    table: tableName,
    limit: options?.limit ?? 50,
    offset: options?.offset ?? 0,
    filters: options?.filters ?? [],
    ...(options?.orderBy ? { orderBy: options.orderBy } : {}),
  });
}

/** POST /analytics/api/flightsql/query → gateway strips /analytics → analytics-engine */
export async function queryDataset(sql: string): Promise<PreviewResponse> {
  return analyticsPost<PreviewResponse>(`${ANALYTICS_BASE}/api/flightsql/query`, { query: sql });
}

/** POST /analytics/api/v1/datasets/histogram → gateway strips /analytics → analytics-engine */
export async function columnHistogram(
  namespace: string,
  tableName: string,
  column: string,
  filters?: FilterCriteria[],
  signal?: AbortSignal,
): Promise<HistogramResponse> {
  return analyticsPost<HistogramResponse>(
    `${ANALYTICS_BASE}/api/v1/datasets/histogram`,
    { namespace, table: tableName, column, filters: filters ?? [] },
    signal,
  );
}
