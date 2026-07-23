// invokeAgent — the only activity that speaks to agent-service.
//
// Targets the existing agent-service routes verbatim (no eval-specific
// modifications to agent-service per EVAL_BACKEND_TEMPORAL_TECH_SPEC.md §8.7):
//
//   POST /projects/{projectId}/agents/{agentId}/invoke         (specific agent)
//   POST /projects/{projectId}/agent-teams/{agentTeam}/invoke  (team router)
//
// Choice of route is driven by the template — when `template.agent.agentId`
// is set, the per-agent route is used; otherwise the team route.
//
// Eval-specific identifiers ride on the existing `metadata` passthrough
// (agent-service treats metadata as opaque; the LLM never sees it).
//
// Auth: service-principal token in AGENT_SERVICE_TOKEN.

import {
  activityInfo,
  ApplicationFailure,
  heartbeat,
} from '@temporalio/activity';
import { writeCaptureFile } from '../lib/capture-file';
import { gotPost, isHTTPError } from '../lib/got';
import { getServiceAccountToken } from '../lib/auth';
import { getLogger } from '../lib/logger';
import type {
  AgentInvocationResult,
  AgentRuntimeOverrides,
  Citation,
  InvokeAgentInput,
  InvokeAgentOutput,
  PerAgentTelemetry,
  RetrievedChunk,
  Telemetry,
  ToolCallTrace,
} from '../lib/evaluation';

const logger = getLogger('server');

function agentServiceUrl(): string {
  const url = process.env['AGENT_SERVICE_URL'];
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      'AGENT_SERVICE_URL is not configured',
      'InvalidInputError',
    );
  }
  return url;
}

/**
 * Build the agent-service invoke URL. Per §14.1:
 *   - With `agentId`     → /api/v1/projects/{projectId}/agents/{agentId}/invoke
 *   - Without `agentId`  → /api/v1/projects/{projectId}/agent-teams/{agentTeam}/invoke
 *
 * The `/api/v1` prefix matches what agent-service's openapi.json exposes
 * (POST /api/v1/projects/{project_id}/agents/{agent_id}/invoke).
 *
 * Exported for unit-test inspection.
 */
export function buildAgentInvokeEndpoint(input: InvokeAgentInput): string {
  const base = agentServiceUrl();
  const projectPath = `/api/v1/projects/${encodeURIComponent(input.caseRef.projectId)}`;
  return input.agentId
    ? `${base}${projectPath}/agents/${encodeURIComponent(input.agentId)}/invoke`
    : `${base}${projectPath}/agent-teams/${encodeURIComponent(input.agentTeam)}/invoke`;
}

// ── agent-service contract shapes (external; per §14.2, §14.3) ───────

/**
 * Mirrors MAF's `ConfigOverrides` (typed allowlist; unknown keys are
 * silently dropped by the server). camelCase wire shape — `maxTokens`,
 * `agentOverrides` (not `max_tokens` / `agent_overrides`).
 */
interface AgentServiceConfigOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  agentOverrides?: Record<
    string,
    { model?: string; temperature?: number; maxTokens?: number }
  >;
}

/**
 * MAF agent-service `InvokeRequest` (camelCase wire shape per §5.1.2).
 *   - `input` (not `message`) is the user prompt.
 *   - Model override goes under `configOverrides.model`; there is no
 *     top-level `modelId`.
 *   - Eval identifiers ride on the top-level `metadata` field — MAF
 *     defines it as passthrough and explicitly never forwards it to the
 *     LLM.
 */
interface AgentServiceInvokeRequest {
  input: string;
  sessionId?: string;
  context?: Record<string, unknown>;
  attachments?: unknown[];
  configOverrides?: AgentServiceConfigOverrides;
  metadata?: Record<string, unknown>;
}

/**
 * MAF agent-service `InvokeResponse`. Required fields: `agentId`,
 * `output`. `citations` is a structured envelope with provenance
 * sub-objects (`respondingAgent`, `routing`, `agentTrace`,
 * `kbCitations`, …) that the worker reshapes into per-agent telemetry
 * and retrieved chunks.
 */
