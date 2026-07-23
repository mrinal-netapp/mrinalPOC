# eval-worker

Temporal worker that hosts the agent evaluation engine (spec
`EVAL_BACKEND_TEMPORAL_TECH_SPEC.md`).

## Workflows

All workflows live under `src/workflows/` and are pre-bundled by
`scripts/bundle-workflows.ts` before webpack (same pattern as `scan-worker`).

Architecture v3 keeps a single flat workflow here. Run modes (single,
regression, A/B, sweep, repeats, reshard) are now COMPOSITION patterns owned
by config-service: it runs `AgentEvaluationWorkflow` once per variant / config /
seed and stitches the outputs together via dedicated activities (e.g.
`buildCompareReport`).

| Workflow                  | Role   | Purpose                                                                                                                       |
| ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `AgentEvaluationWorkflow` | sole   | Phase a (preflight → load → shard → fan-out) → Phase b (aggregate + gate) → Phase c (write `results.json` + stakeholder PDF). |

Per-case work runs inline via the `runCase()` helper in
`src/workflows/run-case.ts` — a plain async function called from the
parent's bounded worker pool. It is NOT a child Temporal workflow:
its activities (`invokeAgent`, `score*`, `invokeJudge`,
`sendObservabilityTrace`) appear directly in the parent's event
history with no intervening child-workflow rows. Per-activity
retry/timeout proxies preserve the granularity that used to live in
the child.

Workflow names, signal/query identifiers, timeouts, and concurrency defaults
are centralised in `@agent-studio/shared/evaluation` (`workflow-signals.ts`).

## Activities

Activities hold all I/O so the workflows stay deterministic. Their signatures
are the single source of truth on `EvalActivities` in
`@agent-studio/shared/evaluation` (`activity-signatures.ts`). Implementations
must match the interface exactly; the worker barrel at
`src/activities/index.ts` re-exports them.

Expected surface (by spec §7 section):

- **§7.1 Test cases** — `validateTestCases` (reads eval-owned JSONL on PVC, validates rows, content-hash check), `loadFailedCaseIds`
- **§7.2 Preflight** — `runPreflight` (composes `checkDatasetSchema`, `checkRetrievalIndex`, `checkToolConnectivity`, `checkEvaluatorAvailability`, `checkRuntimeEstimate`)
- **§7.3 Scoring** — `scoreGoldenAssertions`, `scoreSuiteDeterministic`, `scoreGolden`, `scoreSafetyClassifier`, `aggregateMetrics`, `computeGates`, `compareToBaseline`
- **§7.4 Persistence** — `updateJobStatus`, `updateJobResults`, `recordTradeoffDecision`, `writeAuditEvent`, `sendObservabilityTrace`, `getEvaluationJob`, `loadEvaluationResults`, `loadCaseArtifacts`
- **§7.5 Agent / judge** — `invokeAgent`, `invokeJudge`, `invokePairwiseJudge`
- **§7.6 Artifacts** — `writeResultsFile`, `writeStakeholderReport`
- **§7.8 Compare** — `enforceComparability`, `computeSliceDeltas`, `computeMetricComparisons`, `buildTradeoffPanel`, `buildCompareReport`
- **§7.9 Tuning** — `enumerateConfigs`, `selectPhaseWinners`, `proposeNextConfigs`, `computeCriterionScore`, `persistTuningArtifact`
- (misc) `promoteToRegression`

Pure activities (scoring, gating, tuning math) ship real implementations.
HTTP-backed activities (`invokeAgent`, `invokeJudge`, report generation,
promotion, etc.) use the local `src/lib/got.ts` wrappers
(built on top of `got`) with the env vars listed below and expect the matching service endpoints.

## Task queue

`EVAL_TASK_QUEUE = 'eval-task-queue'` — exported from
`@agent-studio/shared/evaluation`.

## Signals & queries

- Signals: `evaluation.cancel`, `evaluation.tradeoff.record`, `evaluation.override.accept`
- Queries: `evaluation.progress`, `evaluation.results`, `evaluation.preflight`

Soft cancel drains in-flight children for `STOP_GRACE_SECONDS` (default 120s)
before scoring partial results and marking the run `stopped` +
`preFlightNonPromotable`.

## Required env vars

