// Resolver for the deterministic-scorer gating flags on
// `EvaluationJobInput.evaluators` (no-golden eval scorer gating).
//
// The resolution rule lives here — in a single, pure, dependency-free
// function — so both the eval-worker workflows and the configuration UI use
// the same logic to decide which of the four deterministic scorer activities
// to run for a given template.
//
// Inputs (on `evaluators`):
//   • `goldenAvailable` (coarse, default `true`): whether the dataset
//     carries golden ground-truth. When `false`, the two golden-only
//     scorers (`scoreGoldenAssertions`, `scoreGolden`) default to off; the
//     two "mixed" scorers (`scoreSuiteDeterministic`, `scoreSafetyClassifier`)
//     stay on because they still emit reference-free sub-metrics (e.g.
//     `rag.groundedness`, `safety.refusalQuality`).
//   • `scorers.{name}` (fine, optional): per-scorer override. When provided
//     it wins over the coarse default. Use it to opt back into a
//     golden-only scorer on a no-golden run, or to opt out of a
//     reference-free scorer for cost reasons.
//
// Backward compatibility: templates that predate this feature have neither
// field set, so the resolver returns "all four scorers on" — identical to
// the previous unconditional behavior.
//
// See also:
//   • `metrics-catalog.ts` — which metric IDs each scorer can emit.
//   • `doc/EVAL_BACKEND_TEMPORAL_TECH_SPEC.md` §10.0 — narrative + examples.

import type { EvaluationJobInput } from './job-types';

/**
 * Effective per-scorer on/off matrix. The workflow consumes this directly
 * to decide whether to invoke each deterministic scoring activity.
 */
export interface ResolvedScorerToggles {
  /** `scoreGoldenAssertions` — must-include / must-cite / forbidden / schema. */
  goldenAssertions: boolean;
  /** `scoreGolden` — em / bleu / rougeL / tokenF1 against expected text. */
  golden: boolean;
  /** `scoreSuiteDeterministic` — suite-specific deterministic metrics. */
  suiteDeterministic: boolean;
  /** `scoreSafetyClassifier` — unsafe / falseRefusal / boundary / refusalQuality. */
  safetyClassifier: boolean;
}

/**
 * Single source of truth for "which deterministic scorers does this
 * template want to run". Pure — no logging, no I/O, replay-safe so it can
 * be called from inside a Temporal workflow.
 */
export function resolveScorerToggles(
  evaluators: EvaluationJobInput['evaluators'] | undefined,
): ResolvedScorerToggles {
  const goldenAvailable = evaluators?.goldenAvailable ?? true;
  const overrides = evaluators?.scorers ?? {};

  return {
    goldenAssertions: overrides.goldenAssertions ?? goldenAvailable,
    golden: overrides.golden ?? goldenAvailable,
    // Mixed scorers default ON regardless of `goldenAvailable` — they
    // produce useful reference-free metrics in no-golden runs. Operators
    // can still opt out per scorer if they're paying for tokens they don't
    // need.
    suiteDeterministic: overrides.suiteDeterministic ?? true,
    safetyClassifier: overrides.safetyClassifier ?? true,
  };
}
