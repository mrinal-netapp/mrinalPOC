// Types mirrored from the agent config-service OpenAPI spec for the
// `/api/v1/projects/{projectId}/agents` and `/api/v1/projects/{projectId}/agent-teams`
// endpoints. Tracks PR #33 (`AIAS-1166-agents-api-update`) — the read shape is
// now *enriched* (model summary, fallback models, associated resources name
// mapping) and lifecycle fields (`status`, `statusMessage`, `deploymentStatus`)
// are persisted on the entity itself instead of being derived client-side.

// -- Lifecycle --

/** Health pill on list / detail. Persisted on the agent row, default 'Healthy'. */
export type AgentStatus = 'Healthy' | 'Unhealthy';

/**
 * Detailed deployment lifecycle. Tracked separately from `status` so the
 * deployment workflow can publish progress without rewriting the agent's
 * configuration state. The eight values match the config-service enum
 * (PR #33 — `Agent.AgentDeploymentStatus`). Always lowercase on the wire.
 */
export type AgentDeploymentStatus =
  | 'draft'
  | 'preview'
  | 'not_deployed'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'terminating'
  | 'terminated';

export type AgentTeamStatus = AgentStatus;
export type AgentTeamDeploymentStatus = AgentDeploymentStatus;

// -- Existing enums --

export type AgentMemoryType = 'none' | 'conversation' | 'sliding_window';

export type AgentTeamOrchestrationPolicy =
  | 'coordinate'
  | 'sequential'
  | 'route'
  | 'collaborate'
  | 'concurrent';

export type AgentMCPTransport = 'http' | 'sse' | 'stdio';

export type AgentRagSearchMode = 'semantic' | 'hybrid' | 'fts';

export type AgentMemoryContextStrategy =
  | 'trim'
  | 'summarize'
  | 'hybrid'
  | 'sliding_window_strict'
  | 'none';

// -- New card-level enums (PR #33) --

export type FunctionChoiceBehavior = 'auto' | 'none' | 'required' | 'any';

export type MessageRetentionPolicy = 'sliding_window' | 'summarize' | 'none';

// -- Resource requirements --

/**
 * Describes a KB or MCP server that has been added to an agent but is missing
 * required configuration. Items live in `Agent.requirements` until the user
 * fills in the missing details, at which point they move to
 * `knowledgeBaseIds` / `mcpServerIds` respectively.
 *
 * `required: true`  → blocks deployment until resolved.
 * `required: false` → shows a warning but does not block deployment.
 */
export interface AgentResourceRequirement {
  id: string;
  label: string;
  description: string;
  required: boolean;
}

/** One unresolved required placeholder returned by the deployment gate (HTTP 400). */
export interface UnmetRequirement {
  kind: "knowledgeBases" | "mcpServers";
  id: string;
  label: string;
}

// -- Cross-resource summaries / dependents --

export interface DependentsSummary {
  total?: number;
  byKind?: Record<string, number>;
}

export interface DependentItem {
  kind: string;
  id: string;
  name?: string | null;
  relation: string;
}

export interface DependentsPage {
  items: DependentItem[];
  nextCursor?: string | null;
  totalByKind: Record<string, number>;
}

// -- Enrichment shape (read-only, attached by the GET routes) --

/**
 * Stripped-down model record returned alongside each agent so the UI can
 * render a human-readable model name without a second roundtrip. The
 * resolver runs on `/agents` (list) and `/agents/{id}` (detail).
 */
export interface ModelSummary {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
}

/** Lightweight `{id, name}` reference. Used by the enrichment payloads. */
export interface EntityRef {
  id: string;
  name: string;
}

export interface AgentAssociatedResources {
  knowledgeBases: EntityRef[];
  agentTeams: EntityRef[];
}

export interface AgentTeamAssociatedResources {
  agents: EntityRef[];
  agentTeams: EntityRef[];
}

// -- Agent sub-objects --

export interface AgentRagConfig {
  topK: number;
  similarityThreshold: number;
  searchMode: AgentRagSearchMode;
  rerankingEnabled?: boolean;
  similarityThresholdEnabled?: boolean;
}

/** @deprecated — use `AgentMemoryContext` (new card) once the new shape is wired. */
export interface AgentMemoryConfig {
  windowSize?: number;
  contextStrategy?: AgentMemoryContextStrategy;
  summaryModel?: string;
  verbatimTurns?: number;
  toolRoundReservation?: number;
  outputReservation?: number;
  safetyBufferPct?: number;
  summaryRefreshEveryTurns?: number;
}

