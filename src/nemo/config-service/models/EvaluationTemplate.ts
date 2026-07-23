import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  OneToMany,
  BeforeInsert,
} from 'typeorm';
import { EvaluationIdGenerator } from '../services/EvaluationIdGenerator';
import { EvaluationTemplateHistory } from './history/EvaluationTemplateHistory';

export type EvaluationTarget = 'agent_version';
export type EvaluationScope = 'full_agent_execution' | 'response_only' | 'retrieval_only';
export type EvaluationSuite = 'rag' | 'safety' | 'tool_use' | 'custom';
export type EvaluationStrategy = 'deterministic' | 'llm_judge' | 'both';
export type EvaluationRunMode = 'single' | 'regression' | 'ab_compare' | 'tuning_sweep' | 'repeats';
export type EvaluationScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface EvaluationAgentBinding {
  /** Single agent under evaluation. Required unless `agentTeam` is set. */
  agentId?: string;
  /** Agent team under evaluation. Required unless `agentId` is set. */
  agentTeam?: string;
  agentVersion?: string;
}

/** AI-judge configuration (UI "Configure AI judge" dialog). */
export interface EvaluationAiJudgeConfig {
  /** Judge model(s); required when strategy !== 'deterministic'. */
  models?: string[];
  /** Selected judge dimensions (keys from the rubric catalog). */
  dimensions: string[];
  evalMode?: 'pointwise' | 'pairwise';
  samplingMode?: 'all' | 'stratified' | 'fraction';
  stratifiedSlices?: boolean;
  gateWhenSampled?: 'informational' | 'blocking';
  goldenAvailable?: boolean;
}

/** Deterministic-metric configuration (UI "Configure deterministic metrics" dialog). */
export interface EvaluationDeterministicConfig {
  /** Selected deterministic metric ids (keys from the rubric catalog). */
  metrics: string[];
}

export interface EvaluationEvaluators {
  strategy: EvaluationStrategy;
  rubricPreset?: string;
  /** Present when strategy is 'llm_judge' or 'both'. */
  aiJudge?: EvaluationAiJudgeConfig;
  /** Present when strategy is 'deterministic' or 'both'. */
  deterministic?: EvaluationDeterministicConfig;
}

export interface EvaluationGate {
  id: string;
  level: 'warning' | 'blocking' | 'informational';
  threshold: number;
}

export interface EvaluationThresholds {
  gates: EvaluationGate[];
  coverageMinPct: number;
  infraFailureMaxPct: number;
  safetyP0Threshold: number;
  minCompletedCases: number;
}

/**
 * Pointer to the eval's test-cases JSONL on the data plane.
 *
 * Test cases are owned by the evaluation template — NOT a project Dataset.
 * The JSONL bytes live alongside the eval's run history at
 * `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`.
 * The eval worker validates the JSONL at workflow start
 * (`validateTestCases`).
 *
 * No customer-derived row content lives in `config-service` — only the
 * storage pointer (filename). The full path is computed from
 * `(projectId, evalId)` at runtime; there is no datasetId indirection.
 */
export interface EvaluationCasesConfig {
  schemaVersion: string;
  /** Override the default `cases.jsonl` filename inside the eval's `testcases/` folder. */
  filename?: string;
  sample?: { mode: 'all' | 'fraction' | 'stratified'; fraction?: number; stratifyBy?: string };
}

export interface EvaluationSchedule {
  enabled: boolean;
  /** Required when enabled; may be omitted for a disabled schedule. */
  scheduleType?: EvaluationScheduleType;
  hourUtc?: number;
  minuteUtc?: number;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  cron?: string;
  timezone?: string;
}

export interface EvaluationScheduleStatus {
  state: 'active' | 'paused';
  lastRunAt?: string;
  nextRunAt?: string;
  temporalScheduleId?: string;
}

/**
 * Evaluation template: the reusable definition of *what* and *how* to evaluate
 * an agent (or future target) version. Runs are spawned from a template and
 * snapshot it at start. Project-scoped; unique evalName per project.
 */
@Entity('evaluation_templates')
@Index(['projectId', 'evalName'], { unique: true })
export class EvaluationTemplate {
  @PrimaryColumn('varchar', { length: 12 })
  templateId!: string;

  @BeforeInsert()
  generateId() {
    if (!this.templateId) {
      this.templateId = EvaluationIdGenerator.template();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  evalName!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column('text', { array: true, nullable: true })
  labels?: string[];

  @Column('text')
  owner!: string;

  @Column('text')
  createdBy!: string;

  @Column('text')
  lastModifiedBy!: string;

  // ── What we evaluate ──
  @Column({ type: 'varchar', length: 32, default: 'agent_version' })
  target!: EvaluationTarget;

  @Column('jsonb')
  agent!: EvaluationAgentBinding;

  @Column('jsonb', { default: '[]' })
  models!: string[];

  @Column({ type: 'varchar', length: 32, default: 'full_agent_execution' })
  evaluationScope!: EvaluationScope;

  @Column({ type: 'varchar', length: 16, default: 'custom' })
  suite!: EvaluationSuite;

  // ── How we evaluate ──
  @Column('jsonb')
  evaluators!: EvaluationEvaluators;

  @Column('jsonb', { nullable: true })
  thresholds?: EvaluationThresholds;

  // ── Test-case set (eval-owned, NOT a project Dataset) ──
  // The JSONL bytes live at
  //   projects/{projectId}/evaluations/{evalId}/testcases/{cases.filename ?? 'cases.jsonl'}
  // alongside the eval's run history, and never reach config-service.
  // The template carries only the storage pointer (filename + hash).
  // See `EvaluationCasesConfig` above.
  @Column('jsonb', { nullable: true })
  cases?: EvaluationCasesConfig;

  // ── Automatic scheduled runs ──
  @Column('jsonb', { nullable: true })
  schedule?: EvaluationSchedule;

  @Column('jsonb', { nullable: true })
  scheduleStatus?: EvaluationScheduleStatus;

  // ── Run mode ──
  @Column({ type: 'varchar', length: 16, default: 'single' })
  runMode!: EvaluationRunMode;

  @Column('jsonb', { nullable: true })
  regression?: { baselineRunId: string };

  @Column('jsonb', { nullable: true })
  ab?: Record<string, unknown>;

  @Column('jsonb', { nullable: true })
  sweep?: Record<string, unknown>;

  @Column('jsonb', { nullable: true })
  repeats?: { seeds: number[] };

  @Column('int', { nullable: true })
  concurrency?: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // Soft delete: DELETE marks deletedAt; ?hard=true removes the row.
  // NOTE: the (projectId, evalName) unique index is not partial, so a name is
  // reserved until its soft-deleted template is hard-deleted.
  @DeleteDateColumn({ nullable: true })
  deletedAt?: Date;

  @OneToMany(() => EvaluationTemplateHistory, (history) => history.entity)
  history!: EvaluationTemplateHistory[];
}
