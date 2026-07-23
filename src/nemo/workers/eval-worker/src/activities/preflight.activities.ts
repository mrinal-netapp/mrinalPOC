// runPreflight — fans the 5 pre-flight checks (spec §7.2) in parallel where
// safe; only runtime_estimate depends on earlier outputs (case count after
// filter, expected model / judge calls). Each sub-check writes its own
// PreflightCheck entry; the summary is the worst of { failed, warning, passed }
// aggregated to { blocked, warnings, ready }.

import { gotGet, isHTTPError } from '../lib/got';
import { getLogger } from '../lib/logger';
import type {
  EvaluationJobInput,
  PreflightCheck,
  PreflightCheckId,
  PreflightSummary,
  RuntimeEstimate,
} from '../lib/evaluation';
import { resolveJudgeToggles } from '../lib/evaluation';

const logger = getLogger('server');

export async function runPreflight(input: {
  jobInput: EvaluationJobInput;
}): Promise<PreflightSummary> {
  const { jobInput } = input;

  const parallel = await Promise.all([
    checkDatasetSchema(jobInput),
    checkRetrievalIndex(jobInput),
    checkToolConnectivity(jobInput),
    checkEvaluatorAvailability(jobInput),
  ]);

  const runtimeEstimate = await checkRuntimeEstimate(jobInput);

  const checks: PreflightCheck[] = [...parallel, runtimeEstimate.check];

  return {
    checks,
    runtimeEstimate: runtimeEstimate.estimate,
    summary: summarize(checks),
    ranAt: new Date().toISOString(),
  };
}

// ── Individual checks ───────────────────────────────────────────────

async function checkDatasetSchema(
  _job: EvaluationJobInput,
): Promise<PreflightCheck> {
  // Test-cases schema is validated by the workflow's `validateTestCases`
  // activity, which runs in Phase a before preflight — it reads the
  // JSONL from the PVC, validates each row against the
  // `GoldenTestCase` schema, computes a content hash, and fails the
  // run with `SchemaDrift` on any error. By the time this preflight
  // check executes the test cases have already passed schema
  // validation, so this check is a no-op pass kept for the gate-status
  // table on the run page.
  return passed('dataset_schema');
}

async function checkRetrievalIndex(
  job: EvaluationJobInput,
): Promise<PreflightCheck> {
  const base = process.env['RETRIEVAL_SERVICE_URL'];
  if (!base) return passed('retrieval_index');
  try {
    const res = await gotGet<{ indexVersion: string; healthy: boolean }>(
      `${base}/health`,
    );
    if (res && !res.healthy)
      return failed('retrieval_index', 'retrieval-service unhealthy');
    if (
      res?.indexVersion &&
      res.indexVersion !== job.provenance.retrievalIndexVersion
    ) {
      return {
        id: 'retrieval_index',
        status: 'warning',
        warningMessage: `index version drift: ${job.provenance.retrievalIndexVersion} → ${res.indexVersion}`,
        impact: 'promotion_blocked',
        warningActions: [
          { intent: 'use_latest_index', label: 'Use latest index' },
          { intent: 'retrieval_only_eval', label: 'Run retrieval-only eval' },
          { intent: 'refresh_index', label: 'Refresh index' },
          {
            intent: 'continue_non_promotable',
            label: 'Continue non-promotable',
          },
        ],
      };
    }
    return passed('retrieval_index');
  } catch (err) {
    return softCheckError('retrieval_index', err);
  }
}

async function checkToolConnectivity(
  job: EvaluationJobInput,
): Promise<PreflightCheck> {
  const base = process.env['TOOL_SERVICE_URL'];
  if (!base) return passed('tool_connectivity');
  try {
    const res = await gotGet<{
      registryVersion: string;
      failing: string[];
    }>(`${base}/health`);
    if (res?.failing && res.failing.length > 0) {
      const allowMock = job.overrideIntents?.includes('enable_mock_tools');
      return {
        id: 'tool_connectivity',
        status: allowMock ? 'warning' : 'failed',
        errorMessage: allowMock
          ? undefined
          : `${res.failing.length} tools failing smoke tests: ${res.failing.join(', ')}`,
        warningMessage: allowMock ? 'running with mock tools' : undefined,
      };
    }
    return passed('tool_connectivity');
  } catch (err) {
    return softCheckError('tool_connectivity', err);
  }
}