interface AgentServiceInvokeResponse {
  agentId: string;
  output: string;
  parsedOutput?: Record<string, unknown>;
  artifacts?: unknown[];
  usage?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  citations?: {
    respondingAgent?: {
      name?: string;
      model?: string;
      temperature?: number;
      instructionsPreview?: string;
    } | null;
    routing?: Record<string, unknown> | null;
    contextUsed?: Record<string, unknown> | null;
    agentTrace?: unknown[];
    performance?: Record<string, unknown> | null;
    kbCitations?: unknown[];
  } | null;
  durationMs?: number;
  memoryDegraded?: boolean;
  sessionId?: string | null;
  traceId?: string | null;
}

// ── Build request body from worker-internal InvokeAgentInput ──────────

function buildRequestBody(input: InvokeAgentInput): AgentServiceInvokeRequest {
  const overrides = input.overrides ?? {};
  const configOverrides = pickConfigOverrides(overrides);

  const body: AgentServiceInvokeRequest = {
    input: input.input.query,
    metadata: {
      eval: {
        runId: input.caseRef.runId,
        testCaseId: input.caseRef.caseId,
        variantId: input.caseRef.variantId,
        seed: input.caseRef.seed,
        envelopeHash: input.envelopeHash,
        matrixSlice: buildMatrixSlice(input),
      },
    },
  };
  if (input.input.context_hints && input.input.context_hints.length > 0) {
    body.context = { toolsHint: input.input.context_hints };
  }
  if (input.input.attachments && input.input.attachments.length > 0) {
    body.attachments = input.input.attachments;
  }
  if (configOverrides && Object.keys(configOverrides).length > 0) {
    body.configOverrides = configOverrides;
  }
  return body;
}

function pickConfigOverrides(
  o: AgentRuntimeOverrides,
): AgentServiceConfigOverrides | undefined {
  const out: AgentServiceConfigOverrides = {};
  if (o.model !== undefined) out.model = o.model;
  if (o.temperature !== undefined) out.temperature = o.temperature;
  if (o.maxTokens !== undefined) out.maxTokens = o.maxTokens;
  return Object.keys(out).length === 0 ? undefined : out;
}

function buildMatrixSlice(input: InvokeAgentInput): string {
  const parts = [
    `case-${input.caseRef.caseId}`,
    `model-${input.overrides?.model ?? 'default'}`,
  ];
  if (input.caseRef.variantId !== undefined) {
    parts.push(`variant-${input.caseRef.variantId}`);
  }
  if (input.caseRef.seed !== undefined) {
    parts.push(`seed-${input.caseRef.seed}`);
  }
  return parts.join('|');
}

// ── Synthesize the worker's internal AgentInvocationResult ────────────

