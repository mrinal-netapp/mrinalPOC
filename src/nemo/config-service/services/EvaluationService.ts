import { AppDataSource } from '../db/postgres';
import { EvaluationTemplate } from '../models/EvaluationTemplate';
import { EvaluationRun } from '../models/EvaluationRun';
import { getEvaluationWorkflowClient } from './EvaluationWorkflowClient';

export interface RunOptions {
  runId?: string;
  name?: string;
  actor?: string;
  reason?: string;
  fromRunId?: string;
  overrides?: Record<string, unknown>;
}

export interface TemplateListItem extends EvaluationTemplate {
  latestRunStatus: string | null;
  runCount: number;
  lastRunUpdatedAt: Date | null;
}

/**
 * Orchestration for the Evaluations feature. CRUD persistence lives in the
 * route handlers (mirroring Agent/Model); this service owns the cross-row
 * logic: run-name generation, list enrichment, run-record creation (with the
 * placeholder workflow-engine handoff), and the transactional set-baseline.
 */
export class EvaluationService {
  /**
   * Heuristic estimate of run duration + cost for the wizard's "Estimated
   * evaluation impact" tiles. Transparent, assumption-based — NOT a billing
   * figure. Inputs: testCaseCount, judge dimension count, and whether AI
   * judging is enabled.
   */
  static estimateImpact(input: {
    testCaseCount?: number;
    judgeDimensionCount?: number;
    deterministicMetricCount?: number;
    usesAiJudge?: boolean;
  }): {
    estimatedDurationMinutes: number;
    estimatedCostUsd: number;
    assumptions: Record<string, number>;
  } {
    const cases = Math.max(0, input.testCaseCount ?? 0);
    const dims = Math.max(0, input.judgeDimensionCount ?? 0);
    const usesJudge = !!input.usesAiJudge && dims > 0;

    // Tunable assumptions (seconds / USD).
    const PREFLIGHT_SEC = 60;
    const PER_CASE_SUBJECT_SEC = 2.0; // run the agent per case
    const PER_JUDGE_DIM_SEC = 0.5; // judge each dimension per case
    const JUDGE_COST_PER_DIM_USD = 0.002; // per dimension scored per case

    const seconds =
      PREFLIGHT_SEC +
      cases * (PER_CASE_SUBJECT_SEC + (usesJudge ? dims * PER_JUDGE_DIM_SEC : 0));
    const cost = usesJudge ? cases * dims * JUDGE_COST_PER_DIM_USD : 0;

    return {
      estimatedDurationMinutes: Math.round((seconds / 60) * 10) / 10,
      estimatedCostUsd: Math.round(cost * 100) / 100,
      assumptions: {
        preflightSec: PREFLIGHT_SEC,
        perCaseSubjectSec: PER_CASE_SUBJECT_SEC,
        perJudgeDimSec: PER_JUDGE_DIM_SEC,
        judgeCostPerDimUsd: JUDGE_COST_PER_DIM_USD,
      },
    };
  }

