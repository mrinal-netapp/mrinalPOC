import axios, { AxiosInstance } from 'axios';
import {
  ServiceAccountClient,
  createServiceAccountClientFromEnv,
} from '@agentstudio/common';
import type { EvaluationTemplate } from '../models/EvaluationTemplate';

/**
 * Boundary to the workflow-engine for evaluation execution and scheduling.
 *
 * Run execution is wired against workflow-engine's generic
 * `POST /api/v1/workflows` route (see
 * `workflow-engine/internal/server/routes/workflow_status.go`), which
 * starts the eval-worker's `AgentEvaluationWorkflow` on `eval-task-queue`
 * with `{runId, projectId}` as the workflow input. The worker's
 * `loadRunSnapshot` activity is what materializes the template + cases
 * from the persisted EvaluationRun row at workflow start.
 *
 * Temporal schedule reconciliation and AI test-case generation remain
 * placeholders — they can be wired by extending this client without
 * touching the route call sites.
 */
export interface EvaluationWorkflowClient {
  /** Start a run; returns the workflow id. */
  startEvaluationRun(
    projectId: string,
    templateId: string,
    runId: string,
  ): Promise<{ workflowId: string }>;
  /** Cancel a running workflow (hard cancel via Temporal). */
  cancel(workflowId: string): Promise<void>;
  /**
   * Deliver an in-band signal to a running workflow. Used by the eval
   * cancel route to send `evaluation.cancel` so the workflow can drain
   * in-flight cases within DEFAULT_STOP_GRACE_SECONDS — preserves the
   * workflow's own cancellation semantics instead of hard-cancelling
   * mid-activity.
   */
  signal(workflowId: string, signalName: string, payload?: unknown): Promise<void>;
  /** Create/replace the Temporal schedule for a template. */
  reconcileSchedule(
    template: EvaluationTemplate,
  ): Promise<{ temporalScheduleId?: string }>;
  /** Tear down a template's Temporal schedule. */
  tearDownSchedule(template: EvaluationTemplate): Promise<void>;
}

const AGENT_EVALUATION_WORKFLOW_NAME = 'AgentEvaluationWorkflow';
const EVAL_TASK_QUEUE = 'eval-task-queue';

class WorkflowEngineEvaluationClient implements EvaluationWorkflowClient {
  private client: AxiosInstance;
  private workflowEngineUrl: string;
  private serviceAccountClient: ServiceAccountClient | null = null;

  constructor() {
    this.workflowEngineUrl =
      process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    this.serviceAccountClient = createServiceAccountClientFromEnv();

    if (this.serviceAccountClient) {
      this.client = this.serviceAccountClient.createAuthenticatedClient(
        this.workflowEngineUrl,
      );
      console.log(
        `[EvaluationWorkflowClient] Initialized with workflow-engine URL: ${this.workflowEngineUrl} (with service account authentication)`,
      );
    } else {
      console.warn(
        '[EvaluationWorkflowClient] Service account client not available, using unauthenticated client',
      );
      this.client = axios.create({
        baseURL: this.workflowEngineUrl,
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' },
      });
      console.log(
        `[EvaluationWorkflowClient] Initialized with workflow-engine URL: ${this.workflowEngineUrl} (unauthenticated)`,
      );
    }
  }

  async startEvaluationRun(
    projectId: string,
    templateId: string,
    runId: string,
  ): Promise<{ workflowId: string }> {
    const workflowId = `evaluation-agent-run-${runId}`;
    try {
      const response = await this.client.post(`/api/v1/workflows`, {
        workflowName: AGENT_EVALUATION_WORKFLOW_NAME,
        workflowId,
        taskQueue: EVAL_TASK_QUEUE,
        // Workflow input — read by `loadRunSnapshot` to fetch the
        // persisted run row's templateSnapshot. Cases live as a project
        // Dataset on the PVC and are loaded by `validateGoldenDataset`.
        args: [{ runId, projectId }],
      });
      const returnedId = response.data?.workflowId ?? workflowId;
      console.log(
        `[EvaluationWorkflowClient] startEvaluationRun project=${projectId} template=${templateId} run=${runId} → workflowId=${returnedId}`,
      );
      return { workflowId: returnedId };
    } catch (err: any) {
      const statusCode = err.response?.status;
      const errorMessage = err.response?.data?.error || err.message;
      console.error(
        `[EvaluationWorkflowClient] ERROR: startEvaluationRun failed for run ${runId} (status=${statusCode}): ${errorMessage}`,
      );
      throw err;
    }
  }

  async cancel(workflowId: string): Promise<void> {
    try {
      await this.client.post(
        `/api/v1/workflows/${encodeURIComponent(workflowId)}/cancel`,
        {},
      );
      console.log(
        `[EvaluationWorkflowClient] Cancelled workflow=${workflowId}`,
      );
    } catch (err: any) {
      const statusCode = err.response?.status;
      const errorMessage = err.response?.data?.error || err.message;
      // 404 = already gone; swallow.
      if (statusCode === 404) {
        console.warn(
          `[EvaluationWorkflowClient] cancel: workflow ${workflowId} not found (already terminated)`,
        );
        return;
      }
      console.error(
        `[EvaluationWorkflowClient] ERROR: cancel failed for workflow ${workflowId} (status=${statusCode}): ${errorMessage}`,
      );
      throw err;
    }
  }

  async signal(
    workflowId: string,
    signalName: string,
    payload?: unknown,
  ): Promise<void> {
    try {
      await this.client.post(
        `/api/v1/workflows/${encodeURIComponent(workflowId)}/signal/${encodeURIComponent(signalName)}`,
        { payload: payload ?? null },
      );
      console.log(
        `[EvaluationWorkflowClient] Signaled workflow=${workflowId} signal=${signalName}`,
      );
    } catch (err: any) {
      const statusCode = err.response?.status;
      const errorMessage = err.response?.data?.error || err.message;
      // 404 = already terminal; idempotent.
      if (statusCode === 404) {
        console.warn(
          `[EvaluationWorkflowClient] signal: workflow ${workflowId} not found (already terminal)`,
        );
        return;
      }
      console.error(
        `[EvaluationWorkflowClient] ERROR: signal ${signalName} failed for workflow ${workflowId} (status=${statusCode}): ${errorMessage}`,
      );
      throw err;
    }
  }

  async reconcileSchedule(
    template: EvaluationTemplate,
  ): Promise<{ temporalScheduleId?: string }> {
    // PLACEHOLDER — Temporal schedule wiring is out of scope for the
    // current run-execution refactor. When implemented, this will POST
    // to a workflow-engine schedule endpoint and persist the returned id
    // back onto the template row.
    console.warn(
      `[EvaluationWorkflowClient] PLACEHOLDER reconcileSchedule template=${template.templateId} → schedule wiring not implemented.`,
    );
    return { temporalScheduleId: undefined };
  }

  async tearDownSchedule(template: EvaluationTemplate): Promise<void> {
    console.warn(
      `[EvaluationWorkflowClient] PLACEHOLDER tearDownSchedule template=${template.templateId} → schedule wiring not implemented.`,
    );
  }
}

let singleton: EvaluationWorkflowClient | null = null;

export function getEvaluationWorkflowClient(): EvaluationWorkflowClient {
  if (!singleton) {
    singleton = new WorkflowEngineEvaluationClient();
  }
  return singleton;
}
