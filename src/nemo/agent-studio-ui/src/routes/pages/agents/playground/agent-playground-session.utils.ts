import type {
  AgentCitation,
  AgentSessionDetailResponse,
  AgentSessionMessage,
  AgentSessionSummary,
  AgentTokenUsage,
} from "@/routes/pages/agents/api/agents.types";
import { NEW_CONVERSATION_SESSION_ID } from "../agents.consts";
import { buildExecutionStepFromToolCall } from "./agent-playground-execution.utils";
import type {
  PlaygroundChatMessage,
  PlaygroundExecutionStep,
  PlaygroundKbStat,
  PlaygroundRunMetrics,
  PlaygroundRunModelConfig,
  PlaygroundToolStat,
} from "./agent-playground.types";
function createSessionMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

type SessionToolCall = {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  latencyMs?: number;
  error?: string | null;
};

function readInvokeResponse(message: AgentSessionMessage): Record<string, unknown> | null {
  return asRecord(readAssistantMetadata(message)?.invokeResponse);
}

/**
 * Returns the MAF Citations envelope from either shape:
 * - persisted shape (GET /sessions/{id}): `metadata.citations`
 * - live SSE / invoke shape: `metadata.invokeResponse.citations`
 */
function readMafCitations(message: AgentSessionMessage): Record<string, unknown> | null {
  return (
    asRecord(readAssistantMetadata(message)?.citations)
    ?? asRecord(readInvokeResponse(message)?.citations)
  );
}

function readMafAgentTrace(message: AgentSessionMessage): Record<string, unknown>[] {
  const steps = readMafCitations(message)?.agentTrace;
  return Array.isArray(steps) ? (steps as Record<string, unknown>[]) : [];
}

function mafToolExecutionsAsToolCalls(message: AgentSessionMessage): SessionToolCall[] {
  const calls: SessionToolCall[] = [];
  for (const [stepIndex, step] of readMafAgentTrace(message).entries()) {
    const execs = step?.toolExecutions;
    if (!Array.isArray(execs)) continue;
    for (const [execIndex, raw] of execs.entries()) {
      const te = asRecord(raw);
      if (!te) continue;
      const toolName = typeof te.toolName === "string" ? te.toolName : undefined;
      if (!toolName) continue;
      const rawId = typeof te.toolCallId === "string" && te.toolCallId.length > 0
        ? te.toolCallId
        : `${toolName}-${stepIndex}-${execIndex}`;
      const errorField = typeof te.error === "string" ? te.error : null;
      calls.push({
        toolCallId: rawId,
        toolName,
        args: te.arguments,
        result: te.resultSummary,
        latencyMs: typeof te.durationMs === "number" ? te.durationMs : undefined,
        error: errorField,
      });
    }
  }
  return calls;
}

/**
 * Flatten the per-tool, per-chunk KB citations from MAF's persisted agent
 * trace (`metadata.citations.agentTrace[].toolExecutions[].kbCitations[]`).
 * These carry the `score` field that the flat top-level `kbCitations` aggregate
 * drops, so they're the authoritative source for "Average relevance". Returns
 * an empty list when the payload predates per-tool citations.
 */
function readMafScoredCitations(message: AgentSessionMessage): AgentCitation[] {
  const citations: AgentCitation[] = [];
  for (const step of readMafAgentTrace(message)) {
    const execs = step?.toolExecutions;
    if (!Array.isArray(execs)) continue;
    for (const rawExec of execs) {
      const kbCitations = asRecord(rawExec)?.kbCitations;
      if (!Array.isArray(kbCitations)) continue;
      for (const rawCitation of kbCitations) {
        const citation = asRecord(rawCitation);
        if (citation) {
          citations.push(citation as AgentCitation);
        }
      }
    }
  }
  return citations;
}

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

function readAssistantMetadata(message: AgentSessionMessage): Record<string, unknown> | null {
  return asRecord(message.metadata);
}

function readMessageLatencyMs(message: AgentSessionMessage): number | undefined {
  return message.latencyMs ?? readNumber(readAssistantMetadata(message), "durationMs", "duration_ms");
}

function readMessageTraceId(message: AgentSessionMessage): string | undefined {
  return (
    message.traceId
    ?? readString(readAssistantMetadata(message), "traceId", "trace_id")
    ?? readString(readInvokeResponse(message), "traceId", "trace_id")
  );
}

function readMessageModelName(message: AgentSessionMessage): string | undefined {
  return message.modelName ?? readString(readAssistantMetadata(message), "modelName", "model_name");
}

function readMessageUsage(message: AgentSessionMessage): AgentTokenUsage | null | undefined {
  return message.usage ?? (readAssistantMetadata(message)?.usage as AgentTokenUsage | undefined);
}

function readMessageCitations(message: AgentSessionMessage): AgentCitation[] | undefined {
  if (message.citations) {
    return message.citations;
  }
  const metadata = readAssistantMetadata(message);
  const citations = metadata?.citations;
  if (!citations || typeof citations !== "object") {
    return undefined;
  }
  const kbCitations = (citations as Record<string, unknown>).kbCitations
    ?? (citations as Record<string, unknown>).kb_citations;
  if (Array.isArray(kbCitations)) {
    return kbCitations as AgentCitation[];
  }
  return undefined;
}

