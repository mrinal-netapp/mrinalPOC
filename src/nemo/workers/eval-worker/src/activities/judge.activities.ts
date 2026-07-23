// invokeJudge / invokePairwiseJudge — LLM-gateway-backed rubric judges
// (spec §7.5). Judge-row failures never abort the run — they return
// `errored: true` on JudgeRubricOutput so the parent's judge_scoring_health
// gate (§9.1 row 7) reflects the real coverage.
//
// The deployed LLM gateway (Bifrost) is OpenAI-compatible
// (`/v1/chat/completions`) rather than a rubric-specific service. This
// module owns the rubric → chat-completion translation:
//   1. Look up a system+user prompt template per `rubricId`
//      (`lib/judge-prompts.ts`).
//   2. POST it to `${LLM_GATEWAY_URL}/v1/chat/completions` as an
//      OpenAI-shape request.
//   3. Parse the assistant message as JSON `{score, rationale, winner?}`.
//
// Retry/error policy:
//   - 5xx / connection errors  → throw, Temporal handles retries
//   - 4xx (client error)       → soft-fail with `errored: true`
//   - Empty / malformed reply  → ONE local retry, then errored
//
// `evaluatorModel` and `evaluatorVersion` are forwarded as-is — pinning is
// the caller's responsibility (the workflow seeds them from the resolved
// provenance envelope).

import { createHash } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import { readCaptureFile } from '../lib/capture-file';
import { gotGet, gotPost, isHTTPError } from '../lib/got';
import { getServiceAccountToken } from '../lib/auth';
import { getLogger } from '../lib/logger';
import {
  getPairwiseRubricPrompts,
  getRubricPrompts,
  parseJudgeReply,
} from '../lib/judge-prompts';
import type {
  InvokeJudgeInput,
  InvokePairwiseJudgeInput,
  JudgeRubricOutput,
} from '../lib/evaluation';

const logger = getLogger('server');

function llmGatewayUrl(): string {
  const url = process.env['LLM_GATEWAY_URL'];
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      'LLM_GATEWAY_URL is not configured',
      'InvalidInputError',
    );
  }
  return url.replace(/\/$/, '');
}

function configServiceUrl(): string {
  const url = process.env['CONFIG_SERVICE_URL'];
  if (!url) {
    throw ApplicationFailure.nonRetryable(
      'CONFIG_SERVICE_URL is not configured',
      'InvalidInputError',
    );
  }
  return url.replace(/\/$/, '');
}

// Module-level cache for UUID -> gateway model id lookups.  Templates
// store models as catalog UUIDs ("4e79b2dc-..."); Bifrost requires the
// resolved "provider/model-name" string.  Config-service computes the
// mapping on its /models/{id} endpoint; we hit it once per (projectId,
// modelId) per worker process and reuse the answer for the rest of the
// run -- otherwise a 7-case × 9-rubric run would burn 63 lookups.
const gatewayModelIdCache = new Map<string, Promise<string>>();

// Module-level cache for project -> Bifrost virtual key (VK) lookups.
// Same wire shape as MAF's ProjectVKResolver -- the VK is per-project
// (not per-model), so all judge invocations in the same project share
// one cache entry. Bifrost routes per-project rate-limit / budget /
// quota off this bearer; using it instead of the worker's cluster-wide
// service-account JWT keeps one project's judge fanout from sharing
// a global bucket with every other project (the symptom that produced
// across-the-board 429s on the judge path).
const projectVkCache = new Map<string, Promise<string | undefined>>();

/**
 * Resolve a model identifier to the Bifrost-routable string the LLM
 * gateway accepts.  Strings already containing "/" are assumed to be
 * provider-qualified (e.g. "anthropic/claude-sonnet-4-20250514") and
 * returned unchanged; everything else is looked up against
 * config-service's GET /projects/{pid}/models/{id}.  On lookup failure
 * the original input is returned so the gateway gets the same string
 * the legacy code path would have sent -- the failure mode is "judge
 * silently no-ops" rather than "judge crashes the run".
 */
