import { buildNemoContextHeaders } from './api.slice';

/**
 * Connector Explorer endpoints (workflow-engine, gateway prefix `/workflow`).
 * Unlike volume-browse (filesystem-only), the Explorer API is connector-agnostic
 * and provider-aware: it walks object stores (buckets → prefixes), databases
 * (databases → schemas → tables), etc., via action/payload steps.
 *
 *   POST /workflow/api/v1/explore/session                       → { sessionId }
 *   POST /workflow/api/v1/explore/session/{sessionId}/list      → ExplorerResponse
 *
 * The backend also supports a "direct" mode: when projectId + connectorId are
 * sent in the list body, it runs a one-shot ExplorerListWorkflow and the
 * sessionId path segment can be any stable placeholder (e.g. `direct-<id>`).
 * This avoids depending on the Temporal Update API being enabled.
 *
 * In dev: Vite proxies /workflow to workflow-engine (see workflow-api.ts).
 */
const WORKFLOW_BASE: string =
  (import.meta.env.VITE_WORKFLOW_API_BASE_URL as string | undefined) ?? '/workflow';

async function workflowPost<T>(url: string, body: unknown): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
  buildNemoContextHeaders(headers);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Explorer API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// -- Types (mirror workflow-engine workflows.ExplorerNode / ExplorerResponse) --

/** Hint about whether a node can be expanded further. */
export type ExplorerChildrenHint = 'hasChildren' | 'leaf' | 'unknown';

/**
 * A single node returned by an explorer list operation. The `resource` object
 * is the connector-specific selector payload (e.g. `{ bucket, prefix }`,
 * `{ database, schema, table }`, `{ category }`) and becomes an entry in the
 * dataset's `resource_selector` when the node is selected.
 */
export interface ExplorerNode {
  id: string;
  label: string;
  type: string;
  kind?: string;
  childrenHint?: ExplorerChildrenHint;
  resource?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Connector-supplied list actions; first entry is the default drill-down. */
  actions?: string[];
}

export interface ExplorerError {
  code: string;
  message: string;
}

export interface ExplorerResponse {
  nodes: ExplorerNode[];
  nextToken?: string;
  error?: ExplorerError;
}

export interface ExplorerListOptions {
  projectId?: string;
  connectorId?: string;
  refresh?: boolean;
}

// -- API calls --

/**
 * POST /workflow/api/v1/explore/session
 * Starts a long-running explorer session and returns its id. Optional — callers
 * can skip this and use a `direct-<connectorId>` placeholder with `list()` when
 * passing projectId + connectorId (one-shot mode).
 */
export async function startExplorerSession(
  projectId: string,
  connectorId: string,
): Promise<{ sessionId: string }> {
  return workflowPost<{ sessionId: string }>(`${WORKFLOW_BASE}/api/v1/explore/session`, {
    projectId,
    connectorId,
  });
}

/**
 * POST /workflow/api/v1/explore/session/{sessionId}/list
 * Runs a single list action (e.g. listBuckets, listPath, listSchemas) and
 * returns the resulting nodes. Pass projectId + connectorId in `options` to use
 * the backend's direct one-shot mode.
 */
export async function explorerList(
  sessionId: string,
  action: string,
  payload: Record<string, unknown> = {},
  options?: ExplorerListOptions,
): Promise<ExplorerResponse> {
  const body: Record<string, unknown> = { action, payload };
  if (options?.projectId && options?.connectorId) {
    body.projectId = options.projectId;
    body.connectorId = options.connectorId;
  }
  if (options?.refresh === true) {
    body.refresh = true;
  }
  return workflowPost<ExplorerResponse>(
    `${WORKFLOW_BASE}/api/v1/explore/session/${encodeURIComponent(sessionId)}/list`,
    body,
  );
}
