export type AgentMemoryType = "none" | "conversation" | "sliding_window";

export type AgentStatus = "Healthy" | "Unhealthy";

export type AgentDeploymentStatus =
  | "draft"
  | "preview"
  | "not_deployed"
  | "deploying"
  | "deployed"
  | "failed"
  | "terminating"
  | "terminated";

/** Lightweight entity reference returned by the enriched agent read shape. */
export type AgentEntityRef = {
  id: string;
  name: string;
};

/** Model summary returned on the enriched agent read shape. */
export type AgentModelSummary = {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
  gatewayModelId?: string;
};

/** Read-only resources the config-service attaches to each agent on list/get. */
export type AgentAssociatedResources = {
  knowledgeBases: AgentEntityRef[];
  agentTeams: AgentEntityRef[];
};

export type AgentRagSearchMode = "semantic" | "hybrid" | "fts";

export type AgentRagConfig = {
  topK: number;
  similarityThreshold: number;
  searchMode: AgentRagSearchMode;
  rerankingEnabled?: boolean;
  similarityThresholdEnabled?: boolean;
};

export type AgentMemoryConfig = {
  windowSize?: number;
  contextStrategy?: string;
};

export type AgentGuardrails = {
  maxIterations?: number;
  timeoutSeconds?: number;
  contentFilters?: unknown[];
};

export type Agent = {
  id: string;
  projectId?: string;
  name: string;
  description?: string | null;
  role: string;
  systemPrompt: string;
  modelId?: string | null;
  modelClass?: string | null;
  temperature?: number;
  maxTokens?: number;
  mcpServerIds?: string[];
  knowledgeBaseIds?: string[];
  ragConfig?: Record<string, AgentRagConfig> | null;
  memoryType?: AgentMemoryType;
  memoryConfig?: AgentMemoryConfig | null;
  guardrails?: AgentGuardrails | null;
  labels?: string[];
  status?: AgentStatus;
  statusMessage?: string | null;
  deploymentStatus?: AgentDeploymentStatus;
  createdAt?: string;
  updatedAt?: string;
  // Read-only annotations attached by the config-service enriched read shape.
  model?: AgentModelSummary | null;
  fallbackModels?: AgentModelSummary[];
  associatedResources?: AgentAssociatedResources;
};

export type AgentUpdateRequest = Partial<{
  name: string;
  description: string | null;
  role: string;
  systemPrompt: string;
  modelId: string | null;
  modelClass: string | null;
  temperature: number;
  maxTokens: number;
  memoryType: AgentMemoryType;
  memoryConfig: AgentMemoryConfig | null;
  ragConfig: Record<string, AgentRagConfig> | null;
  knowledgeBaseIds: string[];
  mcpServerIds: string[];
}>;

export type ProjectModel = {
  id: string;
  name?: string;
  displayName?: string;
  provider?: string;
  modelType?: string | null;
  modelClass?: string | null;
};

export type AgentInvokeRequest = {
  input: string;
  sessionId?: string | null;
  configOverrides?: { model?: string } | null;
  context?: Record<string, unknown>;
  attachments?: unknown[];
};

export type AgentTokenUsage = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
};

export type AgentCitation = {
  source?: string;
  documentId?: string;
  downloadUrl?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  score?: number;
};

export type AgentInvokeResponse = {
  response: string;
  sessionId: string;
  latencyMs?: number;
  modelName?: string;
  usage?: AgentTokenUsage | null;
  citations?: AgentCitation[] | null;
  traceId?: string;
};

export type AgentStreamKbStat = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  retrievedChunks: number;
  tokensUsed: number;
};

export type AgentStreamToolStat = {
  toolName: string;
  serverName: string;
  serverId: string;
  status: string;
  latencyMs: number;
  /**
   * MAF's discriminator for the right-rail panel: `"kb"` for KB-retrieval
   * tools, `"toolset"` for MCP / external function tools. Optional so
   * older payloads (legacy agent-service, pre-toolType MAF) still validate.
   */
  toolType?: "kb" | "toolset";
};

export type AgentStreamModelConfig = {
  temperature?: number;
  topP?: number | null;
  maxTokens?: number;
  topK?: number;
};

/** Provenance block surfaced by maf's `citations` envelope (§5.3.5). */
export type AgentStreamRespondingAgent = {
  name?: string;
  model?: string;
  temperature?: number | null;
  framework?: string | null;
  instructionsPreview?: string | null;
};

