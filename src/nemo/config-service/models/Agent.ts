import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { AgentHistory } from './history/AgentHistory';
import { AgentIdGenerator } from '../services/AgentIdGenerator';

/**
 * Health state of the agent. Surfaced on list / get responses as a simple
 * Healthy / Unhealthy pill. Detailed lifecycle (draft, ready, deployed,
 * errored, etc.) is now tracked separately on `deploymentStatus`.
 *
 * New agents are persisted as `Healthy` by default.
 */
export type AgentStatus = 'Healthy' | 'Unhealthy';

/**
 * Deployment lifecycle of the agent. Tracked separately from `status` so the
 * deployment workflow can publish progress without rewriting the agent's
 * configuration state.
 *
 * `draft` and `preview` are pre-deployment states surfaced to the GUI so
 * users can iterate on configuration before promoting an agent.
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

/** Tool-call selection behavior the runtime hands to LiteLLM / the model. */
export type FunctionChoiceBehavior = 'auto' | 'none' | 'required' | 'any';

/**
 * LLM generation parameters. Used today for the fallback set
 * (`agents.fallback_model_params`); the primary model uses the flat
 * `temperature` / `maxTokens` / `topP` / `topK` columns on the Agent entity.
 *
 * Snake-case property names match the public spec.
 */
export interface ModelParams {
  temperature?: number;     // 0..2, default 0.7
  top_p?: number;           // 0..1, default 1
  top_k?: number;           // 0..1000, default 50
  token_limit?: number;     // 1..100000, default 2000
}

/** Optional example response shown in the agent UI. */
export interface AgentOutputResponse {
  enabled: boolean;
  example_response?: string | null;
}

/** Response format for structured output. */
export type AgentResponseFormat = 'text' | 'json_object';

/**
 * Structured-output card. Coexists with the legacy `outcomeSchema` field
 * (which this feature no longer uses). When `enabled`, `responseFormat`
 * selects the output shape and `outputSchema` carries either a JSON schema
 * serialized as a string (`json_object`) or free-form text guidelines
 * (`text`).
 */
export interface AgentStructuredOutput {
  enabled: boolean;
  responseFormat?: AgentResponseFormat;
  outputSchema?: string | null;
}

/**
 * Conversation memory & short-term context card. Matches the figma "Conversation
 * memory and context" panel.
 */
export type MessageRetentionPolicy = 'sliding_window' | 'summarize' | 'none';

export interface AgentMemoryContext {
  enabled: boolean;
  message_retention_policy: MessageRetentionPolicy;
  message_history_limit: number;   // 0..200
  session_history_limit: number;   // 0..100
}

/**
 * A single guardrail attached to an agent. Lean reference into
 * `guardrails_catalog` plus optional per-agent overrides. config-service stores
 * this verbatim and does NOT resolve it — agent-service fetches the definition
 * by `guardrail_id` and merges the overrides over the catalog defaults.
 *
 * Omitted `action` / `config` fall back to the catalog row's defaults.
 */
export interface GuardrailRule {
  guardrail_id: string;             // references guardrails_catalog.id
  action?: string;                  // optional override; omitted -> catalog default
  config?: Record<string, unknown>; // optional partial override; omitted -> catalog default
}

/**
 * Unified agent guardrails object. Mirrors the runtime `GuardrailSection` shape
 * (suite settings + per-stage rule lists) but with lean rule references.
 * Replaces the legacy `guardrails` ({ maxIterations, ... }) and
 * `guardrailsCard` ({ input, output, tools }) columns.
 *
 * Suite settings are optional; omitted fields fall back to agent-service
 * defaults (deep-merge). Presence of a rule in an array = active; execution
 * order = array order.
 */
export interface AgentGuardrails {
  enabled?: boolean;
  fail_open?: boolean;
  log_blocked_requests?: boolean;
  // Optional to match `assertAgentGuardrailsShape`, which treats each rule
  // bucket as optional (skipped when undefined/null).
  input_guardrails?: GuardrailRule[];
  output_guardrails?: GuardrailRule[];
  tool_guardrails?: GuardrailRule[];
}