/** @deprecated — use `AgentGuardrailsConfig` (new guardrails contract). */
export interface AgentGuardrails {
  maxIterations?: number;
  timeoutSeconds?: number;
  contentFilters?: string[];
}

export interface AgentMCPServerOverride {
  permissions: string[];
  rateLimit?: number;
  allowedTools?: string[];
}

/**
 * Declarative placeholder for a KB / MCP server the agent expects but has not
 * yet bound to a concrete resource id. Required placeholders block deploy until
 * resolved. See `docs/design/agent-resource-requirements.md`.
 */
export interface AgentResourceRequirement {
  /** Client-generated RFC-4122 UUID; unique within its list. */
  id: string;
  /** Display name; ≤ 120 chars. */
  label: string;
  /** Free-form intent; ≤ 1000 chars. */
  description: string;
  /** When true, blocks deploy until this entry is removed. */
  required: boolean;
}

/** Unresolved resource placeholders stored on `Agent.requirements`. */
export interface AgentRequirements {
  knowledgeBases?: AgentResourceRequirement[];
  mcpServers?: AgentResourceRequirement[];
}

export interface AgentResolvedMCPServer {
  name?: string;
  litellmServerName?: string | null;
  litellmServerId?: string | null;
  transport?: AgentMCPTransport;
  syncStatus?: string | null;
  status?: string;
  timeout?: number | null;
  catalogId?: string | null;
  serverInstructions?: string | null;
  promptFragment?: string | null;
}

// -- New card shapes (PR #33; persistence-only on the backend today) --

/** LLM generation parameters (used today by the fallback model set). */
export interface ModelParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  token_limit?: number;
}

export interface AgentOutputResponse {
  enabled: boolean;
  example_response?: string | null;
}

export type AgentResponseFormat = 'text' | 'json_object';

export interface AgentStructuredOutput {
  enabled: boolean;
  responseFormat?: AgentResponseFormat;
  /**
   * Canonical wire field used by the UI and config-service:
   * - `json_object`: JSON Schema object serialized as a string
   * - `text`: free-form response guidelines
   * Required (non-empty) when `enabled=true`.
   */
  outputSchema?: string | null;
  /**
   * Legacy read-only field retained for backward compatibility with older
   * payloads. UI should not send this field when creating/updating agents.
   * @deprecated Use `outputSchema`.
   */
  json_schema?: Record<string, unknown> | null;
}

/**
 * Wire shape for the `memoryContext` field on agent and team records.
 *
 * Carries both the legacy fields (kept for back-compat with rows saved
 * before Stage 4 backend normalization landed) and the new unified
 * MemoryContext schema. Every field is optional because:
 *
 *   - New saves: `type` + `message_window_limit` / `summary_token_limit`
 *     etc. are populated; legacy fields are omitted by the UI.
 *   - Old saves (pre-Stage-4): `message_retention_policy` +
 *     `message_history_limit` are populated; `type` is absent.
 *
 * Readers (mapAgentToFeatureConfig, mapTeamToFormValues) probe for
 * either shape and normalize.
 */
export interface AgentMemoryContext {
  enabled?: boolean;
  // --- Legacy shape (kept for back-compat reads) -----------------------
  message_retention_policy?: MessageRetentionPolicy;
  message_history_limit?: number;
  session_history_limit?: number;
  // --- New unified MemoryContext shape --------------------------------
  type?: "none" | "window" | "summary" | "summary_buffer";
  message_window_limit?: number;
  message_token_limit?: number;
  summary_token_limit?: number;
  summary_refresh_every_turns?: number;
  summary_model?: string;
  adaptive_summarize?: { overflow_threshold: number };
  budget?: {
    tool_round_reservation?: number;
    output_reservation?: number;
    safety_buffer_pct?: number;
  };
}

export interface GuardrailToggle {
  guardrail_id: string;
  name: string;
  enabled: boolean;
}

export interface AgentGuardrailsConfig {
  enabled: boolean;
  fail_open: boolean;
  log_blocked_requests: boolean;
  input_guardrails: GuardrailToggle[];
  output_guardrails: GuardrailToggle[];
}

export interface GuardrailCatalogSummary {
  id: string;
  key: string;
  stage: "input" | "output" | "tool";
  display_name: string;
  description: string;
  type: string;
  enabled: boolean;
}

export interface AgentRetriesConfig {
  enabled: boolean;
  max_retries: number;
}

