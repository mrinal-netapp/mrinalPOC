// HTTP client for the workflow-engine REST surface
// (src/nemo/workflow-engine/internal/server/routes/workflow_status.go).
//
// Only the evaluation trigger lib + dev harness depend on these helpers; the
// eval-worker's runtime path (main.ts → activities → workflows) does not
// touch this module.

import got, { HTTPError, OptionsOfJSONResponseBody } from 'got';

const DEFAULT_BASE_URL = 'http://workflow-engine:8080';

function baseUrl(): string {
  return process.env['WORKFLOW_ENGINE_URL'] ?? DEFAULT_BASE_URL;
}

function authHeaders(): Record<string, string> | undefined {
  const token = process.env['WORKFLOW_ENGINE_TOKEN'];
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

const baseOptions: Partial<OptionsOfJSONResponseBody> = {
  responseType: 'json',
  throwHttpErrors: true,
  retry: { limit: 0 },
};

function isStatus(err: unknown, status: number): boolean {
  return (
    err instanceof HTTPError &&
    (err as HTTPError).response?.statusCode === status
  );
}

// ── start ──────────────────────────────────────────────────────────

export interface StartWorkflowViaEngineInput {
  workflowName: string;
  workflowId: string;
  taskQueue: string;
  args: unknown[];
}

export interface StartWorkflowViaEngineResult {
  workflowId: string;
  runId: string;
}

export async function startWorkflowViaEngine(
  input: StartWorkflowViaEngineInput,
): Promise<StartWorkflowViaEngineResult> {
  const res = await got.post(`${baseUrl()}/api/v1/workflows`, {
    ...baseOptions,
    headers: authHeaders(),
    json: input as unknown as Record<string, unknown>,
    timeout: { request: 30_000 },
  });
  return res.body as StartWorkflowViaEngineResult;
}

// ── query ──────────────────────────────────────────────────────────

export interface QueryWorkflowViaEngineInput {
  workflowId: string;
  queryName: string;
  /**
   * Optional positional arguments to pass to the query handler. Most
   * eval-worker queries take no args; provided here for parity with the Go
   * route surface.
   */
  args?: unknown[];
}

export async function queryWorkflowViaEngine<T = unknown>(
  input: QueryWorkflowViaEngineInput,
): Promise<T> {
  const url = `${baseUrl()}/api/v1/workflows/${encodeURIComponent(
    input.workflowId,
  )}/query/${encodeURIComponent(input.queryName)}`;
  const res = await got.post(url, {
    ...baseOptions,
    headers: authHeaders(),
    json: { args: input.args ?? [] },
    timeout: { request: 30_000 },
  });
  return res.body as T;
}

// ── await result ───────────────────────────────────────────────────

export interface AwaitWorkflowResultViaEngineInput {
  workflowId: string;
  /**
   * Maximum time the underlying HTTP call is allowed to block waiting for
   * the workflow to complete. Defaults to 30 min — the Go route is a
   * synchronous run.Get() so the request hangs until the workflow exits.
   */
  timeoutMs?: number;
  /**
   * If the workflow has not completed yet, the route returns 409. The
   * client retries with this backoff until completion. Default polls
   * every 2s.
   */
  pollIntervalMs?: number;
}

export async function awaitWorkflowResultViaEngine<T = unknown>(
  input: AwaitWorkflowResultViaEngineInput,
): Promise<T> {
  const url = `${baseUrl()}/api/v1/workflows/${encodeURIComponent(
    input.workflowId,
  )}/result`;
  const timeout = input.timeoutMs ?? 30 * 60_000;
  const pollInterval = input.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeout;

  for (;;) {
    try {
      const res = await got.get(url, {
        ...baseOptions,
        headers: authHeaders(),
        timeout: { request: timeout },
      });
      return res.body as T;
    } catch (err) {
      if (isStatus(err, 409) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollInterval));
        continue;
      }
      throw err;
    }
  }
}
