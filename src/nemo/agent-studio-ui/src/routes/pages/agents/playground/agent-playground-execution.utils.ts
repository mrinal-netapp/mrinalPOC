import type { AgentCitation, AgentStreamTraceStep } from "../api/agents.types";
import { AGENTS_STRINGS } from "../agents.consts";
import type { PlaygroundExecutionStep } from "./agent-playground.types";

export const SEARCH_KNOWLEDGE_BASE_TOOL_NAME = "search_knowledge_base";

export type PlaygroundKbRetrievalChunk = {
  fileLabel: string;
  path: string;
  scoreLabel: string;
  tokensLabel: string;
};

export type PlaygroundKbRetrievalDetails = {
  knowledgeBaseId?: string;
  topKLabel?: string;
  totalContextLabel?: string;
  query?: string;
  chunks: PlaygroundKbRetrievalChunk[];
  logs?: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(record: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function formatScoreLabel(score: number | undefined): string {
  if (score === undefined) {
    return "—";
  }
  const percent = score <= 1 ? Math.round(score * 100) : Math.round(score);
  return `${percent}%`;
}

function estimateTokenCount(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function extractKbContentTitle(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const match = content.match(/title:\s*(.+)/i);
  return match?.[1]?.trim();
}

function readResultArray(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  const resultRecord = asRecord(result);
  if (!resultRecord) {
    return [];
  }

  const items = resultRecord.result ?? resultRecord.results ?? resultRecord.chunks;
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function readKnowledgeBaseId(items: Record<string, unknown>[]): string | undefined {
  for (const item of items) {
    const knowledgeBaseId = readString(item, "knowledge_base_id", "knowledgeBaseId");
    if (knowledgeBaseId) {
      return knowledgeBaseId;
    }
  }
  return undefined;
}

function mapChunkRecord(record: Record<string, unknown>): PlaygroundKbRetrievalChunk {
  const content = readString(record, "content") ?? "";
  const sourceTitle = readString(record, "title", "path", "source", "file", "name");
  const fileLabel = extractKbContentTitle(content) ?? sourceTitle ?? "—";
  const path = sourceTitle ?? "—";
  const tokens = estimateTokenCount(content);

  return {
    fileLabel,
    path,
    scoreLabel: formatScoreLabel(readNumber(record, "score", "relevance", "relevanceScore")),
    tokensLabel: `${tokens.toLocaleString()} tokens`,
  };
}

function readLogs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const logs = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return logs.length > 0 ? logs : undefined;
}

export function getExecutionStepDisplayName(toolName: string): string {
  if (toolName === SEARCH_KNOWLEDGE_BASE_TOOL_NAME) {
    return AGENTS_STRINGS.EXECUTION_KB_RETRIEVAL_STEP_NAME;
  }
  return toolName;
}

export function isKbRetrievalToolName(toolName: string): boolean {
  return toolName === SEARCH_KNOWLEDGE_BASE_TOOL_NAME;
}

/**
 * KB-vs-Toolset discriminator for execution-step rendering.
 *
 * Preference order: MAF's explicit ``toolType`` field on the tool execution,
 * then the legacy ``search_knowledge_base`` name match (agent-service shape),
 * with everything else falling through to "toolset". Lets new MAF agents
 * surface ``kb_retrieve`` (and any future KB-flavored function) as a KB step
 * without each tool name needing a hardcoded list.
 */
export function isKbRetrievalStep(
  toolName: string,
  toolType?: "kb" | "toolset",
): boolean {
  if (toolType === "kb") return true;
  if (toolType === "toolset") return false;
  return isKbRetrievalToolName(toolName);
}

function chunksFromCitations(
  citations: AgentCitation[],
): PlaygroundKbRetrievalChunk[] {
  return citations.map((c) => {
    const fileLabel = c.source ?? c.documentId ?? "—";
    return {
      fileLabel,
      path: c.source ?? "—",
      scoreLabel: formatScoreLabel(c.score ?? undefined),
      // MAF doesn't surface per-chunk token counts (just an aggregate
      // tokensUsed on the whole call). Leave the per-chunk label blank
      // rather than fabricating a number — the call-level total is
      // rendered separately as totalContextLabel.
      tokensLabel: "",
    };
  });
}

export function parseKbRetrievalDetails(
  args: unknown,
  result: unknown,
  /**
   * Citations carried alongside the tool execution (MAF surfaces these on
   * the wire as ``toolExecutions[].kbCitations``). When present we prefer
   * them over digging through the LLM-facing result blob — they're already
   * normalized to {source, documentId, downloadUrl, knowledgeBaseId, score}.
   */
  kbCitations?: AgentCitation[] | null,
  /** MAF's per-call token estimate (sum of chunk-text bytes ÷ 4). */
  tokensUsed?: number | null,
): PlaygroundKbRetrievalDetails | null {
  const argsRecord = asRecord(args);
  const resultRecord = asRecord(result);
  const resultItems = readResultArray(result);

  const query = readString(argsRecord, "query");
  const citations = kbCitations && kbCitations.length > 0 ? kbCitations : null;

  // Prefer MAF-supplied citation metadata when available; otherwise fall
  // back to mining the result blob (legacy agent-service shape).
  const knowledgeBaseId =
    citations?.find((c) => c.knowledgeBaseId)?.knowledgeBaseId
    ?? readKnowledgeBaseId(resultItems);
  const chunks = citations
    ? chunksFromCitations(citations)
    : resultItems.map(mapChunkRecord);
  const totalTokens =
    typeof tokensUsed === "number" && tokensUsed > 0
      ? tokensUsed
      : resultItems.reduce((total, item) => {
          const content = readString(item, "content") ?? "";
          return total + estimateTokenCount(content);
        }, 0);
  const logs = readLogs(resultRecord?.logs);

  if (!query && !knowledgeBaseId && chunks.length === 0 && !logs) {
    return null;
  }

  return {
    knowledgeBaseId,
    topKLabel: chunks.length > 0 ? `${chunks.length} chunks` : undefined,
    totalContextLabel: totalTokens > 0 ? `${totalTokens.toLocaleString()} tokens` : undefined,
    query,
    chunks,
    logs,
  };
}

export function buildExecutionStepFromToolCall(
  toolCallId: string,
  toolName: string,
  args: unknown,
  result: unknown | undefined,
  status: "running" | "completed" | "failed",
  elapsedMs?: number,
  errorMessage?: string,
  options?: {
    toolType?: "kb" | "toolset";
    kbCitations?: AgentCitation[] | null;
    tokensUsed?: number | null;
  },
): PlaygroundExecutionStep {
  const displayName = getExecutionStepDisplayName(toolName);
  const isKb = isKbRetrievalStep(toolName, options?.toolType);
  const kbRetrievalDetails = isKb
    ? parseKbRetrievalDetails(args, result, options?.kbCitations, options?.tokensUsed)
    : undefined;

  return {
    toolCallId,
    toolName,
    displayName,
    toolType: options?.toolType,
    args: isKb ? undefined : args,
    result: isKb ? undefined : result,
    kbRetrievalDetails: kbRetrievalDetails ?? undefined,
    elapsedMs,
    status,
    errorMessage,
  };
}

/**
 * Build Execution-tab steps from maf's `citations.agentTrace[].toolExecutions[]`.
 *
 * MAF doesn't emit incremental `tool_call`/`tool_result` SSE events — it bundles
 * every tool execution into the final `completed` event's citations envelope. The
 * live Execution tab reads `liveExecutionSteps` (populated only by incremental
 * events) and so stays empty for MAF agents. Deriving steps from the agent trace
 * on run completion lets the just-finished run render its tool calls (including
 * failures) without a persisted GET /sessions/{id} round-trip. Failure detection
 * mirrors `buildExecutionStepsFromSessionMessages` so live and replayed runs agree.
 */
export function buildExecutionStepsFromAgentTrace(
  agentTrace: AgentStreamTraceStep[] | undefined | null,
): PlaygroundExecutionStep[] {
  if (!agentTrace || agentTrace.length === 0) {
    return [];
  }

  const steps: PlaygroundExecutionStep[] = [];
  agentTrace.forEach((step, stepIndex) => {
    (step.toolExecutions ?? []).forEach((te, execIndex) => {
      const toolName = typeof te.toolName === "string" ? te.toolName : undefined;
      if (!toolName) {
        return;
      }
      const toolCallId =
        typeof te.toolCallId === "string" && te.toolCallId.length > 0
          ? te.toolCallId
          : `${toolName}-${stepIndex}-${execIndex}`;
      const resultText = typeof te.resultSummary === "string" ? te.resultSummary : "";
      const looksFailed = !!te.error || resultText.startsWith("ERROR:");
      const errorMessage =
        te.error || (looksFailed && resultText ? resultText : undefined);
      steps.push(
        buildExecutionStepFromToolCall(
          toolCallId,
          toolName,
          te.arguments,
          te.resultSummary,
          looksFailed ? "failed" : "completed",
          typeof te.durationMs === "number" ? te.durationMs : undefined,
          errorMessage ?? undefined,
          {
            toolType: te.toolType,
            kbCitations: te.kbCitations ?? undefined,
            tokensUsed: te.tokensUsed ?? undefined,
          },
        ),
      );
    });
  });
  return steps;
}