function synthesizeAgentInvocationResult(
  res: AgentServiceInvokeResponse,
  request: InvokeAgentInput,
): AgentInvocationResult {
  const citations = res.citations ?? null;
  const respondingAgent = citations?.respondingAgent ?? null;

  // Inferred-by-best-effort parsers — MAF's `kbCitations` and `agentTrace`
  // shapes are loose objects in the contract, so we pluck familiar fields
  // when present and otherwise treat as opaque.
  const retrievedChunks: RetrievedChunk[] = parseKbCitations(
    citations?.kbCitations,
  );
  const toolCalls: ToolCallTrace[] = parseAgentTrace(citations?.agentTrace);
  const citationRefs: Citation[] = retrievedChunks.map((c) => ({
    id: c.id,
    sourceUri: c.source,
  }));

  const usage = (res.usage ?? {}) as Record<string, unknown>;
  const promptTokens =
    typeof usage['promptTokens'] === 'number' ? (usage['promptTokens'] as number) : 0;
  const completionTokens =
    typeof usage['completionTokens'] === 'number'
      ? (usage['completionTokens'] as number)
      : 0;

  const perAgent: PerAgentTelemetry[] = respondingAgent
    ? [
        {
          agentName: respondingAgent.name ?? res.agentId ?? 'unknown',
          role: 'root',
          modelUsed:
            respondingAgent.model ?? request.overrides?.model ?? 'unknown',
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: promptTokens + completionTokens,
          estCostUsd: 0,
          latencyMs: res.durationMs ?? 0,
          toolCalls,
          retrievedChunks,
        },
      ]
    : [];

  const telemetry: Telemetry = {
    e2eMs: res.durationMs ?? 0,
    inputTokens: typeof usage['promptTokens'] === 'number' ? promptTokens : undefined,
    outputTokens:
      typeof usage['completionTokens'] === 'number' ? completionTokens : undefined,
  };

  const resolvedRuntimeParams: AgentRuntimeOverrides = {
    ...(request.overrides ?? {}),
    ...(respondingAgent?.model !== undefined && {
      model: respondingAgent.model,
    }),
    ...(respondingAgent?.temperature !== undefined && {
      temperature: respondingAgent.temperature,
    }),
  };

  return {
    response: res.output ?? '',
    citations: citationRefs,
    retrievedChunks,
    toolCalls,
    perAgent,
    telemetry,
    retrievalAnnotation: retrievedChunks.length === 0 ? 'zero_hits' : null,
    resolvedRuntimeParams,
    trace: res.traceId ?? undefined,
    raw: {
      parsedOutput: res.parsedOutput,
      artifacts: res.artifacts,
      routing: citations?.routing,
      contextUsed: citations?.contextUsed,
      performance: citations?.performance,
      memoryDegraded: res.memoryDegraded,
      sessionId: res.sessionId,
      metadataEcho: res.metadata,
    },
  };
}

function parseKbCitations(raw: unknown[] | undefined): RetrievedChunk[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): RetrievedChunk[] => {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : typeof r.chunkId === 'string' ? r.chunkId : undefined;
    if (!id) return [];
    return [
      {
        id,
        content: typeof r.content === 'string' ? r.content : '',
        score: typeof r.score === 'number' ? r.score : 0,
        source:
          typeof r.source === 'string'
            ? r.source
            : typeof r.sourceUri === 'string'
              ? r.sourceUri
              : '',
      },
    ];
  });
}

function parseAgentTrace(raw: unknown[] | undefined): ToolCallTrace[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ToolCallTrace[] => {
    if (!item || typeof item !== 'object') return [];
    const r = item as Record<string, unknown>;
    // Only entries that look like a tool invocation contribute.
    const name = typeof r.tool === 'string' ? r.tool : typeof r.name === 'string' ? r.name : undefined;
    if (!name) return [];
    return [
      {
        name,
        args:
          r.args && typeof r.args === 'object' && !Array.isArray(r.args)
            ? (r.args as Record<string, unknown>)
            : {},
        result: r.result,
        success: r.success !== false && r.error === undefined,
        latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : 0,
        error: typeof r.error === 'string' ? r.error : undefined,
      },
    ];
  });
}

// ── Main entry ────────────────────────────────────────────────────────

/**
 * Build the auth headers for an agent-service call.
 *
 * agent-service (src/nemo/agent-service/src/auth.py) trusts apigateway-
 * injected `X-User-ID` / `X-Project-ID` / `X-User-Email` / `X-User-Name`
 * headers and does NOT validate the JWT itself. When the worker bypasses
 * the gateway and calls agent-service directly, it has to populate
 * those headers manually — both must match the project on the URL or
 * agent-service returns 401/403.
 *
 * The service-account JWT is still attached as `Authorization: Bearer …`
 * for parity with other services and for future-proofing in case agent-
 * service starts validating it. Env-driven credentials
 * (`AGENT_SERVICE_API_KEY`, `AGENT_SERVICE_TOKEN`) are also honored as
 * an override, primarily for dev fixtures.
 */
async function authHeaders(
  projectId: string,
): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = {
    'x-user-id': 'eval-worker',
    'x-project-id': projectId,
  };
  const apiKey = process.env['AGENT_SERVICE_API_KEY'];
  if (apiKey) headers['x-api-key'] = apiKey;
  const staticToken = process.env['AGENT_SERVICE_TOKEN'];
  if (staticToken) {
    headers['authorization'] = `Bearer ${staticToken}`;
  } else {
    const sa = await getServiceAccountToken();
    if (sa) headers['authorization'] = `Bearer ${sa}`;
  }
  return headers;
}

