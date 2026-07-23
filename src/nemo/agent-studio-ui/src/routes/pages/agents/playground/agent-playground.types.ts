import type {
  AgentCitation,
  AgentStreamProvenance,
} from "@/routes/pages/agents/api/agents.types";

export type PlaygroundChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming?: boolean;
  latencyMs?: number;
  modelName?: string;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  };
  citations?: AgentCitation[];
};

export type PlaygroundKbStat = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  retrievedChunks: number;
  tokensUsed: number;
};

export type PlaygroundToolStat = {
  toolName: string;
  serverName: string;
  serverId: string;
  status: string;
  latencyMs: number;
  /**
   * MAF tool discriminator surfaced on the wire (``toolType: "kb" | "toolset"``).
   * The Configuration tab filters this list so KB-flavored tools (like
   * ``kb_retrieve``) don't leak into the "Toolsets" section — they're
   * already represented via :type:`PlaygroundKbStat`. Optional for legacy
   * agent-service payloads that don't carry the field yet.
   */
  toolType?: "kb" | "toolset";
};

export type PlaygroundRunModelConfig = {
  temperature?: number;
  topP?: number | null;
  maxTokens?: number;
  topK?: number;
};

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

/**
 * Live per-participant status for a multi-agent (team) run. Built from the
 * `agent_started` / `agent_completed` SSE events so the playground can show
 * which agent is currently running and when each turn started/finished. One
 * entry per agent turn, in execution order.
 */
export type PlaygroundAgentActivity = {
  agentName: string;
  status: "running" | "completed";
  /** ISO-8601 UTC start timestamp. */
  startedAt?: string;
  /** ISO-8601 UTC completion timestamp (set when status === "completed"). */
  completedAt?: string;
  /** Wall-clock duration of the turn in ms (set on completion). */
  durationMs?: number;
};

export type PlaygroundExecutionStep = {
  toolCallId: string;
  toolName: string;
  displayName?: string;
  /**
   * Tool category surfaced by MAF (`"kb"` | `"toolset"`). Drives the
   * right-rail panel layout: KB shows chunks/scores/sources; Toolset
   * shows args/result raw. Optional for legacy paths that didn't have a
   * discriminator (the call site treats absence as toolset, except for
   * the legacy ``search_knowledge_base`` tool name which is still
   * detected by name).
   */
  toolType?: "kb" | "toolset";
  args?: unknown;
  result?: unknown;
  kbRetrievalDetails?: PlaygroundKbRetrievalDetails;
  elapsedMs?: number;
  status: "running" | "completed" | "failed";
  errorMessage?: string;
};

export type PlaygroundRunMetrics = {
  sessionId: string;
  traceId?: string;
  latencyMs?: number;
  usage?: {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
  };
  modelName?: string;
  kbStats?: PlaygroundKbStat[];
  toolStats?: PlaygroundToolStat[];
  modelConfig?: PlaygroundRunModelConfig;
  citations?: AgentCitation[];
  executionSteps?: PlaygroundExecutionStep[];
  provenance?: AgentStreamProvenance;
};