export interface AgentRateLimitingConfig {
  enabled: boolean;
  max_requests_per_minute?: number | null;
}

// -- Termination strategy (Agent + AgentTeam) --

export interface MaximumIterationsTermination {
  type: 'maximum_iterations';
  maximum_iterations: number;
}

export interface KeywordTermination {
  type: 'keyword';
  keywords: string[];
}

export interface TimeoutTermination {
  type: 'timeout';
  timeout_seconds: number;
}

export type LeafTerminationStrategy =
  | MaximumIterationsTermination
  | KeywordTermination
  | TimeoutTermination;

export interface AggregatorTermination {
  type: 'aggregator';
  condition: 'any' | 'all';
  sub_strategies: LeafTerminationStrategy[];
}

export type TerminationStrategy = LeafTerminationStrategy | AggregatorTermination;

// -- Agent --

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  role: string;
  systemPrompt: string;
  /** New high-level goal field (replaces `outcomeDescription` for display). */
  goal?: string | null;
  modelId?: string | null;
  modelClass?: string | null;
  /** @deprecated — see `fallbackModelParams`. Still round-trips on the API. */
  temperature?: number | null;
  /** @deprecated — see `fallbackModelParams`. Still round-trips on the API. */
  maxTokens?: number | null;
  /** Top-P sampling for the primary model. */
  topP?: number | null;
  /** Top-K sampling for the primary model. */
  topK?: number | null;
  fallbackModelIds?: string[];
  fallbackModelParams?: ModelParams | null;
  mcpServerIds?: string[];
  mcpServerConfig?: Record<string, AgentMCPServerOverride> | null;
  knowledgeBaseIds?: string[];
  ragConfig?: Record<string, AgentRagConfig>;
  /** Unresolved KB / MCP placeholders. Null on legacy rows. */
  requirements?: AgentRequirements | null;
  /** @deprecated — retained read-only for backwards compatibility. */
  datasetIds?: string[];
  artifactStoreIds?: string[];
  /** @deprecated — see `structuredOutput`. */
  outcomeSchema?: Record<string, unknown> | null;
  /** @deprecated — see `goal`. */
  outcomeDescription?: string | null;
  outputResponse?: AgentOutputResponse | null;
  structuredOutput?: AgentStructuredOutput | null;
  /** @deprecated — see `memoryContext`. */
  memoryType?: AgentMemoryType;
  /** @deprecated — see `memoryContext`. */
  memoryConfig?: AgentMemoryConfig;
  memoryContext?: AgentMemoryContext | null;
  guardrails?: AgentGuardrailsConfig | null;
  retries?: AgentRetriesConfig | null;
  rateLimiting?: AgentRateLimitingConfig | null;
  functionChoiceBehavior?: FunctionChoiceBehavior;
  terminationStrategy?: TerminationStrategy | null;
  labels?: string[];
  status: AgentStatus;
  statusMessage?: string | null;
  deploymentStatus: AgentDeploymentStatus;
  /** Only present on `GET /agents/{id}`. */
  _resolvedMCPServers?: Record<string, AgentResolvedMCPServer>;
  /** Read-only enrichment — primary model summary. Null when not resolvable. */
  model?: ModelSummary | null;
  /** Read-only enrichment — resolved fallback model summaries (in order). */
  fallbackModels?: ModelSummary[];
  /** Read-only enrichment — KBs + parent teams that reference this agent. */
  associatedResources?: AgentAssociatedResources;
  dependentsSummary?: DependentsSummary;
  createdAt: string;
  updatedAt: string;
}

// -- Agent team sub-objects --

export interface AgentTeamMember {
  memberType: 'agent' | 'team';
  memberId: string;
  role?: string | null;
}

/**
 * Manager configuration. Two valid shapes:
 *   1. Reference: `{ agent_id: 'ag-…' }` resolves the manager from an
 *      existing agent.
 *   2. Inline: `name` + `systemPrompt` + at least one of
 *      `modelId` / `modelClass`.
 */
export interface AgentTeamManager {
  agent_id?: string | null;
  name?: string | null;
  role?: string | null;
  modelId?: string | null;
  /**
   * Resolved model summary for `modelId`. The `/agent-teams` list / detail
   * responses enrich the manager with this so the UI can render the model name
   * directly (mirrors `Agent.model`). Absent on reference-only managers or
   * older payloads — fall back to `modelId` then `modelClass`.
   */
  model?: ModelSummary | null;
  modelClass?: string | null;
  systemPrompt?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  guardrails?: AgentGuardrails;
}

// -- Agent team --

