// Resolver for the high-level `evaluators.strategy` field. Mirrors the
// `scorer-toggles.ts` pattern: a single pure function that the workflows,
// the trigger validator and the UI all consume so the three-strategy rule
// lives in exactly one place.
//
// The three strategies are:
//   • 'deterministic'              — deterministic scorers only.
//   • 'llm_judge'                  — LLM-as-judge rubrics only.
//   • 'deterministic_plus_llm_judge' — both.
//
// Older template values (`'deterministic_only'`, `'deterministic_judge'`)
// are also accepted at the type-erased boundary —
// `normalizeStrategy()` translates them to the canonical spelling. The
// trigger applies the translation at `startEvaluation()` time so the
// persisted workflow input always carries the canonical value;
// workflows themselves still normalize defensively in case a replay
// loads a workflow input written before the rename.

import type {
  EvaluationJobInput,
  EvaluationStrategy,
} from './job-types';

/**
 * What the high-level strategy actually means for the worker. Computed
 * once per run from `evaluators.strategy` and threaded down to children.
 */
export interface ResolvedJudgeToggles {
  /** Are deterministic scorer activities dispatched at all for this run? */
  deterministicEnabled: boolean;
  /** Are LLM-as-judge rubric calls dispatched at all for this run? */
  judgeEnabled: boolean;
  /**
   * Effective rubric IDs to run. Empty when `judgeEnabled === false`, OR
   * when `judgeEnabled === true` but the template configured no rubrics
   * (we surface that as a validation error at `startEvaluation` time).
   */
  rubrics: string[];
  /** Canonical strategy value after normalization. */
  strategy: EvaluationStrategy;
}

/**
 * Accepts both the canonical spelling and the older spellings of the
 * strategy field. Use at every boundary that reads
 * `evaluators.strategy` from untyped data (DB rows, workflow inputs
 * replayed from history, JSON parsed from API requests).
 *
 * Mapping:
 *   • `'deterministic_only'`  → `'deterministic'`
 *   • `'deterministic_judge'` → `'deterministic_plus_llm_judge'`
 *
 * Unknown values are returned unchanged so the caller's existing
 * validation can produce a clear error; we deliberately do not throw
 * here because this helper is used inside replay-sensitive workflow code.
 */
export function normalizeStrategy(
  strategy: EvaluationStrategy | string | undefined,
): EvaluationStrategy {
  if (strategy === 'deterministic_only') return 'deterministic';
  if (strategy === 'deterministic_judge') return 'deterministic_plus_llm_judge';
  // config-service's `validateEvaluators` accepts the short alias
  // `'both'` (see catalog/evaluationRubricCatalog STRATEGIES). Treat it
  // as the same canonical value used internally by the worker.
  if (strategy === 'both') return 'deterministic_plus_llm_judge';
  if (strategy === undefined) return 'deterministic_plus_llm_judge';
  return strategy as EvaluationStrategy;
}

/**
 * Single source of truth for "what does this template's `strategy` mean".
 * Pure, dependency-free, replay-safe.
 */
export function resolveJudgeToggles(
  evaluators: EvaluationJobInput['evaluators'] | undefined,
): ResolvedJudgeToggles {
  const strategy = normalizeStrategy(evaluators?.strategy);
  const deterministicEnabled =
    strategy === 'deterministic' || strategy === 'deterministic_plus_llm_judge';
  const judgeEnabled =
    strategy === 'llm_judge' || strategy === 'deterministic_plus_llm_judge';
  const rubrics = judgeEnabled ? (evaluators?.enabledRubric ?? []) : [];
  return { strategy, deterministicEnabled, judgeEnabled, rubrics };
}