function readMessageToolCalls(message: AgentSessionMessage): SessionToolCall[] {
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    return message.toolCalls as SessionToolCall[];
  }
  const metadata = readAssistantMetadata(message);
  const toolCalls = metadata?.toolCalls ?? metadata?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls as SessionToolCall[];
  }
  // MAF surfaces tool calls inside metadata.invokeResponse.citations.agentTrace[].toolExecutions[].
  return mafToolExecutionsAsToolCalls(message);
}

function readMessageKbStats(message: AgentSessionMessage): PlaygroundKbStat[] | undefined {
  if (message.kbStats) {
    return message.kbStats;
  }
  return undefined;
}

function readMessageToolStats(message: AgentSessionMessage): PlaygroundToolStat[] | undefined {
  if (!message.toolStats) {
    return undefined;
  }
  return message.toolStats.map((stat) => ({
    toolName: stat.toolName,
    serverName: stat.serverName ?? "",
    serverId: stat.serverId ?? "",
    status: stat.status,
    latencyMs: stat.latencyMs,
  }));
}

function readMessageModelConfig(message: AgentSessionMessage): PlaygroundRunModelConfig | undefined {
  return message.modelConfig ?? undefined;
}

export function isNewConversationSessionId(sessionId: string | null | undefined): boolean {
  return !sessionId || sessionId === NEW_CONVERSATION_SESSION_ID;
}

export function getAgentSessionSummaryId(session: {
  sessionId?: string;
  id?: string;
}): string {
  return session.sessionId ?? session.id ?? "";
}

/** Merge API sessions with ids from recent stream invokes until the list query refetches. */
export function mergeAgentSessionSummaries(
  apiSessions: AgentSessionSummary[],
  pendingSessionIds: readonly string[],
): AgentSessionSummary[] {
  if (pendingSessionIds.length === 0) {
    return apiSessions;
  }

  const knownIds = new Set(
    apiSessions
      .map((session) => getAgentSessionSummaryId(session))
      .filter((sessionId) => sessionId.length > 0),
  );

  const pendingOnly = pendingSessionIds
    .filter((sessionId) => sessionId.length > 0 && !knownIds.has(sessionId))
    .map((sessionId) => ({ sessionId, name: "" }));

  if (pendingOnly.length === 0) {
    return apiSessions;
  }

  return [...pendingOnly, ...apiSessions];
}

export function sessionMessagesToPlaygroundMessages(
  messages: AgentSessionMessage[] | undefined,
): PlaygroundChatMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  return messages.map((message, index) => {
    const stableId = message.timestamp
      ? `session-${message.timestamp}-${index}`
      : createSessionMessageId();

    if (message.role === "user") {
      return {
        id: stableId,
        role: "user",
        content: message.content,
      };
    }

    return {
      id: stableId,
      role: "assistant",
      content: message.content,
      latencyMs: readMessageLatencyMs(message),
      modelName: readMessageModelName(message),
      usage: readMessageUsage(message) ?? undefined,
      citations: readMessageCitations(message),
    };
  });
}

export function buildExecutionStepsFromSessionMessages(
  messages: AgentSessionMessage[] | undefined,
): PlaygroundExecutionStep[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const toolCalls = readMessageToolCalls(message);
    if (toolCalls.length === 0) {
      return [];
    }

    return toolCalls
      .filter((toolCall) => toolCall.toolCallId && toolCall.toolName)
      .map((toolCall) => {
        const resultText = typeof toolCall.result === "string" ? toolCall.result : "";
        const looksFailed = !!toolCall.error || resultText.startsWith("ERROR:");
        const errorMessage = toolCall.error
          || (looksFailed && resultText ? resultText : undefined);
        return buildExecutionStepFromToolCall(
          toolCall.toolCallId as string,
          toolCall.toolName as string,
          toolCall.args,
          toolCall.result,
          looksFailed ? "failed" : "completed",
          toolCall.latencyMs,
          errorMessage ?? undefined,
        );
      });
  }

  return [];
}

function findLatestAssistantMessage(
  messages: AgentSessionMessage[] | undefined,
): AgentSessionMessage | undefined {
  if (!messages) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      return message;
    }
  }

  return undefined;
}

export function buildPlaygroundRunMetricsFromSessionDetail(
  session: AgentSessionDetailResponse | undefined,
  selectedSessionId?: string | null,
): PlaygroundRunMetrics | null {
  if (!session) {
    return null;
  }

  const sessionId = session.sessionId || selectedSessionId;
  if (!sessionId) {
    return null;
  }

  const latestAssistant = findLatestAssistantMessage(session.messages);
  if (!latestAssistant) {
    return { sessionId, executionSteps: [] };
  }

  // Prefer the scored per-tool citations from the agent trace so "Average
  // relevance" can be computed; fall back to the flat top-level aggregate
  // (which lacks `score`) only when the trace has no per-tool citations.
  const scoredCitations = readMafScoredCitations(latestAssistant);
  const citations =
    scoredCitations.length > 0 ? scoredCitations : readMessageCitations(latestAssistant);

  return {
    sessionId,
    traceId: readMessageTraceId(latestAssistant),
    latencyMs: readMessageLatencyMs(latestAssistant),
    usage: readMessageUsage(latestAssistant) ?? undefined,
    modelName: readMessageModelName(latestAssistant),
    kbStats: readMessageKbStats(latestAssistant),
    toolStats: readMessageToolStats(latestAssistant),
    modelConfig: readMessageModelConfig(latestAssistant),
    citations,
    executionSteps: buildExecutionStepsFromSessionMessages(session.messages),
  };
}
