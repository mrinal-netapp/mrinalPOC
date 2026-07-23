// Preflight summary (spec §5.6).

export type PreflightCheckId =
  | 'dataset_schema'
  | 'retrieval_index'
  | 'tool_connectivity'
  | 'evaluator_availability'
  | 'runtime_estimate';

export type PreflightStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'warning';

export type PreflightOverrideIntent =
  | 'use_latest_index'
  | 'retrieval_only_eval'
  | 'refresh_index'
  | 'continue_non_promotable'
  | 'open_kb'
  | 'open_tools'
  | 'open_models'
  | 'enable_mock_tools';

export interface PreflightCheck {
  id: PreflightCheckId;
  status: PreflightStatus;
  errorMessage?: string;
  warningMessage?: string;
  impact?: 'degraded_metrics' | 'slower_run' | 'promotion_blocked';
  impactDescription?: string;
  remediation?: {
    title: string;
    steps: string[];
    action?: { label: string; path?: string };
  };
  warningActions?: Array<{ intent: PreflightOverrideIntent; label: string }>;
  detailNote?: string;
}

export interface RuntimeEstimate {
  wallTimeSeconds: number;
  estInputTokens: number;
  estOutputTokens: number;
  estTotalCostUsd: number;
  withinOrgQuota: boolean;
}

export interface PreflightSummary {
  checks: PreflightCheck[];
  summary: 'running' | 'ready' | 'warnings' | 'blocked';
  runtimeEstimate?: RuntimeEstimate;
  ranAt: string;
}
