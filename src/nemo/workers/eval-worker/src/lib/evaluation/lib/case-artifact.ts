// Case run artifact + supporting telemetry shapes (spec §5.4).
//
// Vocabulary (path-only Temporal payloads):
//   - `CaseRef`         — the small identity tuple that flows through every
//                         per-case Temporal activity input. Resolves on PVC
//                         to <runDir>/cases/<caseId>/...
//   - `CaptureFile`     — the per-case capture snapshot written to PVC by
//                         `invokeAgent`. The full `AgentInvocationResult`
//                         (response, retrievedChunks, tool I/O, raw provider
//                         payload, observability trace) lives here; activity
//                         payloads carry only the path to it.
//   - `CaseRunSlot`     — the small per-case state held in the parent's
//                         workflow memory after `runCase` completes. Carries
//                         scorer outputs + numeric metadata + capturePath;
//                         no customer-derived text/payloads.
//   - `CaseRunArtifact` — the denormalized per-case row written into
//                         `results.json` at Phase c. NEVER travels in
//                         workflow memory or activity payloads;
//                         `writeResultsFile` builds it by reading the slot
//                         + capture.json from PVC.

import type { AgentRuntimeOverrides } from './runtime-overrides';

export type FailureCategory =
  | 'retrieval'
  | 'tool'
  | 'safety'
  | 'schema'
  | 'judge_scoring'
  | 'latency_budget';

export type RootCause =
  | 'retrieval_miss'
  | 'ungrounded_synthesis'
  | 'tool_misuse'
  | 'schema_violation'
  | 'instruction_non_adherence'
  | 'safety_refusal_issue'
  | 'performance_cost_regression'
  | 'index_drift'
  | 'prompt_regression'
  | 'sub_agent_missing'
  | 'sub_agent_schema_violation';

export interface Telemetry {
  e2eMs: number;
  ttftMs?: number;
  retrievalMs?: number;
  toolMs?: number;
  inferMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
}

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface Citation {
  id: string;
  refId?: string;
  sourceUri?: string;
  offsetInResponse?: [number, number];
}

export interface RetrievedChunk {
  id: string;
  content: string;
  score: number;
  source: string;
}

export interface PerAgentTelemetry {
  agentName: string;
  role: 'root' | 'sub_agent';
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estCostUsd: number;
  latencyMs: number;
  toolCalls: ToolCallTrace[];
  retrievedChunks?: RetrievedChunk[];
  response?: string;
  retrievalAnnotation?: 'zero_hits' | 'truncated' | null;
}

export interface JudgeRubricOutput {
  rubricId: string;
  judgeModelName: string;
  judgeVersion: string;
  rubricPromptHash: string;
  score?: number;
  outOf?: number;
  rationale?: string;
  criteriaScores?: Array<{ name: string; score: number }>;
  mode: 'pointwise' | 'pairwise';
  winner?: 'A' | 'B' | 'tie';
  errored?: boolean;
}

export interface GoldenAssertionReport {
  final: {
    mustInclude: Array<{
      pattern: string;
      match: 'substring' | 'regex' | 'semantic';
      p0?: boolean;
      satisfied: boolean;
      evidenceSpan?: [number, number];
    }>;
    mustCite: Array<{
      id: string;
      required: boolean;
      satisfied: boolean;
      evidenceCitationId?: string;
    }>;
    forbidden: Array<{
      pattern: string;
      match: 'substring' | 'regex' | 'semantic';
      p0?: boolean;
      violated: boolean;
    }>;
    schemaValid: boolean;
    schemaErrors: string[];
  };
  subAgents: Array<{
    name: string;
    invoked: boolean;
    schemaValid: boolean;
    structuralMatch: {
      score: number;
      missingKeys: string[];
      extraKeys: string[];
    };
    mustInclude: Array<{
      pattern: string;
      match: 'substring' | 'regex' | 'semantic';
      satisfied: boolean;
    }>;
    mustNotInclude: Array<{
      pattern: string;
      match: 'substring' | 'regex' | 'semantic';
      satisfied: boolean;
    }>;
  }>;
}

/**
 * Identity tuple for a per-case run. Carried by every per-case Temporal
 * activity input as a path-only payload. Resolves on PVC to
 * `projects/<pid>/evaluations/<evalId>/runs/<runId>/cases/<caseId>/...`.
 *
 * `model`, `variantId`, `seed` participate in the resolved path so that A/B
 * variants and repeat-N seeds don't collide.
 */
export interface CaseRef {
  projectId: string;
  evalId: string;
  runId: string;
  caseId: string;
  model: string;
  variantId?: string;
  seed?: number;
}

/**
 * The Phase-1 invocation body — agent response + telemetry + provider
 * trace. Used internally by `invokeAgent` as the synthesis target before
 * being persisted to PVC (`CaptureFile.capture`); never crosses an
 * activity boundary as a Temporal payload.
 */
export interface AgentInvocationResult {
  response: string;
  citations: Citation[];
  retrievedChunks: RetrievedChunk[];
  toolCalls: ToolCallTrace[];
  perAgent: PerAgentTelemetry[];
  telemetry: Telemetry;
  retrievalAnnotation: 'zero_hits' | 'truncated' | null;
  resolvedRuntimeParams: AgentRuntimeOverrides;
  trace?: unknown;
  raw?: Record<string, unknown>;
}