| Var                         | Consumed by                                                     |
| --------------------------- | --------------------------------------------------------------- |
| `CONFIG_SERVICE_URL`        | every persistence + dataset + audit activity                    |
| `AGENT_SERVICE_URL`         | `invokeAgent` (spec §7.5)                                       |
| `AGENT_SERVICE_TOKEN`       | `invokeAgent` bearer auth (optional)                            |
| `LLM_GATEWAY_URL`           | `invokeJudge` / `invokePairwiseJudge`                           |
| `LLM_GATEWAY_TOKEN`         | judge bearer auth (optional)                                    |
| `OBSERVABILITY_SERVICE_URL` | `sendObservabilityTrace` (optional)                             |
| `NEMO_DEFAULT_STORE_ROOT` (default `/mnt/pvcs/default-nemo`) | POSIX-on-PVC root for `writeResultsFile`, `writeStakeholderReport`, `buildCompareReport`. Artifacts land under `{root}/projects/{projectId}/evaluations/{evalId}/runs/{runId}/`. |
| `RETRIEVAL_SERVICE_URL`     | preflight `retrieval_index` check                               |
| `TOOL_SERVICE_URL`          | preflight `tool_connectivity` check                             |
| `EVAL_QUOTA_USD`            | preflight runtime-estimate ceiling (default 50)                 |
| `TEMPORAL_ADDRESS`          | worker + trigger-eval dev harness                               |
| `TEMPORAL_NAMESPACE`        | worker + trigger-eval dev harness                               |

## Build & run

```bash
# From server/
nx build eval-worker      # bundles workflows, then webpack-builds the worker
nx serve eval-worker      # runs the worker (long-running, connects to Temporal)
```

The `build` target runs `bundle-workflows` first. Temporal's workflow bundler
does not read `tsconfig.base.json` path aliases, so
`scripts/bundle-workflows.ts` injects a webpack alias that routes
`@agent-studio/shared/evaluation` → `libs/shared/evaluation/src/workflow-safe.ts`.
The workflow-safe barrel exports only types + constants + signal/query names
— trigger.ts (client SDK + `node:crypto`) is excluded so the bundle stays
sandbox-compatible.

## Testing

Tests stack up in three layers — pick the right layer for the behaviour you
want to verify.

### 1. Pure activity tests (fastest, no Temporal)

Pure scoring / tuning / gating activities are plain TS functions and get
direct unit tests. Example: `src/activities/scoring.activities.test.ts`
covers `scoreGoldenAssertions`, `scoreGolden`, `scoreSafetyClassifier`,
`aggregateMetrics`, `computeGates`, `compareToBaseline`.

```bash
nx test eval-worker
```

### 2. Workflow tests with mocked activities

Workflow tests mock `@temporalio/workflow`'s `proxyActivities`, `setHandler`,
etc. so the workflow body can be exercised as a normal async function. The
parent test additionally mocks `../../src/workflows/run-case` so the per-case
inline helper is replaced by a stub that returns a `CaseRunSummary`. Pattern
(see `test/workflows/run-case.test.ts`):

```ts
jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ invokeAgent: (...a) => mockInvokeAgent(...a), ... }),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isCancellation: () => false,
  ...
}));

import { runCase } from '../../src/workflows/run-case';
// ...
const summary = await runCase({ /* input */ });
expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
```

Add one test file per workflow. Covers: signals, queries, phase ordering,
error classification, fan-out behaviour.

### 3. End-to-end via local Temporal + dev harness

For realistic wiring — workflow registration, activity dispatch, signals, and
queries — run the worker against a local Temporal and trigger it with the dev
harness.

```bash
# terminal 1: dev Temporal
temporal server start-dev       # https://github.com/temporalio/cli

# terminal 2: the worker
cd server
CONFIG_SERVICE_URL=http://localhost:3000 \
AGENT_SERVICE_URL=http://localhost:4000 \
LLM_GATEWAY_URL=http://localhost:5000 \
TEMPORAL_ADDRESS=localhost:7233 \
TEMPORAL_NAMESPACE=default \
  nx serve eval-worker

# terminal 3: fire a job
cd server
TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=default \
  nx run eval-worker:trigger-eval -- --runMode single --models gpt-4o
```

`scripts/trigger-eval.ts` starts the workflow via `startEvaluation`, polls
`evaluation.progress` every 2 seconds, and prints the final
`evaluation.results` snapshot plus the workflow return value. Flags:

- `--models gpt-4o,claude-3-5-sonnet` (comma-separated)
- `--datasetId`, `--datasetVersion`, `--evaluationId`, `--agentSnapshotId`
- `--baselineJobId` (regression composition; sets `regression.baselineJobId`)

Point the env vars at mock/stub services (e.g. a simple Express app that
echoes a canned `AgentInvocationResult`) to run the full workflow path
without needing real config-service / agent-service / llm-gateway.

### What each test target does

```bash
nx typecheck eval-worker          # tsc --noEmit on tsconfig.app.json
nx lint eval-worker               # eslint .
nx test eval-worker               # jest --coverage (14 tests today)
nx build eval-worker              # bundle-workflows + webpack build
nx run eval-worker:trigger-eval   # dev harness (requires Temporal + env vars)
```

### Coverage thresholds

`jest.config.js` ships with relaxed thresholds (lines/branches ≥ 10%) while
the v2 scaffolding is new. Every PR that adds activity or workflow logic
should add corresponding tests; ratchet the floor up as coverage grows
(`TODO(AIAS-EVAL-COVERAGE)` in `jest.config.js`).
