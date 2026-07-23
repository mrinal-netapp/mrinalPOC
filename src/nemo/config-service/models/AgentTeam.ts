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
import { AgentTeamHistory } from './history/AgentTeamHistory';
import { AgentTeamIdGenerator } from '../services/AgentTeamIdGenerator';
import type { TerminationStrategy } from './Agent';

/** Health state of the agent team. Mirrors `AgentStatus`. */
export type AgentTeamStatus = 'Healthy' | 'Unhealthy';

/**
 * Deployment lifecycle of the agent team. Mirrors `AgentDeploymentStatus`.
 *
 * `draft` and `preview` are pre-deployment states surfaced to the GUI.
 */
export type AgentTeamDeploymentStatus =
  | 'draft'
  | 'preview'
  | 'not_deployed'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'terminating'
  | 'terminated';

export interface AgentTeamMember {
  memberType: 'agent' | 'team';
  memberId: string;
  role?: string;
}

/**
 * Memory-context retention strategy. Maps 1:1 to MAF's runtime buffer
 * strategies (see `core/memory_buffer.py`):
 *
 *   - `none`           → memory disabled, no history sent
 *   - `window`         → sliding window (last K messages or N tokens)
 *   - `summary`        → LLM-summarized history with minimal verbatim tail
 *   - `summary_buffer` → last K verbatim + summary of older
 */
export type MemoryType = 'none' | 'window' | 'summary' | 'summary_buffer';

/**
 * Token-budget reservations subtracted from the model's context window
 * before any history is included. AgentStudio's distinctive contribution
 * over LangChain-style memory: explicit budgeting for tool I/O, output,
 * and a tokenizer safety margin.
 *
 *   available_for_history = context_window
 *                           − tokens(system_prompt)
 *                           − tokens(user_message)
 *                           − tool_round_reservation       (if tools attached)
 *                           − output_reservation
 *                           − safety_buffer (= context_window × safety_buffer_pct)
 */
export interface MemoryBudget {
  /** Tokens reserved for tool schemas + tool I/O mid-turn. Default 6000. */
  tool_round_reservation?: number;
  /** Tokens reserved for the assistant's response. Auto-resolved when absent. */
  output_reservation?: number;
  /** Percentage (0..0.5) of context window held back as tokenizer-drift insurance. Default 0.05. */
  safety_buffer_pct?: number;
}

/**
 * SummaryBuffer-only: adaptive switch between trim and summarize per-call,
 * driven by overflow ratio. Preserves the cost-optimization behavior the
 * legacy `contextStrategy='hybrid'` provided in agent-service: on small
 * overflows, just trim the oldest turns (cheap); on large overflows,
 * summarize (LLM cost justified).
 *
 * Threshold value matches agent-service's `DEFAULT_SUMMARY_OVERFLOW_THRESHOLD`
 * (env default 0.30) so the runtime behavior is unchanged across runtimes.
 */
export interface AdaptiveSummarizeConfig {
  /** Overflow ratio (0..1) above which the engine summarizes instead of trims. */
  overflow_threshold: number;
}

/**
 * Unified team memory configuration. New schema replacing the legacy
 * `memoryType` + `memoryConfig` pair. Source of truth going forward.
 *
 * All fields are optional on the wire — clients can POST the minimum
 * `{ type: 'window' }` (or even `{ enabled: false }`) and the backend
 * fills in sensible defaults via `normalizeMemoryContextInput`:
 *
 *   - missing `enabled` → defaults to `true` (a missing field must NOT
 *     silently disable memory)
 *   - missing `type`    → `'window'` when enabled, `'none'` when disabled
 *
 * Field-level range checks live in `agentTeamValidator.ts`; the cross-
 * field "type-conditional" rules originally documented here have been
 * lifted in favor of MAF-side defaults — e.g. a `type='window'` payload
 * without a `message_window_limit` is accepted and gets the 20-message
 * default applied at translation time.
 *
 * When both `message_window_limit` and `message_token_limit` are set,
 * `message_token_limit` wins (tokens are the truer cost signal).
 *
 * When `memoryContext` is absent / NULL on the row, MAF derives one
 * from the legacy fields; absolute fallback is
 * `{ enabled: true, type: 'window', message_window_limit: 20 }`.
 */
export interface TeamMemoryContext {
  enabled: boolean;
  type: MemoryType;

  /** Window/SummaryBuffer: last-K messages kept verbatim. Messages, not turns. 0..200. */
  message_window_limit?: number;
  /** Window: alternative cap in tokens. Wins over `message_window_limit` when both set. */
  message_token_limit?: number;

  /**
   * Summary/SummaryBuffer: max tokens for the generated summary blob.
   * `0` is the documented "use server default (2000)" sentinel; non-zero
   * values must be at least 64 (validator enforces this — anything
   * smaller can't carry a meaningful summary).
   */
  summary_token_limit?: number;
  /** Summary/SummaryBuffer: cadence gating. 0 = always summarize on overflow. Default 0. */
  summary_refresh_every_turns?: number;
  /**
   * Summary/SummaryBuffer: which LLM does summarization. Accepts a catalog
   * UUID OR a `provider/name` string; resolved server-side via the same
   * `resolveGatewayModelId` lookup used elsewhere. When unreachable, MAF
   * silently degrades to `window` with a structured warn log.
   */
  summary_model?: string;