/**
 * A single tool execution nested under an agent-trace step in maf's
 * `citations.agentTrace[].toolExecutions[]`. The streaming `completed`
 * event carries these; the live Run Details tabs derive Execution rows
 * and the Tracing timeline from them when Phoenix spans aren't wired.
 */
export type AgentStreamToolExecution = {
  toolName?: string;
  toolCallId?: string;
  arguments?: unknown;
  resultSummary?: unknown;
  durationMs?: number | null;
  error?: string | null;
  /**
   * MAF tool discriminator surfaced on each ``ToolExecution`` so the
   * right-rail config panel can show KB-specific vs Toolset-specific
   * detail rows. ``undefined`` for adapters that haven't been taught to
   * set it (treat as ``"toolset"``).
   */
  toolType?: "kb" | "toolset";
  /**
   * Approximate token count this tool's response consumed in the next
   * LLM call. Populated by KB tools today (rough chars/4 estimate). The
   * UI sums these per-KB into kbStats[].tokensUsed for "Context window
   * usage". ``undefined`` when the tool doesn't know.
   */
  tokensUsed?: number | null;
  /**
   * KB citations for this specific tool execution. Hoisted from MAF's
   * payload so the right-rail KB detail view can show per-call sources
   * + scores instead of the flat top-level kbCitations[] aggregate.
   */
  kbCitations?: AgentCitation[] | null;
};
export type AgentStreamTraceStep = {
  stepIndex?: number;
  agentName?: string;
  action?: string;
  /**
   * Input text the agent received this step (the last user / manager /
   * handoff message that triggered the response). Mirrors ToolExecution's
   * input field so the Tracing tab can render agent rows with the same
   * I/O contract as tool rows. Empty / absent on older payloads.
   */
  input?: string;
  output?: string;
  durationMs?: number | null;
  round?: number | null;
  timestamp?: string;
  // Per-step tool executions from maf's citations envelope. Preserved off
  // the `completed` event so the live Execution / Tracing tabs can render
  // tool calls without a persisted GET /sessions/{id} round-trip.
  toolExecutions?: AgentStreamToolExecution[];
};

export type AgentStreamPerformance = {
  totalDurationMs?: number;
  llmDurationMs?: number;
  toolDurationMs?: number | null;
  frameworkOverheadMs?: number;
  llmCallCount?: number;
};

export type AgentStreamProvenance = {
  respondingAgent?: AgentStreamRespondingAgent;
  agentTrace?: AgentStreamTraceStep[];
  performance?: AgentStreamPerformance;
};

export type AgentStreamDonePayload = {
  // Emitted by agent-service today (the `done` event payload).
  sessionId: string;
  latencyMs?: number;
  modelName?: string;
  usage?: AgentTokenUsage | null;
  citations?: AgentCitation[] | null;
  traceId?: string;
  // agent-stream.yaml target — not yet emitted by agent-service. Kept optional
  // so consumers can light up once the backend starts sending them.
  kbStats?: AgentStreamKbStat[];
  toolStats?: AgentStreamToolStat[];
  modelConfig?: AgentStreamModelConfig;
  /**
   * Structured run-provenance from maf's `citations` envelope: who
   * answered, the per-step agent trace, and the LLM/framework/tool time
   * breakdown. Optional — only the maf backend populates it.
   */
  provenance?: AgentStreamProvenance;
};

export type AgentSessionSummary = {
  sessionId: string;
  name: string;
  createdAt?: string | number;
};

export type AgentSessionListResponse = {
  sessions: AgentSessionSummary[];
};

export type AgentSessionToolStat = {
  toolCallId?: string;
  toolName: string;
  serverName?: string | null;
  serverId?: string | null;
  status: string;
  latencyMs: number;
};

export type AgentSessionKbStat = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  retrievedChunks: number;
  tokensUsed: number;
};

export type AgentSessionToolCall = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  latencyMs?: number;
};

export type AgentSessionMessage = {
  role: "user" | "assistant";
  content: string;
  timestamp?: string | number;
  metadata?: Record<string, unknown> | null;
  latencyMs?: number;
  modelName?: string;
  usage?: AgentTokenUsage | null;
  traceId?: string;
  citations?: AgentCitation[] | null;
  toolCalls?: AgentSessionToolCall[];
  kbStats?: AgentSessionKbStat[];
  toolStats?: AgentSessionToolStat[];
  modelConfig?: AgentStreamModelConfig;
};