export interface AgentTeam {
  id: string;
  projectId: string;
  name: string;
  description?: string | null;
  orchestrationPolicy?: AgentTeamOrchestrationPolicy;
  manager?: AgentTeamManager;
  members: AgentTeamMember[];
  sharedKnowledgeBaseIds?: string[];
  sharedDatasetIds?: string[];
  artifactStoreIds?: string[];
  /** @deprecated — see `memoryContext` parity on Agent (team uses same shape). */
  memoryType?: AgentMemoryType;
  /** @deprecated — same as `Agent.memoryConfig`. */
  memoryConfig?: AgentMemoryConfig;
  /**
   * Team-level memory configuration (new unified schema). Same shape as
   * `Agent.memoryContext`. config-service derives the legacy memoryType +
   * memoryConfig from this on save; MAF reads this directly on team-invoke.
   */
  memoryContext?: AgentMemoryContext | null;
  terminationStrategy?: TerminationStrategy | null;
  labels?: string[];
  status: AgentTeamStatus;
  statusMessage?: string | null;
  deploymentStatus: AgentTeamDeploymentStatus;
  /** Read-only enrichment — `members[]` resolved to `{id, name}` pairs. */
  associatedResources?: AgentTeamAssociatedResources;
  dependentsSummary?: DependentsSummary;
  createdAt: string;
  updatedAt: string;
}

// -- Project models (for the model picker) --

export type ProjectModelType = 'llm' | 'embedding';

/**
 * Lightweight projection of a config-service `Model` used to populate the
 * agent form's primary/fallback model pickers. The picker only needs the
 * server `id` (the UUID persisted on the agent as `modelId`) plus a
 * human-readable label.
 */
export interface ProjectModelSummary {
  id: string;
  name: string;
  displayName?: string;
  provider?: string;
  providerModelId?: string;
  modelType?: ProjectModelType;
  modelClass?: string;
}

export interface ListProjectModelsParams {
  projectId: string;
  /** Filter by model type — the agent pickers request `llm` only. */
  modelType?: ProjectModelType;
}

// -- Project MCP servers (for the toolset picker) --

export type McpServerHealthStatus = 'connected' | 'disconnected' | 'error' | 'unknown';

/**
 * Lightweight projection of a config-service MCP server used to populate the
 * agent form's toolset picker. The agent persists the selected server `id`s as
 * `mcpServerIds`. `allowedTools` (when present) is the server's tool allowlist;
 * the full live tool catalog is available via `GET /mcp-servers/{id}/tools`.
 */
export interface McpServerSummary {
  id: string;
  name: string;
  description?: string | null;
  status: McpServerHealthStatus;
  /**
   * Bifrost gateway registration state. `pending` for a freshly created server
   * that hasn't been registered yet (e.g. a managed pod still coming up).
   */
  syncStatus?: 'synced' | 'pending' | 'error' | 'suspended' | string | null;
  /**
   * Managed (catalog-deployed) K8s pod lifecycle. Only present for
   * `deploymentType === 'managed'`; `provisioning` means the pod is still coming
   * up (Bifrost health hasn't been probed yet, so `status` is a transient
   * 'unknown'), `running` once ready, `failed` if provisioning failed.
   */
  runtimeStatus?: 'provisioning' | 'running' | 'failed' | 'deleting' | null;
  transport?: 'http' | 'sse' | 'stdio' | 'streamable-http';
  authType?: 'none' | 'api_key' | 'bearer_token' | 'basic' | 'oauth2' | null;
  // config-service stores this in a nullable column and serializes an unset
  // allow-list as JSON `null` (not just absent), so consumers must treat
  // `null` the same as "no allow-list". See use-toolset-options normalization.
  allowedTools?: string[] | null;
  labels?: string[];
  deploymentType?: 'remote' | 'managed' | 'platform' | null;
  extraHeaders?: string[] | null;
  dependentsSummary?: {
    total?: number;
    byKind?: Record<string, number>;
  };
  /** ISO timestamps from the config-service row (TypeORM date columns). */
  createdAt?: string;
  updatedAt?: string;
}

export interface ListMcpServersParams {
  projectId: string;
  /** e.g. `dependentsSummary=false` to skip the per-row annotation. */
  include?: string;
}

/**
 * A single tool exposed by an MCP server, as returned by
 * `GET /mcp-servers/{id}/tools` (the live gateway tool catalog). Unlike the
 * server's `allowedTools` allowlist, this carries human-readable descriptions.
 */
