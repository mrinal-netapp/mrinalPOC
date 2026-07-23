import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type EvaluationRunStatus =
  | 'queued'
  | 'running'
  | 'aggregating'
  | 'success'
  | 'failed'
  | 'cancelled';

export type EvaluationBaselineStatus =
  | 'not_set'
  | 'current_baseline'
  | 'above_baseline'
  | 'below_baseline';

export type EvaluationRunTrigger = {
  actor: string;
  reason?: string;
  triggeredAt: string;
};

export interface EvaluationRunProvenance {
  triggeredAt: string;
  agentRef: { projectId: string; agentId?: string; agentTeam?: string; agentVersion?: string };
  models: string[];
  rubricIds: string[];
}

export interface EvaluationMetricGroup {
  key: string;
  label: string;
  passed: number;
  skipped: number;
  failed: number;
}

export interface EvaluationResults {
  testCaseCoveragePct: number;
  infrastructureFailureRatePct: number;
  qualityPct: number;
  progress?: { casesDone: number; casesTotal: number; percentage: number };
  domainMetrics?: Record<string, number>;
  metricGroups: EvaluationMetricGroup[];
  failedCaseCount: number;
  gateOutcome?: { passed: boolean; failedGates: string[] };
}

export interface EvaluationAuditEvent {
  at: string;
  actor?: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * A single execution of an evaluation template. Created by config-service when
 * a run is triggered; status/results/audit are written back by the
 * workflow-engine (workflow-only PATCH). Per-case detail is NOT stored here —
 * it lives at the computed path
 * `projects/{projectId}/evaluations/{evalId}/runs/{runId}/results.json` on
 * the artifact store (see `runDirKey()` in `eval-worker/lib/posix-store`).
 */
@Entity('evaluation_runs')
@Index('idx_eval_runs_template', ['projectId', 'templateId'])
export class EvaluationRun {
  @PrimaryGeneratedColumn('uuid')
  runId!: string;

  @Column()
  templateId!: string;

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: EvaluationRunStatus;

  @Column({ type: 'varchar', length: 24, default: 'not_set' })
  baselineStatus!: EvaluationBaselineStatus;

  @Column('text', { nullable: true })
  workflowId?: string;

  @Column('jsonb', { nullable: true })
  trigger?: EvaluationRunTrigger;

  @Column('jsonb', { nullable: true })
  provenance?: EvaluationRunProvenance;

  @Column('jsonb', { nullable: true })
  templateSnapshot?: any;

  @Column('jsonb', { nullable: true })
  results?: EvaluationResults;

  @Column('jsonb', { default: '[]' })
  audit!: EvaluationAuditEvent[];

  @Column({ type: 'timestamptz', nullable: true })
  startTime?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endTime?: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
