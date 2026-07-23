import { buildNemoContextHeaders } from './api.slice';

type WorkflowGetState = () => unknown;

/**
 * Workflow-engine endpoints are routed through apigateway-service at the /workflow prefix.
 * The gateway strips /workflow before forwarding to workflow-engine, so:
 *   POST /workflow/api/v1/connectors/volume-browse  →  workflow-engine: POST /api/v1/connectors/volume-browse
 *
 * In dev: Vite proxies /workflow directly to workflow-engine (default http://localhost:8082,
 * override via VITE_DEV_WORKFLOW_PROXY_TARGET), stripping the /workflow prefix to match the
 * gateway rewrite. Run: kubectl port-forward -n agentstudio-services svc/workflow-engine 8082:8080.
 */
const WORKFLOW_BASE: string =
  (import.meta.env.VITE_WORKFLOW_API_BASE_URL as string | undefined) ?? '/workflow';

async function formatWorkflowError(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  try {
    const body = JSON.parse(text) as { error?: string; message?: string };
    const detail = body.error ?? body.message;
    if (detail) {
      return `Workflow API error ${res.status}: ${detail}`;
    }
  } catch {
    // fall through to raw body
  }
  return `Workflow API error ${res.status}: ${text}`;
}

async function workflowPost<T>(url: string, body: unknown, getState?: WorkflowGetState): Promise<T> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
  buildNemoContextHeaders(headers, getState);
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(await formatWorkflowError(res));
  }
  return res.json() as Promise<T>;
}

async function workflowGet<T>(url: string, getState?: WorkflowGetState): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  buildNemoContextHeaders(headers, getState);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(await formatWorkflowError(res));
  }
  return res.json() as Promise<T>;
}

// -- Types --

export interface VolumeDirEntry {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number;
  lastModified: string;
}

export interface VolumeBrowseResult {
  entries: VolumeDirEntry[];
  mountPath: string;
  subPath: string;
  totalDirCount?: number;
  totalFileCount?: number;
  scannedEntries?: number;
  truncated?: boolean;
  /** Set on a successful (HTTP 200) response when the directory could not be listed (e.g. path missing). */
  error?: string;
}

// -- API calls --

/**
 * POST /workflow/api/v1/connectors/volume-browse
 * Lists files and directories inside a volume data-source at the given subPath.
 */
export async function volumeBrowse(
  projectId: string,
  volumeId: string,
  subPath: string = '',
): Promise<VolumeBrowseResult> {
  return workflowPost<VolumeBrowseResult>(`${WORKFLOW_BASE}/api/v1/connectors/volume-browse`, {
    projectId,
    volumeId,
    subPath,
  });
}

// -- Connector connection test --

export interface ConnectorTestStartResult {
  /** Temporal workflow id to poll via getWorkflowStatus. */
  workflowId: string;
  /** Always "testing" on a successful start. */
  status: string;
}

/** Mirrors workflow-engine WorkflowStatusResponse (subset the UI consumes). */
export interface WorkflowStatusResult {
  /** running | completed | failed | cancelled | terminated | timed_out | unknown */
  status: string;
  isRunning: boolean;
  /** Populated for failed workflows — the connection failure reason. */
  failureMessage?: string;
}

export interface ConnectorTestRequest {
  /** { connector_type, provider, scope, ...providerConfig } */
  connectorConfig: Record<string, unknown>;
  /** Saved credential id the connector authenticates with (required). */
  credentialId: string;
  configServiceURL?: string;
}

/**
 * POST /workflow/api/v1/projects/{projectId}/connectors/{connectorId}/test
 *
 * Starts an interactive connector-test workflow for an as-yet-unsaved connector
 * and returns immediately with the workflow id. The actual pass/fail outcome is
 * obtained by polling getWorkflowStatus: the workflow completes on success and
 * fails (with failureMessage) when the connection is refused/unreachable.
 */
export async function startConnectorTest(
  projectId: string,
  body: ConnectorTestRequest,
  getState?: WorkflowGetState,
): Promise<ConnectorTestStartResult> {
  return workflowPost<ConnectorTestStartResult>(
    `${WORKFLOW_BASE}/api/v1/projects/${encodeURIComponent(projectId)}/connectors/unsaved/test`,
    body,
    getState,
  );
}

/**
 * GET /workflow/api/v1/workflows/{workflowId}/status
 * Polls the lifecycle status of a previously started workflow.
 */
export async function getWorkflowStatus(
  workflowId: string,
  getState?: WorkflowGetState,
): Promise<WorkflowStatusResult> {
  return workflowGet<WorkflowStatusResult>(
    `${WORKFLOW_BASE}/api/v1/workflows/${encodeURIComponent(workflowId)}/status`,
    getState,
  );
}