async function resolveGatewayModelId(
  projectId: string,
  modelId: string,
): Promise<string> {
  if (!modelId) return modelId;
  if (modelId.includes('/')) return modelId;
  const key = `${projectId}/${modelId}`;
  const cached = gatewayModelIdCache.get(key);
  if (cached) return cached;
  const p = (async (): Promise<string> => {
    try {
      // Service-account JWT goes against the user-scoped mount; the
      // legacy createAuthMiddleware in config-service accepts JWTs with
      // only `sub` (no email / preferred_username), so SA tokens pass.
      // NOTE: we deliberately don't go through ``authHeaders`` here --
      // that helper now prefers the per-project Bifrost VK, which is
      // for the LLM gateway and would 401 against config-service.
      // This config-service lookup must always carry the SA JWT.
      const url = `${configServiceUrl()}/api/v1/projects/${projectId}/models/${modelId}`;
      const sa = await getServiceAccountToken();
      const record = await gotGet<Record<string, unknown>>(
        url,
        sa
          ? { headers: { authorization: `Bearer ${sa}` }, timeout: { request: 15_000 } }
          : { timeout: { request: 15_000 } },
      );
      const resolved =
        (record['gatewayModelId'] as string | undefined) ??
        (record['gateway_model_id'] as string | undefined);
      if (!resolved) {
        logger.warn(
          `resolveGatewayModelId: project=${projectId} model=${modelId} -> record has no gatewayModelId; passing the raw id through`,
        );
        return modelId;
      }
      return resolved;
    } catch (err) {
      logger.warn(
        `resolveGatewayModelId: project=${projectId} model=${modelId} lookup failed (${err instanceof Error ? err.message : String(err)}); passing the raw id through`,
      );
      return modelId;
    }
  })();
  gatewayModelIdCache.set(key, p);
  return p;
}

/**
 * Resolve the per-project Bifrost virtual key (VK) from config-service.
 *
 * Same wire shape as MAF's ``ProjectVKResolver``: config-service
 * exposes ``gatewayApiKey`` on
 * ``GET /api/v1/projects/{projectId}/models/{modelId}``,
 * scoped per project (every model in a project returns the same VK).
 * Sending it as the chat-completion ``Authorization`` bearer lets
 * Bifrost apply that project's rate-limit / budget / quota / routing
 * rules instead of attributing the call to the cluster-wide
 * ``agentstudio-eval-worker`` service-account identity (which puts
 * every project's judge fanout into one shared bucket).
 *
 * Returns ``undefined`` on any lookup failure so the caller can fall
 * back to the existing service-account JWT path -- judges shouldn't
 * hard-fail just because a single VK lookup blipped.
 */
async function resolveProjectVk(
  projectId: string,
  modelHint: string,
): Promise<string | undefined> {
  if (!projectId || !modelHint) return undefined;
  const cached = projectVkCache.get(projectId);
  if (cached) return cached;
  const p = (async (): Promise<string | undefined> => {
    try {
      const url = `${configServiceUrl()}/api/v1/projects/${projectId}/models/${modelHint}`;
      const sa = await getServiceAccountToken();
      const record = await gotGet<Record<string, unknown>>(
        url,
        sa
          ? { headers: { authorization: `Bearer ${sa}` }, timeout: { request: 15_000 } }
          : { timeout: { request: 15_000 } },
      );
      const vk =
        (record['gatewayApiKey'] as string | undefined) ??
        (record['gateway_api_key'] as string | undefined);
      if (!vk) {
        logger.warn(
          `resolveProjectVk: project=${projectId} model=${modelHint} -> record has no gatewayApiKey; falling back to service-account auth`,
        );
        return undefined;
      }
      return vk;
    } catch (err) {
      logger.warn(
        `resolveProjectVk: project=${projectId} model=${modelHint} lookup failed (${err instanceof Error ? err.message : String(err)}); falling back to service-account auth`,
      );
      return undefined;
    }
  })();
  const cachedPromise = p.then((vk) => {
    if (!vk) projectVkCache.delete(projectId);
    return vk;
  });
  projectVkCache.set(projectId, cachedPromise);
  return cachedPromise;
}

/**
 * Build the auth header for an LLM-gateway call.
 *
 * Priority order:
 *   1. Per-project Bifrost virtual key resolved from config-service
 *      (``ProjectVKResolver``-equivalent). Carries the project's
 *      rate-limit / budget / routing identity on Bifrost.
 *   2. ``LLM_GATEWAY_TOKEN`` static bearer (pre-shared-key dev
 *      fixtures, gateways without per-project VKs wired up).
 *   3. Service-account JWT minted by ``lib/auth.ts`` from
 *      ``KEYCLOAK_INTERNAL_ISSUER`` + ``KEYCLOAK_CLIENT_ID`` /
 *      ``KEYCLOAK_CLIENT_SECRET`` -- the cluster-wide identity the
 *      worker uses for every other outbound call. Kept as the final
 *      fallback so the gateway still gets an authenticated caller
 *      when (1) and (2) are unavailable.
 *
 * Returns ``undefined`` when none of the three resolve -- the call
 * still goes out (gateways running in an auth-off dev mode keep
 * working).
 */