export interface McpServerTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface GetMcpServerToolsParams {
  projectId: string;
  id: string;
}

export interface ListMcpServerDependentsParams {
  projectId: string;
  id: string;
  limit?: number;
  cursor?: string;
  kind?: string;
}

// -- Project knowledge bases (for the KB picker) --

/**
 * Processing lifecycle of a config-service `KnowledgeBase`:
 * - `in_progress` — KB processing workflow is running
 * - `ready` — index built and queryable
 * - `errored` — workflow failed
 * - `deprecated` — soft-retired (cannot be newly assigned to an agent)
 */
export type KnowledgeBaseStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

/**
 * Coarse ingestion progress reported by the KB processing workflow.
 * `percentage` is 0..100 on the wire.
 */
export interface KnowledgeBaseProgress {
  phase?: string;
  percentage?: number;
}

/**
 * Index statistics emitted once a KB finishes processing. All fields are
 * optional — the block is `null` until the workflow records them.
 */
export interface KnowledgeBaseStats {
  chunkCount?: number;
  vectorCount?: number;
  fileCount?: number;
  storageBytes?: number;
  storageMB?: number;
  avgChunkSize?: number;
}

/**
 * Lightweight projection of a config-service `KnowledgeBase` used to populate
 * the agent form's "Add knowledge base" dialog. Maps to a row of
 * `GET /api/v1/projects/{projectId}/knowledgebases`. The agent persists the
 * chosen KB `id`s (short `kb<8>` ids) as `knowledgeBaseIds`.
 */
export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description?: string | null;
  status: KnowledgeBaseStatus;
  labels?: string[];
  /** Source dataset id this KB chunks/embeds from. */
  sourceDataset?: string;
  embeddingModel?: string;
  lastSyncedAt?: string | null;
  /** Coarse ingestion progress (present while/after processing). */
  progress?: KnowledgeBaseProgress | null;
  /** Index statistics (file / vector counts); `null` until recorded. */
  stats?: KnowledgeBaseStats | null;
}

export interface ListKnowledgeBasesParams {
  projectId: string;
  /** e.g. `dependentsSummary=false` to skip the per-row annotation. */
  include?: string;
}

// -- Query params --

export interface ListAgentsParams {
  projectId: string;
  limit?: number;
  skip?: number;
  /** Exact-match column filter (used with `value`). */
  field?: string;
  value?: string;
  /** Case-insensitive substring filter on `name`. */
  nameRegex?: string;
  /** e.g. `dependentsSummary=false` to skip the per-row annotation. */
  include?: string;
}

export interface ListAgentTeamsParams {
  projectId: string;
  limit?: number;
  skip?: number;
  nameRegex?: string;
  include?: string;
}

export interface GetAgentParams {
  projectId: string;
  id: string;
}

export interface GetAgentTeamParams {
  projectId: string;
  id: string;
}

export interface DeleteAgentParams {
  projectId: string;
  id: string;
}

export interface DeleteAgentTeamParams {
  projectId: string;
  id: string;
}

// -- Agent version history --

/** One row of `agent_history` — point-in-time snapshot of an agent. */
export interface AgentVersion {
  id: string;
  entityId: string;
  version: number;
  data: Record<string, unknown>;
  modifiedAt?: string;
  modifiedBy?: string | null;
  op?: string | null;
}

/** One row of `agent_team_history` — point-in-time snapshot of a team. */
export interface AgentTeamVersion {
  id: string;
  entityId: string;
  version: number;
  data: Record<string, unknown>;
  modifiedAt?: string;
  modifiedBy?: string | null;
  op?: string | null;
}

export interface RestoreAgentResponse {
  restored: boolean;
  data: Agent;
}

export interface RestoreAgentTeamResponse {
  restored: boolean;
  data: AgentTeam;
}

// -- Create / Update --

/**
 * Body for `POST /api/v1/projects/{projectId}/agents`.
 * At least one of `modelId` or `modelClass` is required (enforced server-side).
 */
