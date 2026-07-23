// A/B comparison shapes (spec §5.3.2). A/B is a config-service composition
// pattern that runs `AgentEvaluationWorkflow` once per variant and stitches
// the results via `buildCompareReport`.

import type { AgentRuntimeOverrides } from './runtime-overrides';

export interface ABVariantSpec {
  variantId: string;
  label: string;
  overrides: AgentRuntimeOverrides;
}

export interface ComparabilityIssue {
  type: 'blocker' | 'warning' | 'info';
  ruleId: string;
  message: string;
  affectedField?: string;
}

export interface MetricComparison {
  id: string;
  variantAValue: number | null;
  variantBValue: number | null;
  delta: number | null;
  deltaPercent: number | null;
  significant: boolean;
  pValue?: number;
}

export interface SliceDelta {
  sliceKey: string;
  metricId: string;
  delta: number;
  deltaPercent: number;
}

export interface TradeoffView {
  axes: Array<{
    metricId: string;
    variantA: number | null;
    variantB: number | null;
  }>;
  summary: string;
}
