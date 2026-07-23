import type {
  AgentSessionMessage,
  AgentStreamProvenance,
  AgentTraceSpan,
} from "@/routes/pages/agents/api/agents.types";
import type { PlaygroundRunMetrics } from "./agent-playground.types";

export const TRACE_STEP_SPAN_KINDS = new Set(["AGENT", "LLM", "TOOL"]);

export type PlaygroundTracingStep = {
  id: string;
  name: string;
  spanKind: string;
  durationMs: number | null;
  input: string | null;
  output: string | null;
};

export type FlattenedTraceSpan = {
  span: AgentTraceSpan;
  depth: number;
  durationMs: number | null;
};

export type PlaygroundTraceStatistics = {
  modelName?: string;
  latencyMs?: number;
  totalSpanDurationMs?: number;
  spanCount: number;
  usage?: PlaygroundRunMetrics["usage"];
};

function toTimestampMs(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function getSpanAttributeText(
  attributes: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = attributes?.[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function isTraceStepSpanKind(spanKind?: string | null): boolean {
  if (!spanKind) {
    return false;
  }
  return TRACE_STEP_SPAN_KINDS.has(spanKind.toUpperCase());
}

export function buildTracingStepsFromSpans(spans: AgentTraceSpan[]): PlaygroundTracingStep[] {
  return spans
    .filter((span) => isTraceStepSpanKind(span.span_kind))
    .sort((left, right) => {
      const leftStart = toTimestampMs(left.start_time) ?? Number.MAX_SAFE_INTEGER;
      const rightStart = toTimestampMs(right.start_time) ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart;
    })
    .map((span) => ({
      id: span.context?.span_id ?? span.id,
      name: span.name,
      spanKind: span.span_kind?.toUpperCase() ?? "UNKNOWN",
      durationMs: getSpanDurationMs(span),
      input: getSpanAttributeText(span.attributes, "input.value"),
      output: getSpanAttributeText(span.attributes, "output.value"),
    }));
}

export function getSpanDurationMs(span: AgentTraceSpan): number | null {
  const start = toTimestampMs(span.start_time);
  const end = toTimestampMs(span.end_time);
  if (start === null || end === null || end < start) {
    return null;
  }
  return end - start;
}

export function findLatestAssistantTraceId(messages?: AgentSessionMessage[] | null): string | undefined {
  if (!messages || messages.length === 0) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    if (message.traceId) {
      return message.traceId;
    }
    const metadata = message.metadata as Record<string, unknown> | null | undefined;
    // Persisted shape (GET /sessions/{id}) flattens AssistantMessageMetadata
    // directly under `metadata`; live SSE wraps it in `invokeResponse`.
    const directTraceId = metadata?.traceId;
    if (typeof directTraceId === "string" && directTraceId.length > 0) {
      return directTraceId;
    }
    const invokeResponse = metadata?.invokeResponse as Record<string, unknown> | undefined;
    const traceId = invokeResponse?.traceId;
    if (typeof traceId === "string" && traceId.length > 0) {
      return traceId;
    }
  }

  return undefined;
}

/**
 * Core: turn an `agentTrace[]` array into tracing rows. Each step becomes one
 * AGENT row, with its nested tool executions appended as TOOL rows. Shared by
 * the persisted-message and live-provenance entry points so both render
 * identically.
 */
function tracingStepsFromAgentTraceArray(
  agentTrace: ReadonlyArray<unknown>,
): PlaygroundTracingStep[] {
  const steps: PlaygroundTracingStep[] = [];
  for (const [stepIndex, raw] of agentTrace.entries()) {
    const step = (raw ?? {}) as Record<string, unknown>;
    const agentName = typeof step.agentName === "string" ? step.agentName : "agent";
    const action = typeof step.action === "string" ? step.action : "step";
    const output = typeof step.output === "string" ? step.output : null;
    // ``input`` is the last user / manager / handoff message the agent
    // received this turn. MAF started emitting it for parity with tool I/O;
    // older payloads omit the field so we treat absence / non-strings as
    // "no input recoverable" (null) rather than rendering an empty cell.
    const inputText = typeof step.input === "string" && step.input ? step.input : null;
    steps.push({
      id: `agent-trace-${stepIndex}`,
      name: `${agentName} · ${action}`,
      spanKind: "AGENT",
      durationMs: typeof step.durationMs === "number" ? step.durationMs : null,
      input: inputText,
      output,
    });

    const execs = step.toolExecutions;
    if (!Array.isArray(execs)) continue;
    for (const [execIndex, rawExec] of execs.entries()) {
      const te = (rawExec ?? {}) as Record<string, unknown>;
      const toolName = typeof te.toolName === "string" ? te.toolName : "tool";
      const errorMsg = typeof te.error === "string" ? te.error : null;
      const resultText = typeof te.resultSummary === "string" ? te.resultSummary : null;
      const isFailure = !!errorMsg || (resultText?.startsWith("ERROR:") ?? false);
      steps.push({
        id: `agent-trace-${stepIndex}-tool-${execIndex}`,
        name: isFailure ? `${toolName} (failed)` : toolName,
        spanKind: "TOOL",
        durationMs: typeof te.durationMs === "number" ? te.durationMs : null,
        input: te.arguments != null ? JSON.stringify(te.arguments, null, 2) : null,
        output: errorMsg ?? resultText,
      });
    }
  }
  return steps;
}

/**
 * Synthesise tracing steps from MAF's `metadata.invokeResponse.citations.agentTrace[]`
 * for sessions where Phoenix spans aren't available (`traceId` is null / OTLP not wired).
 * Each agent-trace step becomes one row, with nested tool executions appended after it.
 */
export function buildTracingStepsFromAgentTrace(
  messages: AgentSessionMessage[] | undefined,
): PlaygroundTracingStep[] {
  if (!messages || messages.length === 0) return [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;

    const metadata = message.metadata as Record<string, unknown> | null | undefined;
    // Persisted shape (GET /sessions/{id}) puts citations directly under
    // `metadata`; live SSE wraps it in `invokeResponse`. Accept both.
    const invokeResponse = metadata?.invokeResponse as Record<string, unknown> | undefined;
    const citations =
      (metadata?.citations as Record<string, unknown> | undefined)
      ?? (invokeResponse?.citations as Record<string, unknown> | undefined);
    const agentTrace = citations?.agentTrace;
    if (!Array.isArray(agentTrace) || agentTrace.length === 0) return [];

    return tracingStepsFromAgentTraceArray(agentTrace);
  }

  return [];
}

/**
 * Live-path counterpart to {@link buildTracingStepsFromAgentTrace}: render the
 * trace timeline from the just-completed run's `lastRunMetrics.provenance`. The
 * persisted-message variant needs a GET /sessions/{id} round-trip that hasn't
 * landed for a brand-new session, so without this the Tracing tab stays empty
 * right after a live invoke even though the agent trace is already in the store.
 */
export function buildTracingStepsFromProvenance(
  provenance: AgentStreamProvenance | undefined | null,
): PlaygroundTracingStep[] {
  const agentTrace = provenance?.agentTrace;
  if (!Array.isArray(agentTrace) || agentTrace.length === 0) return [];
  return tracingStepsFromAgentTraceArray(agentTrace);
}

export function flattenTraceSpans(spans: AgentTraceSpan[]): FlattenedTraceSpan[] {
  if (spans.length === 0) {
    return [];
  }

  const byParent = new Map<string | null, AgentTraceSpan[]>();
  const bySpanId = new Map<string, AgentTraceSpan>();

  for (const span of spans) {
    const spanId = span.context?.span_id ?? span.id;
    if (!spanId) {
      continue;
    }
    bySpanId.set(spanId, span);
  }

  for (const span of spans) {
    const rawParentId = span.parent_id ?? null;
    const parentId = rawParentId && bySpanId.has(rawParentId) ? rawParentId : null;
    const current = byParent.get(parentId) ?? [];
    current.push(span);
    byParent.set(parentId, current);
  }

  const sortByStartTime = (a: AgentTraceSpan, b: AgentTraceSpan): number => {
    const aStart = toTimestampMs(a.start_time) ?? Number.MAX_SAFE_INTEGER;
    const bStart = toTimestampMs(b.start_time) ?? Number.MAX_SAFE_INTEGER;
    return aStart - bStart;
  };

  for (const bucket of byParent.values()) {
    bucket.sort(sortByStartTime);
  }

  const result: FlattenedTraceSpan[] = [];
  const seen = new Set<string>();

  const visit = (span: AgentTraceSpan, depth: number): void => {
    const spanId = span.context?.span_id ?? span.id;
    if (!spanId || seen.has(spanId)) {
      return;
    }
    seen.add(spanId);
    result.push({ span, depth, durationMs: getSpanDurationMs(span) });

    const children = byParent.get(spanId) ?? [];
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  const roots = byParent.get(null) ?? [];
  for (const root of roots) {
    visit(root, 0);
  }

  for (const span of spans) {
    const spanId = span.context?.span_id ?? span.id;
    if (!spanId || seen.has(spanId)) {
      continue;
    }
    visit(span, 0);
  }

  return result;
}

export function getTraceModelName(spans: AgentTraceSpan[]): string | undefined {
  for (const span of spans) {
    const modelName = span.attributes?.["llm.model_name"];
    if (typeof modelName === "string" && modelName.trim().length > 0) {
      return modelName;
    }
  }
  return undefined;
}

export function buildTraceStatistics(
  lastRunMetrics: PlaygroundRunMetrics | null,
  spans: AgentTraceSpan[],
): PlaygroundTraceStatistics {
  const flattened = flattenTraceSpans(spans);
  const rootSpan = flattened.find((item) => item.depth === 0 && item.durationMs !== null);
  const modelName = lastRunMetrics?.modelName ?? getTraceModelName(spans);

  return {
    modelName,
    latencyMs: lastRunMetrics?.latencyMs,
    totalSpanDurationMs: rootSpan?.durationMs ?? undefined,
    spanCount: spans.length,
    usage: lastRunMetrics?.usage,
  };
}