export interface CreateAgentRequest {
  name: string;
  description?: string;
  role: string;
  goal?: string;
  systemPrompt: string;
  modelId?: string;
  modelClass?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  fallbackModelIds?: string[];
  fallbackModelParams?: ModelParams | null;
  mcpServerIds?: string[];
  mcpServerConfig?: Record<string, AgentMCPServerOverride>;
  knowledgeBaseIds?: string[];
  ragConfig?: Record<string, AgentRagConfig>;
  /** Unresolved KB / MCP placeholders (template authoring). */
  requirements?: AgentRequirements | null;
  artifactStoreIds?: string[];
  /** @deprecated */
  outcomeSchema?: Record<string, unknown>;
  /** @deprecated */
  outcomeDescription?: string;
  /** @deprecated */
  memoryType?: AgentMemoryType;
  /** @deprecated */
  memoryConfig?: AgentMemoryConfig;
  outputResponse?: AgentOutputResponse | null;
  structuredOutput?: AgentStructuredOutput | null;
  memoryContext?: AgentMemoryContext | null;
  guardrails?: AgentGuardrailsConfig | null;
  retries?: AgentRetriesConfig | null;
  rateLimiting?: AgentRateLimitingConfig | null;
  functionChoiceBehavior?: FunctionChoiceBehavior;
  terminationStrategy?: TerminationStrategy | null;
  labels?: string[];
  status?: AgentStatus;
  statusMessage?: string;
  deploymentStatus?: AgentDeploymentStatus;
}

export type UpdateAgentRequest = Partial<CreateAgentRequest>;

export interface CreateAgentParams {
  projectId: string;
  body: CreateAgentRequest;
}

export interface UpdateAgentParams {
  projectId: string;
  id: string;
  body: UpdateAgentRequest;
}

// -- Lifecycle update --

/**
 * Body for `PUT /agents/{id}` scoped to lifecycle fields only.
 * The dedicated `/status` sub-resource does not exist on the config-service;
 * callers should use `updateAgent` with these fields instead.
 * At least one field must be present (the API returns 400 on an empty body).
 */
export interface UpdateAgentStatusBody {
  status?: AgentStatus;
  statusMessage?: string | null;
  deploymentStatus?: AgentDeploymentStatus;
}

export interface UpdateAgentStatusParams {
  projectId: string;
  id: string;
  body: UpdateAgentStatusBody;
}

export interface UpdateAgentTeamStatusBody {
  status?: AgentTeamStatus;
  statusMessage?: string | null;
  deploymentStatus?: AgentTeamDeploymentStatus;
}

export interface UpdateAgentTeamStatusParams {
  projectId: string;
  id: string;
  body: UpdateAgentTeamStatusBody;
}

// -- Agent Team create / update --

/**
 * Body for `POST /api/v1/projects/{projectId}/agent-teams`.
 * `members` (minItems: 1) is required. When providing a `manager` inline
 * (no `agent_id`), `name` + `systemPrompt` + at least one of `modelId` /
 * `modelClass` are required by the server.
 */
export interface CreateAgentTeamRequest {
  name: string;
  description?: string;
  orchestrationPolicy?: AgentTeamOrchestrationPolicy;
  manager?: AgentTeamManager;
  members: AgentTeamMember[];
  sharedKnowledgeBaseIds?: string[];
  sharedDatasetIds?: string[];
  artifactStoreIds?: string[];
  /** @deprecated — derived server-side from `memoryContext`. */
  memoryType?: AgentMemoryType;
  /** @deprecated — derived server-side from `memoryContext`. */
  memoryConfig?: AgentMemoryConfig;
  /** Unified memory configuration (new schema). config-service derives legacy fields. */
  memoryContext?: AgentMemoryContext;
  terminationStrategy?: TerminationStrategy;
  labels?: string[];
  status?: AgentTeamStatus;
  statusMessage?: string;
  deploymentStatus?: AgentTeamDeploymentStatus;
}

export type UpdateAgentTeamRequest = Partial<CreateAgentTeamRequest>;

export interface CreateAgentTeamParams {
  projectId: string;
  body: CreateAgentTeamRequest;
}

export interface UpdateAgentTeamParams {
  projectId: string;
  id: string;
  body: UpdateAgentTeamRequest;
}

// -- History / version params --

export interface ListAgentVersionsParams {
  projectId: string;
  id: string;
}

export interface RestoreAgentVersionParams {
  projectId: string;
  id: string;
  version: number;
}

export interface ListAgentTeamVersionsParams {
  projectId: string;
  id: string;
}

export interface RestoreAgentTeamVersionParams {
  projectId: string;
  id: string;
  version: number;
}

// -- Dependents params --

export interface ListAgentDependentsParams {
  projectId: string;
  id: string;
  limit?: number;
  cursor?: string;
  /** Filter by source entity kind, e.g. `agent_team`. */
  kind?: string;
}

export interface ListAgentTeamDependentsParams {
  projectId: string;
  id: string;
  limit?: number;
  cursor?: string;
  kind?: string;
}