/**
 * Capture file written to PVC by `invokeAgent` and read by every downstream
 * per-case activity (scorers, judges, observability, results-file dump).
 *
 * Lives at `<runDir>/cases/<caseId>/<variantId>/<model>/<seed>/capture.json`.
 * Activity payloads carry only the `posix:///` URI of this file; the full
 * customer-derived payload never re-enters Temporal event history.
 */
export interface CaptureFile {
  schemaVersion: 1;
  caseRef: CaseRef;
  envelopeHash: string;
  capturedAt: string;
  capture: AgentInvocationResult;
}

/**
 * Numeric/string headline echoed back from `invokeAgent` to the parent
 * workflow. Bounded size — safe to store inline in Temporal history. The
 * heavy customer payload travels via `capturePath` only.
 */
export interface InvokeAgentTelemetryHeadline {
  e2eMs: number;
  ttftMs?: number;
  retrievalMs?: number;
  inferMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estCostUsd?: number;
}

/**
 * Per-case row written into `results.json` at Phase c.
 *
 * IMPORTANT: this shape is *materialized* by `writeResultsFile` from a
 * `CaseRunSlot` plus a read of the capture.json file at the slot's
 * `capturePath`. It is NEVER passed through Temporal activity
 * inputs/outputs nor held in workflow memory — doing so would put
 * customer-derived payloads back into Temporal event history.
 *
 * Treat this type as a JSON-on-PVC schema, not an in-process exchange shape.
 */
export interface CaseRunArtifact {
  runId: string;
  caseId: string;
  model: string;
  variantId?: string;
  repeatSeed?: number;
  status: 'COMPLETED' | 'FAILED';
  passed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;

  // Phase 1 capture (read from capture.json by writeResultsFile)
  response?: string;
  citations: Citation[];
  retrievedChunks: RetrievedChunk[];
  toolCalls: ToolCallTrace[];
  perAgent: PerAgentTelemetry[];
  retrievalAnnotation: 'zero_hits' | 'truncated' | null;
  rawProviderPayload?: Record<string, unknown>;
  resolvedRuntimeParams: AgentRuntimeOverrides;

  // Phase 2 scorer outputs (carried inline on the slot — small/numeric)
  deterministicMetrics: Record<string, number | null>;
  goldenAssertions?: GoldenAssertionReport;
  judgeRubrics: JudgeRubricOutput[];

  failureCategory?: FailureCategory;
  rootCause?: RootCause;

  telemetry: Telemetry;
  redaction?: { fields: string[] };

  error?: string;
  errorType?: 'quality' | 'infra';

  traceRef?: string;
  /** Posix URI of the capture file on PVC; present on COMPLETED rows. */
  capturePath?: string;
}

/**
 * Per-case state held in the parent's workflow memory after `runCase`
 * completes. Bounded size — safe to scale to the full test-cases set
 * (10k+ cases) without bloating workflow history or memory.
 *
 * The parent passes `CaseRunSlot[]` to `writeResultsFile` at Phase c;
 * the activity reads each slot's `capturePath` from PVC and denormalizes
 * to `CaseRunArtifact[]` for the on-disk `results.json`.
 */
export interface CaseRunSlot {
  caseRef: CaseRef;
  status: 'COMPLETED' | 'FAILED';
  passed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;

  /** Posix URI of capture.json on PVC; present iff invokeAgent succeeded. */
  capturePath?: string;

  /** Telemetry headline returned by invokeAgent (numeric only). */
  telemetry?: InvokeAgentTelemetryHeadline;
  retrievalAnnotation?: 'zero_hits' | 'truncated' | null;
  resolvedRuntimeParams?: AgentRuntimeOverrides;

  // Phase 2 scorer outputs — small/numeric, fine inline
  deterministicMetrics?: Record<string, number | null>;
  goldenAssertions?: GoldenAssertionReport;
  judgeRubrics?: JudgeRubricOutput[];

  failureCategory?: FailureCategory;
  rootCause?: RootCause;
  errorType?: 'quality' | 'infra';
  /** Bounded error message — message + name only, no stack/payload. */
  error?: string;

  traceRef?: string;
}

/**
 * Summary returned from the inline `runCase` helper to the parent
 * AgentEvaluationWorkflow.
 *
 * Carries a `CaseRunSlot` (small) — not a full `CaseRunArtifact`. The
 * parent appends `slot` to its in-memory `perCaseSlots[]` list; Phase c's
 * `writeResultsFile` activity reads the full payload from PVC when
 * serializing `results.json`.
 *
 * The flat fields on the summary exist for cheap parent-side bookkeeping
 * (progress %, recent-failures list) without a structuredClone of the
 * slot on every signal/query.
 */
export interface CaseRunSummary {
  runId: string;
  caseId: string;
  variantId?: string;
  model: string;
  repeatSeed?: number;
  status: 'COMPLETED' | 'FAILED';
  passed: boolean;
  errorType?: 'quality' | 'infra';
  failureCategory?: FailureCategory;
  durationMs: number;
  traceRef?: string;
  /** Small per-case state for parent serialization to `results.json` (Phase c). */
  slot: CaseRunSlot;
}
