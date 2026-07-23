// Activity implementations for the evaluation workflows (spec §7).
//
// The exported surface mirrors the `EvalActivities` interface declared in
// `@agent-studio/shared/evaluation`. Workers register this barrel with the
// Temporal SDK; workflows reach each function by name via
// `proxyActivities<EvalActivities>()`.
//
// Domain split:
//   - scoring.activities.ts       — §7.3 (pure scorers + compare helpers)
//   - config-service.activities.ts — §7.1, §7.4 (HTTP → config-service)
//   - testcases.activities.ts     — §7.1.1 validateTestCases (eval-owned JSONL on PVC)
//   - agent.activities.ts         — §7.5 invokeAgent (HTTP → agent-service)
//   - judge.activities.ts         — §7.5 invokeJudge / invokePairwiseJudge
//   - preflight.activities.ts     — §7.2 runPreflight (fans out 6 checks)
//   - observability.activities.ts — §7.4 sendObservabilityTrace
//   - artifact.activities.ts      — §7.6 writeResultsFile / writeStakeholderReport
//   - compare.activities.ts       — §7.8 buildCompareReport (A/B compose)

export * from './scoring.activities';
export * from './config-service.activities';
export * from './testcases.activities';
export * from './agent.activities';
export * from './judge.activities';
export * from './preflight.activities';
export * from './observability.activities';
export * from './artifact.activities';
export * from './compare.activities';