export async function invokeAgent(
  input: InvokeAgentInput,
): Promise<InvokeAgentOutput> {
  const endpoint = buildAgentInvokeEndpoint(input);
  const { attempt } = activityInfo();
  const { caseRef } = input;

  logger.info(
    `invokeAgent attempt=${attempt} runId=${caseRef.runId} caseId=${caseRef.caseId} variantId=${caseRef.variantId ?? 'single'} target=${input.agentId ? 'agent' : 'team'}`,
  );

  heartbeat({ phase: 'request-start', caseId: caseRef.caseId });

  const requestBody = buildRequestBody(input);

  const headers = await authHeaders(caseRef.projectId);
  // agent-service's per-invocation cap is high (5+ min observed in
  // practice when LiteLLM retries against a slow upstream); the worker's
  // default got timeout is 60s and would mask the real response. Cap at
  // 6 minutes so we surface the actual completion / error from the
  // server, not a transport timeout.
  const INVOKE_TIMEOUT_MS = 6 * 60_000;
  let capture: AgentInvocationResult;
  try {
    const res = await gotPost<AgentServiceInvokeResponse>(
      endpoint,
      requestBody,
      {
        ...(headers ? { headers } : {}),
        timeout: { request: INVOKE_TIMEOUT_MS },
      },
    );
    if (!res) {
      throw ApplicationFailure.nonRetryable(
        'invokeAgent: agent-service returned empty body',
        'InvalidInputError',
      );
    }
    heartbeat({ phase: 'request-done', caseId: caseRef.caseId });
    capture = synthesizeAgentInvocationResult(res, input);
  } catch (err) {
    if (err instanceof ApplicationFailure) throw err;
    if (isHTTPError(err as Error)) {
      const status = (
        err as { response?: { statusCode?: number; body?: unknown } }
      ).response?.statusCode;
      // `got` returns `response.body` already parsed when responseType is
      // 'json', so it may be an object/null, not a string. Stringify
      // before substring checks so `body.includes` never throws on a
      // non-string body.
      const rawBody = (err as { response?: { body?: unknown } }).response?.body;
      const bodyStr =
        typeof rawBody === 'string'
          ? rawBody
          : rawBody === undefined || rawBody === null
            ? ''
            : JSON.stringify(rawBody);
      if (status === 404) {
        throw ApplicationFailure.nonRetryable(
          `agent not found: ${endpoint}`,
          'AgentNotFoundError',
        );
      }
      if (status === 422 && bodyStr.includes('content_filter')) {
        throw ApplicationFailure.nonRetryable(
          `agent-service content-filtered response: ${bodyStr}`,
          'ContentFilteredError',
        );
      }
      if (status && status >= 400 && status < 500) {
        throw ApplicationFailure.nonRetryable(
          `agent-service 4xx (${status}): ${(err as Error).message}: ${bodyStr}`,
          'InvalidInputError',
        );
      }
    }
    // 5xx, timeouts, network errors — retryable.
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Persist the full capture payload to PVC; activity result returns the
  // path + a small numeric headline so customer-derived data never lands
  // in Temporal event history.
  heartbeat({ phase: 'capture-write', caseId: caseRef.caseId });
  const capturePath = await writeCaptureFile(caseRef, {
    envelopeHash: input.envelopeHash,
    capturedAt: new Date().toISOString(),
    capture,
  });

  return {
    capturePath,
    telemetry: {
      e2eMs: capture.telemetry.e2eMs,
      ttftMs: capture.telemetry.ttftMs,
      retrievalMs: capture.telemetry.retrievalMs,
      inferMs: capture.telemetry.inferMs,
      inputTokens: capture.telemetry.inputTokens,
      outputTokens: capture.telemetry.outputTokens,
      estCostUsd: capture.telemetry.estCostUsd,
    },
    retrievalAnnotation: capture.retrievalAnnotation,
    resolvedRuntimeParams: capture.resolvedRuntimeParams,
  };
}