async function authHeaders(
  projectId: string,
  modelHint: string,
): Promise<Record<string, string> | undefined> {
  const vk = await resolveProjectVk(projectId, modelHint);
  if (vk) return { authorization: `Bearer ${vk}` };
  const staticToken = process.env['LLM_GATEWAY_TOKEN'];
  if (staticToken) return { authorization: `Bearer ${staticToken}` };
  const sa = await getServiceAccountToken();
  return sa ? { authorization: `Bearer ${sa}` } : undefined;
}

// ── OpenAI-compatible chat-completion plumbing ──────────────────────

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /**
   * OpenAI-compatible structured-output hint. Bifrost forwards this to
   * OpenAI/Anthropic which both honour it. Defense-in-depth on top of
   * the prompt-level JSON-only instruction. Disabled when
   * `LLM_JUDGE_DISABLE_JSON_FORMAT=1` for backends that reject unknown
   * fields.
   */
  response_format?: { type: 'json_object' };
}

function jsonObjectFormat(): { type: 'json_object' } | undefined {
  return process.env['LLM_JUDGE_DISABLE_JSON_FORMAT'] === '1'
    ? undefined
    : { type: 'json_object' };
}

interface ChatCompletionsResponse {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function extractContent(res: ChatCompletionsResponse | null | undefined): string {
  const msg = res?.choices?.[0]?.message?.content;
  return typeof msg === 'string' ? msg : '';
}

async function chatComplete(
  body: ChatCompletionsRequest,
  headers: Record<string, string> | undefined,
): Promise<ChatCompletionsResponse> {
  const url = `${llmGatewayUrl()}/v1/chat/completions`;
  return gotPost<ChatCompletionsResponse>(
    url,
    body,
    headers ? { headers, timeout: { request: 60_000 } } : { timeout: { request: 60_000 } },
  );
}

// ── Pointwise judge ─────────────────────────────────────────────────

export async function invokeJudge(
  input: InvokeJudgeInput,
): Promise<JudgeRubricOutput> {
  // agentResponse lives on PVC, not in the activity input. Read it
  // once before building the prompt.
  const captureFile = await readCaptureFile(input.capturePath);
  const agentResponse = captureFile.capture.response;
  const prompts = getRubricPrompts(input.rubricId);
  const finalExpected =
    input.case.evaluation?.expected_response?.final ?? undefined;
  const userMsg = prompts.user({
    query: input.case.input.query,
    response: agentResponse,
    reference: finalExpected?.reference_text,
    expectedAnswer: finalExpected?.expected_answer,
  });
  const responseFormat = jsonObjectFormat();
  // Templates store the evaluator as a catalog UUID; bifrost requires
  // the resolved "provider/model-name" string. See resolveGatewayModelId
  // for the lookup contract.
  const gatewayModel = await resolveGatewayModelId(
    input.caseRef.projectId,
    input.evaluatorModel,
  );
  const body: ChatCompletionsRequest = {
    model: gatewayModel,
    messages: [
      { role: 'system', content: prompts.system },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    max_tokens: 256,
    ...(responseFormat && { response_format: responseFormat }),
  };

  try {
    const headers = await authHeaders(input.caseRef.projectId, input.evaluatorModel);
    let parsed = parseJudgeReply(extractContent(await chatComplete(body, headers)));
    if (!parsed) {
      logger.warn(
        `invokeJudge rubric=${input.rubricId} returned unparseable content, retrying once`,
      );
      parsed = parseJudgeReply(
        extractContent(await chatComplete(body, headers)),
      );
    }
    if (!parsed) return buildErroredRubric(input, 'malformed_response');
    return {
      rubricId: input.rubricId,
      judgeModelName: input.evaluatorModel,
      judgeVersion: input.evaluatorVersion,
      rubricPromptHash: input.rubricPromptHash,
      score: parsed.score,
      outOf: 1,
      rationale: parsed.rationale,
      mode: input.mode,
      ...(parsed.criteriaScores && { criteriaScores: parsed.criteriaScores }),
    };
  } catch (err) {
    if (err instanceof ApplicationFailure && err.type === 'InvalidInputError') {
      throw err;
    }
    // Retryable failures surface to Temporal; bubble up.
    if (!isHTTPError(err as Error)) throw err;
    const status =
      (err as { response?: { statusCode?: number } }).response?.statusCode ?? 0;
    if (status >= 500) throw err;
    logger.warn(
      `invokeJudge rubric=${input.rubricId} soft-failed: ${(err as Error).message}`,
    );
    return buildErroredRubric(input, (err as Error).message);
  }
}

// ── Pairwise judge ──────────────────────────────────────────────────

/**
 * Stable hash of the rubric *template* — hashes `prompts.system` plus the
 * source of the user-prompt builder, so the value only changes when the
 * template itself is edited (not per call). This lets downstream auditing
 * tell whether a rerun used the same prompt as the original.
 */
function hashRubricTemplate(prompts: {
  system: string;
  user: (...args: never[]) => string;
}): string {
  return createHash('sha256')
    .update(prompts.system)
    .update('\n')
    .update(prompts.user.toString())
    .digest('hex');
}

export async function invokePairwiseJudge(
  input: InvokePairwiseJudgeInput,
): Promise<JudgeRubricOutput> {
  // Both responses live on PVC. Read both captures up front.
  const [captureA, captureB] = await Promise.all([
    readCaptureFile(input.capturePathA),
    readCaptureFile(input.capturePathB),
  ]);
  const responseA = captureA.capture.response;
  const responseB = captureB.capture.response;
  const prompts = getPairwiseRubricPrompts(input.rubricId);
  const rubricPromptHash = hashRubricTemplate(prompts);
  // The pairwise user-prompt builder fences both responses with the same
  // per-call nonce so neither can break out and impersonate the other.
  const userMsg = prompts.user({
    query: input.case.input.query,
    response: responseA,
    responseB,
    reference: input.case.evaluation?.expected_response?.final?.reference_text,
    expectedAnswer:
      input.case.evaluation?.expected_response?.final?.expected_answer,
  });
  const responseFormat = jsonObjectFormat();
  const gatewayModel = await resolveGatewayModelId(
    input.caseRef.projectId,
    input.evaluatorModel,
  );
  const body: ChatCompletionsRequest = {
    model: gatewayModel,
    messages: [
      { role: 'system', content: prompts.system },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
    max_tokens: 256,
    ...(responseFormat && { response_format: responseFormat }),
  };

  try {
    const headers = await authHeaders(input.caseRef.projectId, input.evaluatorModel);
    const parsed = parseJudgeReply(
      extractContent(await chatComplete(body, headers)),
    );
    if (!parsed) {
      return {
        rubricId: input.rubricId,
        judgeModelName: input.evaluatorModel,
        judgeVersion: input.evaluatorVersion,
        rubricPromptHash,
        mode: 'pairwise',
        errored: true,
        rationale: 'malformed_response',
      };
    }
    return {
      rubricId: input.rubricId,
      judgeModelName: input.evaluatorModel,
      judgeVersion: input.evaluatorVersion,
      rubricPromptHash,
      mode: 'pairwise',
      score: parsed.score,
      outOf: 1,
      rationale: parsed.rationale,
      winner: parsed.winner,
      ...(parsed.criteriaScores && { criteriaScores: parsed.criteriaScores }),
    };
  } catch (err) {
    if (!isHTTPError(err as Error)) throw err;
    const status =
      (err as { response?: { statusCode?: number } }).response?.statusCode ?? 0;
    if (status >= 500) throw err;
    return {
      rubricId: input.rubricId,
      judgeModelName: input.evaluatorModel,
      judgeVersion: input.evaluatorVersion,
      rubricPromptHash,
      mode: 'pairwise',
      errored: true,
      rationale: (err as Error).message,
    };
  }
}

function buildErroredRubric(
  input: InvokeJudgeInput,
  reason: string,
): JudgeRubricOutput {
  return {
    rubricId: input.rubricId,
    judgeModelName: input.evaluatorModel,
    judgeVersion: input.evaluatorVersion,
    rubricPromptHash: input.rubricPromptHash,
    mode: input.mode,
    errored: true,
    rationale: reason,
  };
}