  /** SummaryBuffer-only: hybrid-equivalent adaptive cost optimization. */
  adaptive_summarize?: AdaptiveSummarizeConfig;

  /** Token-budget reservations carved out of the context window. */
  budget?: MemoryBudget;
}

/**
 * Agent-to-Agent (A2A) external server endpoint. When `enabled=true` the
 * team can hand off requests to an externally hosted agent reachable at
 * `server_url`. Validators reject `enabled=true` with a missing/blank
 * `server_url`.
 */
export interface A2AServerConfig {
  enabled: boolean;
  server_url: string;
}

/**
 * Manager configuration for an agent team.
 *
 * Two shapes are accepted:
 *   1. `{ agent_id }` reference to an existing agent in the same project.
 *      All other fields are optional; the team resolves the manager's
 *      effective config from the referenced agent at runtime.
 *   2. Inline manager: `name` + `systemPrompt` + at least one of
 *      `modelId` / `modelClass` are required.
 */
export interface AgentTeamManager {
  agent_id?: string;
  name?: string;
  role?: string;
  modelId?: string;
  modelClass?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  guardrails?: {
    maxIterations?: number;
    timeoutSeconds?: number;
    contentFilters?: string[];
  };
}

@Entity('agent_teams')
@Index(['projectId', 'name'], { unique: true })
export class AgentTeam {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = AgentTeamIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 20, default: 'coordinate' })
  orchestrationPolicy!: 'coordinate' | 'route' | 'collaborate' | 'sequential' | 'concurrent';

  @Column('jsonb', { nullable: true })
  manager?: AgentTeamManager;

  @Column('jsonb', { default: '[]' })
  members!: AgentTeamMember[];

  @Column('jsonb', { default: '[]' })
  sharedKnowledgeBaseIds!: string[];

  @Column('jsonb', { default: '[]' })
  sharedDatasetIds!: string[];

  /**
   * Artifact stores shared by every member of this team for the
   * duration of a team invocation. Mirrors `sharedKnowledgeBaseIds` /
   * `sharedDatasetIds` in shape. Members may also have per-agent
   * `artifactStoreIds`; the effective set is the union, filtered by ACL.
   */
  @Column('jsonb', { default: '[]' })
  artifactStoreIds!: string[];

  /**
   * Team-level memory type. Mirrors the field on Agent so context
   * management treats teams symmetrically. See design doc §Team support.
   */
  @Column({ type: 'varchar', length: 30, default: 'conversation' })
  memoryType!: 'none' | 'conversation' | 'sliding_window';

  /** Team-level context-management config; identical shape to Agent.memoryConfig. */
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
   * Team-level unified memory configuration (new schema). Replaces the legacy
   * `memoryType` + `memoryConfig` pair as the source of truth going forward.
   * The legacy fields are auto-derived from this on save (see
   * agentTeamRoutes save handler) so agent-service stays operational until
   * its decommission.
   *
   * Shape locked per the memory-context design:
   *
   *   type: 'none' | 'window' | 'summary' | 'summary_buffer'
   *   message_window_limit / message_token_limit  (window family; token wins)
   *   summary_token_limit / summary_refresh_every_turns / summary_model
   *   adaptive_summarize.overflow_threshold        (preserves hybrid behavior)
   *   budget.{tool_round_reservation, output_reservation, safety_buffer_pct}
   *
   * MAF dual-reads: when this is NULL, it derives a MemoryContext from
   * `memoryType` + `memoryConfig`; when both are absent, defaults to
   * `{ type: 'window', message_window_limit: 20 }`.
   */
  @Column('jsonb', { name: 'memory_context', nullable: true })
  memoryContext?: TeamMemoryContext;

  /**
   * A2A external server endpoint (persistence-only; runtime adapter TBD).
   */
  @Column('jsonb', { name: 'a2a_server', nullable: true })
  a2aServer?: A2AServerConfig;

  /**
   * Termination strategy for the team's orchestration loop. Persistence-only
   * today; the team-factory does not yet honor this field.
   */
  @Column('jsonb', { name: 'termination_strategy', nullable: true })
  terminationStrategy?: TerminationStrategy;

  /**
   * Free-form labels for filtering / display. Stored as a PostgreSQL TEXT[]
   * column to match the convention used by `DataSet.labels`,
   * `DataSource.labels`, and `KnowledgeBase.labels`. Absent / empty array
   * means "no labels".
   */
  @Column('text', { array: true, nullable: true })
  labels?: string[];

  // ─── Lifecycle / deployment status ─────────────────────────────────────
  // See AgentStatus / AgentDeploymentStatus on Agent for semantics. Updated
  // primarily through the dedicated `PUT /agent-teams/{id}/status` endpoint.

  @Column({
    type: 'varchar',
    length: 20,
    default: 'Healthy',
  })
  status!: AgentTeamStatus;

  @Column('text', { name: 'status_message', nullable: true })
  statusMessage?: string;

  @Column({
    type: 'varchar',
    length: 30,
    name: 'deployment_status',
    default: 'not_deployed',
  })
  deploymentStatus!: AgentTeamDeploymentStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => AgentTeamHistory, (history) => history.entity)
  history!: AgentTeamHistory[];
}