/**
 * Termination strategy controls when the agent (or team) loop stops.
 *
 * The aggregator variant composes other strategies via `condition: any|all`;
 * nested aggregators are not supported (one level of nesting only).
 */
export interface MaximumIterationsTermination {
  type: 'maximum_iterations';
  maximum_iterations: number;     // >= 1
}

export interface KeywordTermination {
  type: 'keyword';
  keywords: string[];             // non-empty
}

export interface TimeoutTermination {
  type: 'timeout';
  timeout_seconds: number;        // >= 1
}

export type LeafTerminationStrategy =
  | MaximumIterationsTermination
  | KeywordTermination
  | TimeoutTermination;

export interface AggregatorTermination {
  type: 'aggregator';
  condition: 'any' | 'all';
  sub_strategies: LeafTerminationStrategy[]; // non-empty; aggregator-only
}

export type TerminationStrategy =
  | LeafTerminationStrategy
  | AggregatorTermination;

/** Automatic retries card. */
export interface AgentRetriesConfig {
  enabled: boolean;
  max_retries: number;
}

/** API rate-limiting card. */
export interface AgentRateLimitingConfig {
  enabled: boolean;
  max_requests_per_minute?: number | null;
}

/**
 * Per-knowledge-base retrieval-augmented-generation tuning. Stored on the
 * agent as a map keyed by knowledge-base id (see `Agent.ragConfig`), mirroring
 * the `mcpServerConfig` pattern. config-service stores this verbatim and does
 * not resolve it; only the optional reranking flags fall back to consumer-side
 * defaults when omitted.
 */
export interface AgentRagConfig {
  topK: number;                       // 1..100
  similarityThreshold: number;        // 0..1
  searchMode: 'semantic' | 'hybrid' | 'fts';
  /** Toggle for the kb-retrieval-service reranker (consumer wiring TBD). */
  rerankingEnabled?: boolean;
  /** Toggle for applying `similarityThreshold` (consumer wiring TBD). */
  similarityThresholdEnabled?: boolean;
}

/**
 * Declarative placeholder for a KB / MCP server the agent expects to be
 * attached but hasn't been bound to a concrete id yet. Lives on
 * `Agent.requirements` (see below). config-service stores this verbatim
 * and does NOT resolve it — placeholders never enter `knowledgeBaseIds`
 * or `mcpServerIds`, so the strict 1:1 invariant with `ragConfig` and
 * the runtime tool / KB resolution paths are unaffected.
 *
 * Two roles in the lifecycle:
 *
 *   1. **Authoring** — a user (or agent-generation flow) declares that
 *      this agent needs a KB / tool matching `description`, optionally
 *      flagging it `required` so deployment is blocked until resolved.
 *   2. **Deployment gate** — `PUT /agents/{id}/status` rejects a
 *      transition to `deploymentStatus='deployed'` while any
 *      `required: true` entry remains. Draft / preview / not_deployed
 *      are explicitly allowed to carry unresolved requirements.
 */
export interface AgentResourceRequirement {
  /**
   * RFC-4122 UUID. Must be unique within the containing list
   * (`knowledgeBases` or `mcpServers`); cross-list collisions are
   * allowed. Validated against the same `isUuid` matcher used by
   * `GuardrailRule.guardrail_id` so a malformed id is rejected at the
   * route boundary before it reaches Postgres.
   */
  id: string;
  /** Display label shown in the agent's requirements list (trimmed on save, ≤ 120 chars). */
  label: string;
  /** Free-form description of what this resource should provide (≤ 1000 chars). */
  description: string;
  /** Hard requirement (blocks deployment) vs nice-to-have. */
  required: boolean;
}

/**
 * Unresolved resource requirements grouped by kind. Each list holds
 * `AgentResourceRequirement` entries with unique `id`s within the list.
 * Cross-list `id` collisions are allowed (a KB and an MCP placeholder
 * may share an id) because the UI keys them per-list.
 */
export interface AgentRequirements {
  knowledgeBases?: AgentResourceRequirement[];
  mcpServers?: AgentResourceRequirement[];
}

