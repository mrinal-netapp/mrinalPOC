import type { EvalScoringStrategy } from '@/routes/pages/evaluations/api/eval.types';

export const DESCRIPTION_MAX_LENGTH = 500;

export const EVAL_NAME_PATTERN = /^[a-zA-Z0-9\s\-_]+$/;

export const STRATEGY_OPTIONS: {
  value: EvalScoringStrategy;
  title: string;
  description: string;
}[] = [
  {
    value: 'both',
    title: 'Deterministic with AI judge (Recommended)',
    description:
      'Combines fast checks with AI-generated scores. Each dimension provides a score and rationale for reviewers and audits.',
  },
  {
    value: 'deterministic',
    title: 'Deterministic',
    description:
      'No AI judging. Best when telemetry, contracts, or reference metrics alone answer the promotion question.',
  },
];