  /** Stable, sortable, collision-resistant run name derived from the template. */
  static generateRunName(template: EvaluationTemplate): string {
    const base = (template.evalName || 'eval').replace(/\s+/g, '-');
    const version = template.agent?.agentVersion ? `-${template.agent.agentVersion}` : '';
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 13); // YYYYMMDDHHmm
    return `${base}${version}-${ts}`;
  }

  /**
   * List templates for a project, enriched with latest-run status + run count
   * (UI list columns). One grouped query over evaluation_runs, no N+1.
   */
  static async listTemplates(
    projectId: string,
    filters: { runMode?: string; suite?: string; status?: string } = {},
  ): Promise<TemplateListItem[]> {
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const qb = repo
      .createQueryBuilder('t')
      .where('t.projectId = :projectId', { projectId })
      .orderBy('t.updatedAt', 'DESC');
    if (filters.runMode) qb.andWhere('t.runMode = :runMode', { runMode: filters.runMode });
    if (filters.suite) qb.andWhere('t.suite = :suite', { suite: filters.suite });
    const templates = await qb.getMany();
    if (templates.length === 0) return [];

    const ids = templates.map((t) => t.templateId);
    const runRepo = AppDataSource.getRepository(EvaluationRun);

    // Run counts per template.
    const counts = await runRepo
      .createQueryBuilder('r')
      .select('r.templateId', 'templateId')
      .addSelect('COUNT(*)', 'count')
      .where('r.projectId = :projectId', { projectId })
      .andWhere('r.templateId IN (:...ids)', { ids })
      .groupBy('r.templateId')
      .getRawMany<{ templateId: string; count: string }>();
    const countByTemplate = new Map(counts.map((c) => [c.templateId, Number(c.count)]));

    // Latest run per template via Postgres DISTINCT ON — one row per template
    // (not all historical runs). The DISTINCT ON column must lead ORDER BY.
    const latestRows = await runRepo
      .createQueryBuilder('r')
      .distinctOn(['r.templateId'])
      .where('r.projectId = :projectId', { projectId })
      .andWhere('r.templateId IN (:...ids)', { ids })
      .orderBy('r.templateId', 'ASC')
      .addOrderBy('r.createdAt', 'DESC')
      .getMany();
    const latestByTemplate = new Map<string, EvaluationRun>();
    for (const r of latestRows) latestByTemplate.set(r.templateId, r);

    const items = templates.map((t) => {
      const latest = latestByTemplate.get(t.templateId) || null;
      return Object.assign({}, t, {
        latestRunStatus: latest ? latest.status : null,
        runCount: countByTemplate.get(t.templateId) ?? 0,
        lastRunUpdatedAt: latest ? latest.updatedAt : null,
      }) as TemplateListItem;
    });

    // `status` filters on the latest run's status (UI list column).
    return filters.status
      ? items.filter((i) => i.latestRunStatus === filters.status)
      : items;
  }

  /**
   * Create a run record from a template and hand off to the workflow-engine
   * (PLACEHOLDER no-op). The run is persisted in `queued` and stays there
   * until the workflow-engine is wired.
   */
  static async createRun(
    template: EvaluationTemplate,
    options: RunOptions,
  ): Promise<EvaluationRun> {
    const runRepo = AppDataSource.getRepository(EvaluationRun);

    // Cases are NOT snapshotted into the run row — they live on the
    // PVC at
    // `projects/{projectId}/evaluations/{evalId}/testcases/cases.jsonl`
    // (eval-owned, NOT a project Dataset). The eval worker validates
    // them via `validateTestCases` at workflow start.
    const triggeredAt = new Date().toISOString();

    const run = runRepo.create({
      // Honor a caller-provided id for idempotency; otherwise the column
      // default generates a UUID. (Validated as a UUID at the route layer.)
      ...(options.runId ? { runId: options.runId } : {}),
      templateId: template.templateId,
      projectId: template.projectId,
      name: options.name?.trim() || this.generateRunName(template),
      status: 'queued',
      baselineStatus: 'not_set',
      trigger: {
        actor: options.actor || 'unknown',
        reason: options.reason,
        triggeredAt,
      },
      provenance: {
        triggeredAt,
        agentRef: {
          projectId: template.projectId,
          agentId: template.agent?.agentId,
          agentTeam: template.agent?.agentTeam,
          agentVersion: template.agent?.agentVersion,
        },
        models: template.models || [],
        rubricIds: [
          ...(template.evaluators?.aiJudge?.dimensions || []),
          ...(template.evaluators?.deterministic?.metrics || []),
        ],
      },
      templateSnapshot: template,
      audit: [
        { at: triggeredAt, actor: options.actor, type: 'run_created', message: 'Run created' },
      ],
    });

    const saved = await runRepo.save(run);

    // Hand off to workflow-engine. If the handoff fails the row would
    // otherwise stay 'queued' with workflowId=null forever — no audit,
    // no retry, no signal to the UI. Mark the row failed, append an
    // audit event, and rethrow so the route returns 5xx and the caller
    // knows to retry.
    try {
      const { workflowId } = await getEvaluationWorkflowClient().startEvaluationRun(
        template.projectId,
        template.templateId,
        saved.runId,
      );
      saved.workflowId = workflowId;
      await runRepo.update({ runId: saved.runId }, { workflowId });
    } catch (err: any) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[EvaluationService] startEvaluationRun handoff failed for run ${saved.runId}: ${errorMessage}`,
      );
      const handoffAuditEvent = {
        at: new Date().toISOString(),
        actor: options.actor || 'system',
        type: 'evaluation.failed' as const,
        message: 'Workflow-engine handoff failed; run will not execute',
        data: { reason: 'workflow_engine_handoff_failed', error: errorMessage },
      };
      await runRepo
        .update(
          { runId: saved.runId },
          {
            status: 'failed',
            endTime: new Date(),
            audit: [...(saved.audit || []), handoffAuditEvent],
          } as any,
        )
        .catch((updateErr) => {
          console.error(
            `[EvaluationService] failed to mark run ${saved.runId} as failed after handoff error: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
          );
        });
      throw err;
    }

    return saved;
  }

  /**
   * Mark a completed run as the current baseline; demote the previous baseline
   * and recompute sibling runs' above/below status by qualityPct. Transactional.
   */
  static async setBaseline(projectId: string, runId: string): Promise<EvaluationRun> {
    return AppDataSource.transaction(async (manager) => {
      const runRepo = manager.getRepository(EvaluationRun);
      const tmplRepo = manager.getRepository(EvaluationTemplate);

      const run = await runRepo.findOne({ where: { runId, projectId } });
      if (!run) throw new EvaluationNotFound('Run not found');
      if (run.status !== 'success') {
        throw new EvaluationConflict('Only successful runs can be set as baseline');
      }

      const template = await tmplRepo.findOne({
        where: { templateId: run.templateId, projectId },
      });
      if (!template) throw new EvaluationNotFound('Template not found');

      const siblings = await runRepo.find({
        where: { templateId: run.templateId, projectId },
      });

      const baselineQuality = run.results?.qualityPct ?? null;

      for (const sib of siblings) {
        let baselineStatus: EvaluationRun['baselineStatus'];
        if (sib.runId === runId) {
          baselineStatus = 'current_baseline';
        } else if (baselineQuality == null || sib.results?.qualityPct == null) {
          baselineStatus = 'not_set';
        } else if (sib.results.qualityPct >= baselineQuality) {
          baselineStatus = 'above_baseline';
        } else {
          baselineStatus = 'below_baseline';
        }
        if (sib.baselineStatus !== baselineStatus) {
          await runRepo.update({ runId: sib.runId }, { baselineStatus });
        }
      }

      await tmplRepo.update(
        { templateId: template.templateId, projectId },
        { regression: { baselineRunId: runId } },
      );

      const updated = await runRepo.findOne({ where: { runId, projectId } });
      return updated as EvaluationRun;
    });
  }
}

export class EvaluationNotFound extends Error {
  statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationNotFound';
  }
}

export class EvaluationConflict extends Error {
  statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationConflict';
  }
}