@Entity('agents')
@Index(['projectId', 'name'], { unique: true })
export class Agent {
  @PrimaryColumn('varchar', { length: 11 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = AgentIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column()
  role!: string;

  @Column('text')
  systemPrompt!: string;

  @Column({ nullable: true })
  modelId?: string;

  /** Functional classification (e.g. "reasoning", "balanced", "fast", "code") */
  @Column({ nullable: true })
  modelClass?: string;

  @Column('float', { nullable: true })
  temperature?: number;

  @Column('int', { nullable: true })
  maxTokens?: number;

  @Column('jsonb', { default: '[]' })
  mcpServerIds!: string[];

  @Column('jsonb', { nullable: true })
  mcpServerConfig?: Record<string, {
    permissions: string[];
    rateLimit?: number;
    allowedTools?: string[];
  }>;

  @Column('jsonb', { default: '[]' })
  knowledgeBaseIds!: string[];

  /**
   * Per-knowledge-base RAG configuration, keyed by knowledge-base id.
   * Replaces the former single agent-wide object: every id in
   * `knowledgeBaseIds` must have a matching `ragConfig[kbId]` entry (strict
   * 1:1, enforced in the route layer). Absent / `{}` is valid only when there
   * are no attached KBs. Stored verbatim — config-service does not resolve it.
   */
  @Column('jsonb', { nullable: true })
  ragConfig?: Record<string, AgentRagConfig>;

  /**
   * Declarative placeholders for KBs / MCP servers the agent expects but
   * hasn't been bound to concrete ids yet. Stored verbatim. Placeholders
   * NEVER enter `knowledgeBaseIds` / `mcpServerIds`, so the strict 1:1
   * invariant with `ragConfig` and the runtime KB / MCP resolution paths
   * (agent-service `agent_factory.py`, agent-service-maf
   * `team_loader.py`) are unaffected — they're invisible to the runtime.
   *
   * Enforcement lives on the deployment transition only: the
   * `PUT /agents/{id}/status` handler rejects a move to
   * `deploymentStatus='deployed'` while any `required: true` entry
   * remains. See `AgentRequirements` / `AgentResourceRequirement`.
   */
  @Column('jsonb', { nullable: true })
  requirements?: AgentRequirements;

  @Column('jsonb', { default: '[]' })
  datasetIds!: string[];

  /**
   * IDs of artifact stores this agent should auto-attach on every
   * invocation. Mirrors `knowledgeBaseIds` in shape. The agent may
   * additionally attach stores at runtime via the `artifact.attach`
   * MCP tool; the effective set is the union, filtered by ACL.
   */
  @Column('jsonb', { default: '[]' })
  artifactStoreIds!: string[];

  @Column('jsonb', { nullable: true })
  outcomeSchema?: object;

  @Column('text', { nullable: true })
  outcomeDescription?: string;

  @Column({ type: 'varchar', length: 30, default: 'conversation' })
  memoryType!: 'none' | 'conversation' | 'sliding_window';

  /**
   * Memory & context-management configuration.
   *
   * - `windowSize`: kept for backwards compat with `memoryType: sliding_window`.
   * - `contextStrategy`: how to handle history that overflows the model's
   *   context window. See docs/design/agent-service-context-management.md.
   * - `summaryModel`: model ID used when `contextStrategy` is `summarize` or
   *   `hybrid`. Defaults to a cheap model picked by provider.
   * - `verbatimTurns`: number of recent user-to-user turns kept verbatim
   *   before summarization kicks in.
   * - `toolRoundReservation`: tokens reserved for in-turn tool-call rounds.
   * - `outputReservation`: tokens reserved for the model's response.
   * - `safetyBufferPct`: percentage of context window held back as a buffer.
   * - `summaryRefreshEveryTurns`: cadence for background summary refresh.
   */
  @Column('jsonb', { nullable: true })
  memoryConfig?: {
    windowSize?: number;
    contextStrategy?: 'trim' | 'summarize' | 'hybrid' | 'sliding_window_strict' | 'none';
    summaryModel?: string;
    verbatimTurns?: number;
    toolRoundReservation?: number;
    outputReservation?: number;
    safetyBufferPct?: number;
    summaryRefreshEveryTurns?: number;
  };

  /**
   * Unified guardrails configuration (suite settings + lean rule references).
   * Stored verbatim and returned as-is by config-service; agent-service
   * resolves each `guardrail_id` against `guardrails_catalog`.
   * Replaces the legacy `{ maxIterations, timeoutSeconds, contentFilters }`
   * shape and the former `guardrails_card` column.
   */
  @Column('jsonb', { nullable: true })
  guardrails?: AgentGuardrails;

  // ─── New configuration cards (persistence-only; runtime wiring is TBD) ──
  // These mirror the snake_case-DB / camelCase-TS pattern used by
  // `synchronization_config` on KnowledgeBase. Existing fields above are
  // preserved untouched so the legacy GUI / runtime keeps working.

  /** High-level goal statement for the agent (free-form, distinct from `role`). */
  @Column('text', { nullable: true })
  goal?: string;

  /** Top-P (nucleus sampling) for the primary model. */
  @Column('float', { name: 'top_p', nullable: true })
  topP?: number;

  /** Top-K sampling for the primary model. */
  @Column('int', { name: 'top_k', nullable: true })
  topK?: number;

  /** Ordered list of model IDs to fail over to when the primary model errors. */
  @Column('jsonb', { name: 'fallback_model_ids', default: '[]' })
  fallbackModelIds!: string[];

  /** Generation parameters applied to every fallback model. */
  @Column('jsonb', { name: 'fallback_model_params', nullable: true })
  fallbackModelParams?: ModelParams;

  @Column('jsonb', { name: 'output_response', nullable: true })
  outputResponse?: AgentOutputResponse;

  @Column('jsonb', { name: 'structured_output', nullable: true })
  structuredOutput?: AgentStructuredOutput;

  @Column('jsonb', { name: 'memory_context', nullable: true })
  memoryContext?: AgentMemoryContext;

  @Column('jsonb', { nullable: true })
  retries?: AgentRetriesConfig;

  @Column('jsonb', { name: 'rate_limiting', nullable: true })
  rateLimiting?: AgentRateLimitingConfig;

  /**
   * Tool-call selection behavior. Defaults to `auto` (model decides whether
   * to call tools). Persistence-only today; the agent-service runtime does
   * not yet thread this into LiteLLM kwargs.
   */
  @Column({
    type: 'varchar',
    length: 20,
    name: 'function_choice_behavior',
    default: 'auto',
  })
  functionChoiceBehavior!: FunctionChoiceBehavior;

  /**
   * Termination strategy for this agent's run loop. Persistence-only today;
   * the legacy `guardrails.maxIterations` / `guardrails.timeoutSeconds`
   * still drive runtime termination.
   */
  @Column('jsonb', { name: 'termination_strategy', nullable: true })
  terminationStrategy?: TerminationStrategy;

  /**
   * Free-form labels for filtering / display. Stored as a PostgreSQL TEXT[]
   * column to match the convention used by `DataSet.labels`,
   * `DataSource.labels`, and `KnowledgeBase.labels` so shared label
   * filtering / indexing code does not have to special-case agents.
   * Absent / empty array means "no labels".
   */
  @Column('text', { array: true, nullable: true })
  labels?: string[];

  // ─── Lifecycle / deployment status ─────────────────────────────────────
  // Updated primarily through the dedicated `PUT /agents/{id}/status`
  // endpoint, but the regular PUT also accepts these so workflow callers
  // can set them inline when convenient.

  @Column({
    type: 'varchar',
    length: 20,
    default: 'Healthy',
  })
  status!: AgentStatus;

  @Column('text', { name: 'status_message', nullable: true })
  statusMessage?: string;

  @Column({
    type: 'varchar',
    length: 30,
    name: 'deployment_status',
    default: 'not_deployed',
  })
  deploymentStatus!: AgentDeploymentStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => AgentHistory, (history) => history.entity)
  history!: AgentHistory[];
}