export type AgentSessionDetailResponse = {
  sessionId: string;
  name: string;
  createdAt: string;
  messages: AgentSessionMessage[];
};

export type AgentTraceSpan = {
  id: string;
  name: string;
  context?: {
    trace_id?: string;
    span_id?: string;
  };
  span_kind?: string | null;
  parent_id?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  status_code?: string | null;
  status_message?: string | null;
  attributes?: Record<string, unknown> | null;
  events?: unknown[] | null;
};

export type AgentTraceSpansResponse = {
  data?: AgentTraceSpan[];
  next_cursor?: string | null;
};

// ── SSE streaming types (aligned with agent-service today) ────────────────────
//
// These types mirror what the agent-service FastAPI emits right now
// (`invoke_agent_stream` / `invoke_team_stream` in `agent-service/src/main.py`),
// not the richer `agent-stream.yaml` target. Fields that only exist in the yaml
// are marked as such so we can widen the contract once the backend catches up.
// All components and hooks reference these types, never the raw JSON shapes,
// so the contract can be updated in one place when the spec evolves.

/** Attachment item for the invoke request (max 5, max 5 MiB each). */
export type AgentStreamAttachmentItem = {
  filename: string;
  mimeType: string;
  /**
   * File contents as UTF-8 text. agent-service measures the UTF-8 byte size and
   * prepends the text inline as XML blocks; it does not base64-decode `content`.
   */
  content: string;
};

/**
 * Request body for both streaming invoke endpoints:
 *   POST /api/v1/projects/{project_id}/agents/{agent_id}/invoke/stream
 *   POST /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/stream
 */
export type AgentStreamInvokeRequest = {
  input: string;
  sessionId?: string | null;
  /** Accepted by maf's request model but currently ignored server-side. */
  context?: Record<string, unknown> | null;
  attachments?: AgentStreamAttachmentItem[] | null;
  /** Per-request overrides (typed allowlist on the maf side; model = one-shot model id). */
  configOverrides?: { model?: string } | null;
};

/** All event names the SSE stream can emit. */
export type AgentSseEventType =
  | "message"
  | "tool_call_start"
  | "tool_call_result"
  | "agent_started"
  | "agent_completed"
  | "done"
  | "error";

/** Text token/chunk — concatenate in order to reconstruct the full response. */
export type AgentSseMessageEvent = {
  type: "message";
  data: string;
};

/** Tool invocation started. */
export type AgentSseToolCallStartEvent = {
  type: "tool_call_start";
  data: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    /** Team-only: present when the call originated from a team member. */
    memberName?: string | null;
    memberId?: string | null;
  };
};

/** Tool invocation completed. */
export type AgentSseToolCallResultEvent = {
  type: "tool_call_result";
  data: {
    toolCallId: string;
    result: unknown;
    memberName?: string | null;
    memberId?: string | null;
  };
};

/**
 * A team participant began its turn. Multi-agent (team) streams emit one
 * `agent_started` … `agent_completed` pair per agent turn so the UI can show
 * which agent is currently running.
 */
export type AgentSseAgentStartedEvent = {
  type: "agent_started";
  data: {
    agentName: string;
    /** ISO-8601 UTC start timestamp. */
    startedAt?: string;
  };
};

/** A team participant finished its turn. */
export type AgentSseAgentCompletedEvent = {
  type: "agent_completed";
  data: {
    agentName: string;
    /** ISO-8601 UTC completion timestamp. */
    completedAt?: string;
    /** Wall-clock duration of this agent's turn, in milliseconds. */
    durationMs?: number;
  };
};

/** Terminal success event — contains session ID, usage, citations, and trace. */
export type AgentSseDoneEvent = {
  type: "done";
  data: AgentStreamDonePayload;
};

/** Terminal error event — human-readable message string. */
export type AgentSseErrorEvent = {
  type: "error";
  data: string;
};

/** Discriminated union of every SSE event the streaming endpoints can emit. */
export type AgentSseEvent =
  | AgentSseMessageEvent
  | AgentSseToolCallStartEvent
  | AgentSseToolCallResultEvent
  | AgentSseAgentStartedEvent
  | AgentSseAgentCompletedEvent
  | AgentSseDoneEvent
  | AgentSseErrorEvent;