async function checkEvaluatorAvailability(
  job: EvaluationJobInput,
): Promise<PreflightCheck> {
  // Skip the LLM-gateway probe when the run isn't going to use a judge
  // at all. `resolveJudgeToggles` accepts both the canonical 3-value
  // strategy union and the older spellings transparently.
  const { judgeEnabled } = resolveJudgeToggles(job.evaluators);
  if (!judgeEnabled) {
    return passed('evaluator_availability');
  }
  const base = process.env['LLM_GATEWAY_URL'];
  if (!base) return passed('evaluator_availability');
  const model = job.evaluators.evaluatorModel;
  if (!model) return passed('evaluator_availability');
  // OpenAI-compatible gateways (Bifrost, LiteLLM, etc.) only expose
  // `/v1/chat/completions`, not a per-model `available + quotaRemaining`
  // probe. Send a GET to `/v1/models` with `throwHttpErrors: false` so
  // any HTTP response (200, 404, 405, ...) proves the gateway is
  // reachable; only a real transport fault (DNS, connection refused,
  // timeout) downgrades to a warning. Per-model availability surfaces
  // later in `invokeJudge` (which sets `errored: true` on failures so
  // the `judge_scoring_health` gate still reflects real coverage).
  try {
    await gotGet<unknown>(`${base.replace(/\/$/, '')}/v1/models`, {
      throwHttpErrors: false,
      timeout: { request: 5_000 },
    });
    return passed('evaluator_availability');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `preflight evaluator_availability: gateway unreachable: ${message}`,
    );
    return warning(
      'evaluator_availability',
      `LLM gateway ${base} unreachable: ${message}`,
    );
  }
}

async function checkRuntimeEstimate(
  job: EvaluationJobInput,
): Promise<{ check: PreflightCheck; estimate: RuntimeEstimate }> {
  // Rough heuristic; replace with real cost-model when available.
  const approxCases = estimateCaseCount(job);
  const perCaseTokens = 2500;
  const perJudgeTokens = 1200;
  // `enabledRubric` is optional on the resolved EvaluationJobInput — a
  // deterministic-only template with no AI judge has no rubrics. Default
  // to an empty list so the runtime estimate doesn't crash on undefined.
  const judgeCalls = job.evaluators.enabledRubric?.length ?? 0;

  const estInputTokens = approxCases * perCaseTokens;
  const estOutputTokens = approxCases * 500;
  const estJudgeTokens = approxCases * judgeCalls * perJudgeTokens;
  const totalTokens = estInputTokens + estOutputTokens + estJudgeTokens;
  const estTotalCostUsd = (totalTokens / 1_000_000) * 8; // $8/Mtok ballpark

  const quotaUsd = Number(process.env['EVAL_QUOTA_USD'] ?? '50');
  const withinOrgQuota = estTotalCostUsd <= quotaUsd;

  const estimate: RuntimeEstimate = {
    wallTimeSeconds: Math.ceil((approxCases * 20) / (job.concurrency ?? 10)),
    estInputTokens,
    estOutputTokens: estOutputTokens + estJudgeTokens,
    estTotalCostUsd,
    withinOrgQuota,
  };

  const check: PreflightCheck = withinOrgQuota
    ? {
        id: 'runtime_estimate',
        status: 'passed',
        detailNote: `~${approxCases} cases · $${estTotalCostUsd.toFixed(2)}`,
      }
    : {
        id: 'runtime_estimate',
        status: 'failed',
        errorMessage: `projected cost $${estTotalCostUsd.toFixed(2)} exceeds quota $${quotaUsd.toFixed(2)}`,
      };
  return { check, estimate };
}

function estimateCaseCount(job: EvaluationJobInput): number {
  if (job.testCases.sample.mode === 'all') {
    // Without a server-side count, approximate — config-service returns the
    // real value later in runtime_estimate; keep this as a projection.
    return 100 * (job.models?.length ?? 1);
  }
  if (job.testCases.sample.mode === 'fraction') {
    const frac = job.testCases.sample.fraction ?? 0.1;
    return Math.ceil(100 * frac) * (job.models?.length ?? 1);
  }
  return 50 * (job.models?.length ?? 1);
}

// ── Helpers ─────────────────────────────────────────────────────────

function passed(id: PreflightCheckId): PreflightCheck {
  return { id, status: 'passed' };
}
function warning(id: PreflightCheckId, message: string): PreflightCheck {
  return { id, status: 'warning', warningMessage: message };
}
function failed(id: PreflightCheckId, message: string): PreflightCheck {
  return { id, status: 'failed', errorMessage: message };
}

function softCheckError(id: PreflightCheckId, err: unknown): PreflightCheck {
  const message = err instanceof Error ? err.message : String(err);
  if (isHTTPError(err as Error)) {
    const status =
      (err as { response?: { statusCode?: number } }).response?.statusCode ?? 0;
    if (status >= 500) {
      logger.warn(`preflight ${id} soft-fail (5xx): ${message}`);
      return warning(id, `upstream 5xx during check: ${message}`);
    }
  }
  return failed(id, message);
}

function summarize(checks: PreflightCheck[]): PreflightSummary['summary'] {
  if (checks.some((c) => c.status === 'failed')) return 'blocked';
  if (checks.some((c) => c.status === 'warning')) return 'warnings';
  return 'ready';
}
