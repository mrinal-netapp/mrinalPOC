import 'reflect-metadata';
import express, { Router, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Not } from 'typeorm';
import { AppDataSource } from '../db/postgres';
import { EvaluationTemplate } from '../models/EvaluationTemplate';
import { EvaluationRun } from '../models/EvaluationRun';
import { EvaluationTemplateHistory } from '../models/history/EvaluationTemplateHistory';
import { validateProject } from '../middleware/projectValidator';
import {
  createEvaluationTemplateValidator,
  updateEvaluationTemplateValidator,
  runOptionsValidator,
} from '../validators/evaluationValidator';
import { applyForEntity, removeForSource } from '../services/ReferenceEdgeService';
import {
  EvaluationService,
  EvaluationNotFound,
  EvaluationConflict,
} from '../services/EvaluationService';
import { getEvaluationWorkflowClient } from '../services/EvaluationWorkflowClient';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { s3Client } from '../utils/s3Utils';

const router = Router({ mergeParams: true });

const actorOf = (req: Request): string =>
  req.user?.name ||
  req.user?.preferred_username ||
  req.user?.email ||
  req.user?.sub ||
  'unknown';

const IMMUTABLE_TEMPLATE_FIELDS = new Set([
  'templateId',
  'projectId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdBy',
  'owner',
  'lastModifiedBy',
  'history',
]);

/**
 * Reconcile a template's schedule with the workflow-engine (PLACEHOLDER no-op)
 * and persist scheduleStatus. Honest about the stub: state stays 'paused' and
 * next/last run are undefined until the workflow-engine is wired.
 */
async function reconcileSchedule(template: EvaluationTemplate): Promise<void> {
  if (!template.schedule?.enabled) {
    if (template.scheduleStatus) {
      await AppDataSource.getRepository(EvaluationTemplate).update(
        { templateId: template.templateId },
        { scheduleStatus: { ...template.scheduleStatus, state: 'paused' } },
      );
    }
    return;
  }
  const { temporalScheduleId } = await getEvaluationWorkflowClient().reconcileSchedule(template);
  await AppDataSource.getRepository(EvaluationTemplate).update(
    { templateId: template.templateId },
    { scheduleStatus: { state: 'paused', temporalScheduleId } },
  );
}

// ─────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────

router.post('/templates', validateProject, createEvaluationTemplateValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const evalName = String(req.body.evalName).trim();

    const exists = await repo.findOne({ where: { projectId, evalName } });
    if (exists) {
      return res.status(409).json({ error: 'Evaluation template with this name already exists in this project' });
    }

    const actor = actorOf(req);
    const template = repo.create({
      ...req.body,
      evalName,
      projectId,
      owner: actor,
      createdBy: actor,
      lastModifiedBy: actor,
    } as Partial<EvaluationTemplate>);
    const saved = await repo.save(template);

    await applyForEntity(undefined, 'evaluation', projectId, saved);
    await reconcileSchedule(saved);

    const fresh = await repo.findOne({ where: { templateId: saved.templateId, projectId } });
    res.status(201).json(fresh ?? saved);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/templates', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const templates = await EvaluationService.listTemplates(projectId, {
      runMode: req.query.runMode as string | undefined,
      suite: req.query.suite as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json(templates);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/templates/:templateId', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, templateId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const template = await repo.findOne({ where: { templateId, projectId } });
    if (!template) return res.status(404).json({ error: 'Evaluation template not found' });
    res.json(template);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/templates/:templateId', validateProject, updateEvaluationTemplateValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, templateId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const current = await repo.findOne({ where: { templateId, projectId } });
    if (!current) return res.status(404).json({ error: 'Evaluation template not found' });

    if (req.body.evalName !== undefined && String(req.body.evalName).trim() !== '') {
      const nextName = String(req.body.evalName).trim();
      if (nextName !== current.evalName) {
        const dupe = await repo.findOne({ where: { projectId, evalName: nextName, templateId: Not(templateId) } });
        if (dupe) {
          return res.status(409).json({ error: 'Evaluation template with this name already exists in this project' });
        }
      }
    }

    const updateData: Record<string, unknown> = {};
    for (const key of Object.keys(req.body)) {
      if (req.body[key] !== undefined && !IMMUTABLE_TEMPLATE_FIELDS.has(key)) {
        updateData[key] = key === 'evalName' ? String(req.body[key]).trim() : req.body[key];
      }
    }
    updateData.lastModifiedBy = actorOf(req);

    if (Object.keys(updateData).length > 0) {
      await repo.update({ templateId, projectId }, updateData as any);
    }

    const updated = await repo.findOne({ where: { templateId, projectId } });
    if (!updated) return res.status(404).json({ error: 'Evaluation template not found' });

    await applyForEntity(undefined, 'evaluation', projectId, updated);
    if ('schedule' in req.body) {
      await reconcileSchedule(updated);
    }

    const fresh = await repo.findOne({ where: { templateId, projectId } });
    res.json(fresh ?? updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/templates/:templateId', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, templateId } = req.params;
    const hard = String(req.query.hard || '').toLowerCase() === 'true';
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const template = await repo.findOne({ where: { templateId, projectId } });
    if (!template) return res.status(404).json({ error: 'Evaluation template not found' });

    // PLACEHOLDER: cancel in-flight runs + tear down Temporal schedule.
    if (template.schedule?.enabled) {
      try {
        await getEvaluationWorkflowClient().tearDownSchedule(template);
      } catch {
        console.warn('[evaluationAgentRoutes] Failed to delete Temporal schedule during evaluation template delete; continuing with best-effort cleanup');
      }
    }

    await removeForSource(undefined, 'evaluation', projectId, templateId);

    if (hard) {
      // Hard delete: remove runs/history then the row. Test cases are
      // no longer stored in config-service (item 4 / JSONL pivot) — the
      // referenced project Dataset is intentionally NOT cascaded; an
      // operator can delete it via the Datasets API if desired.
      await AppDataSource.getRepository(EvaluationRun).delete({ templateId, projectId });
      await repo.remove(template); // fires beforeRemove → history 'delete'
    } else {
      await repo.softDelete({ templateId, projectId }); // fires afterUpdate → history 'update'
    }

    res.status(204).send();
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/templates/:templateId/history', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, templateId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const template = await repo.findOne({ where: { templateId, projectId }, withDeleted: true });
    if (!template) return res.status(404).json({ error: 'Evaluation template not found' });

    const histRepo = AppDataSource.getRepository(EvaluationTemplateHistory);
    const history = await histRepo.find({ where: { entityId: templateId }, order: { version: 'DESC' } });
    if (!history.length) return res.status(404).json({ error: 'No history found for this evaluation template' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/templates/:templateId/restore-version', validateProject, async (req: Request, res: Response) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const { projectId, templateId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const template = await repo.findOne({ where: { templateId, projectId } });
    if (!template) return res.status(404).json({ error: 'Evaluation template not found' });

    const histRepo = AppDataSource.getRepository(EvaluationTemplateHistory);
    const history = await histRepo.findOne({ where: { entityId: templateId, version } });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });

    const { data } = history;
    const { templateId: _t, projectId: _p, createdAt, updatedAt, deletedAt, ...restoreData } = data;
    (restoreData as any).lastModifiedBy = actorOf(req);

    await repo.update({ templateId, projectId }, { ...restoreData, projectId } as any);
    const updated = await repo.findOne({ where: { templateId, projectId } });
    if (!updated) return res.status(404).json({ error: 'Evaluation template not found' });
    await applyForEntity(undefined, 'evaluation', projectId, updated);
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/templates/:templateId/schedule', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, templateId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationTemplate);
    const template = await repo.findOne({ where: { templateId, projectId } });
    if (!template) return res.status(404).json({ error: 'Evaluation template not found' });
    res.json({ schedule: template.schedule ?? null, scheduleStatus: template.scheduleStatus ?? null });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Estimated evaluation impact (wizard tiles). Pure compute, no persistence.
router.post('/templates/estimate', validateProject, async (req: Request, res: Response) => {
  try {
    const evaluators = req.body?.evaluators || {};
    const strategy = evaluators.strategy;
    const usesAiJudge = strategy === 'llm_judge' || strategy === 'both';
    const estimate = EvaluationService.estimateImpact({
      testCaseCount: Number(req.body?.testCaseCount) || 0,
      judgeDimensionCount: Array.isArray(evaluators.aiJudge?.dimensions)
        ? evaluators.aiJudge.dimensions.length
        : 0,
      deterministicMetricCount: Array.isArray(evaluators.deterministic?.metrics)
        ? evaluators.deterministic.metrics.length
        : 0,
      usesAiJudge,
    });
    res.json(estimate);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Test cases (nested under template)
// ─────────────────────────────────────────────────────────────

async function loadTemplateOr404(projectId: string, templateId: string, res: Response): Promise<EvaluationTemplate | null> {
  const repo = AppDataSource.getRepository(EvaluationTemplate);
  const template = await repo.findOne({ where: { templateId, projectId } });
  if (!template) {
    res.status(404).json({ error: 'Evaluation template not found' });
    return null;
  }
  return template;
}

// ─────────────────────────────────────────────────────────────
// Test cases (eval-owned, NOT a project Dataset).
//
// JSONL bytes live on the PVC at
//   `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`
// alongside the eval's run history. Authors upload via the
// eval-scoped routes below; the bytes never reach config-service's
// database. The template carries only the storage pointer (filename).
//
// `evalId` in the URL is the slugified `evalName` (one-to-one with the
// template). The handlers iterate templates in the project to resolve
// the evalId → templateId mapping (project template counts are small,
// so a denormalized `evalId` column isn't worth a migration today).
// ─────────────────────────────────────────────────────────────

/** evalId slugifier — must match `slugify()` in the eval-worker's posix-store.ts. */
function slugifyEvalName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unnamed'
  );
}

/**
 * Resolve a template by `(projectId, evalId)` where `evalId` is the
 * slug of the template's `evalName`. Returns null when no template
 * matches. Used by the testcases routes.
 */
async function findTemplateByEvalId(
  projectId: string,
  evalId: string,
): Promise<EvaluationTemplate | null> {
  const repo = AppDataSource.getRepository(EvaluationTemplate);
  // Templates per project are small (<100 typical, hard-capped by quota);
  // a full scan is fine. If this ever becomes hot, add a denormalized
  // `evalId` column with a unique index on (projectId, evalId).
  const candidates = await repo.find({ where: { projectId } });
  return (
    candidates.find((t) => slugifyEvalName(t.evalName) === evalId) ?? null
  );
}

interface TestCasesUploadResult {
  filename: string;
  byteCount: number;
  /** Best-effort line count (newline-delimited). */
  lineCount: number;
}

const TESTCASES_DEFAULT_FILENAME = 'cases.jsonl';
/** Body-size cap mirrors the global JSON limit so large suites can land. */
const TESTCASES_BODY_LIMIT = process.env.EVALUATION_TESTCASES_BODY_LIMIT || '64mb';
const FILENAME_PATTERN = /^[a-zA-Z0-9._-]+\.(jsonl|json)$/;

function projectS3Layout(projectHomeDir: string): {
  bucketName: string;
  pathPrefix: string;
} {
  return getProjectStorageRoot({ home_dir: projectHomeDir });
}

/**
 * `PUT /api/v1/projects/{projectId}/evaluation/agents/evaluations/{evalId}/testcases`
 *
 * Accepts a raw JSONL body (`Content-Type: application/x-ndjson` or
 * `application/octet-stream` or `text/plain`) and writes it to the PVC at
 *   `projects/{projectId}/evaluations/{evalId}/testcases/{filename ?? 'cases.jsonl'}`
 *
 * Side effects:
 *   - Records `template.cases.filename` when the caller specifies a
 *     non-default `?filename=...`.
 *
 * The route does NOT parse the JSONL — schema validation is the eval
 * worker's `validateTestCases` activity at workflow start (where errors
 * surface with full per-row context to the run page).
 */
router.put(
  '/evaluations/:evalId/testcases',
  validateProject,
  express.raw({
    type: () => true,
    limit: TESTCASES_BODY_LIMIT,
  }),
  async (req: Request, res: Response) => {
    try {
      const { projectId, evalId } = req.params;
      const filenameParam =
        typeof req.query.filename === 'string'
          ? req.query.filename
          : undefined;
      const filename = filenameParam ?? TESTCASES_DEFAULT_FILENAME;
      if (!FILENAME_PATTERN.test(filename)) {
        return res.status(400).json({
          error: `invalid filename '${filename}' (allowed: [a-zA-Z0-9._-] + .jsonl/.json)`,
        });
      }

      const bytes: Buffer = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from('');
      if (bytes.byteLength === 0) {
        return res.status(400).json({ error: 'request body is empty' });
      }

      const template = await findTemplateByEvalId(projectId, evalId);
      if (!template) {
        return res
          .status(404)
          .json({ error: `evaluation '${evalId}' not found` });
      }

      const project = await new ProjectRepository(AppDataSource).getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'project not found' });
      }
      const { bucketName, pathPrefix } = projectS3Layout(project.home_dir);
      const key = `${pathPrefix}/evaluations/${evalId}/testcases/${filename}`;

      const lineCount =
        bytes.length === 0
          ? 0
          : bytes.toString('utf8').split('\n').filter((l) => l.trim().length > 0).length;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: bytes,
          ContentType: 'application/x-ndjson',
        }),
      );

      // Update the template pointer with the current filename so the
      // worker can resolve it at run-staging time.
      const repo = AppDataSource.getRepository(EvaluationTemplate);
      const nextCases: EvaluationTemplate['cases'] = {
        schemaVersion: template.cases?.schemaVersion ?? 'golden_test_v1',
        ...(filename !== TESTCASES_DEFAULT_FILENAME && { filename }),
        ...(template.cases?.sample && { sample: template.cases.sample }),
      };
      await repo.update(
        { templateId: template.templateId },
        { cases: nextCases, lastModifiedBy: actorOf(req) },
      );

      const result: TestCasesUploadResult = {
        filename,
        byteCount: bytes.byteLength,
        lineCount,
      };
      res.status(200).json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? String(e) });
    }
  },
);

/**
 * `GET /api/v1/projects/{projectId}/evaluation/agents/evaluations/{evalId}/testcases`
 *
 * Returns metadata only by default (`?include=metadata`, default).
 * `?include=body` streams the JSONL bytes back as `application/x-ndjson`.
 */
router.get(
  '/evaluations/:evalId/testcases',
  validateProject,
  async (req: Request, res: Response) => {
    try {
      const { projectId, evalId } = req.params;
      const include = (req.query.include as string) || 'metadata';

      const template = await findTemplateByEvalId(projectId, evalId);
      if (!template) {
        return res
          .status(404)
          .json({ error: `evaluation '${evalId}' not found` });
      }

      const project = await new ProjectRepository(AppDataSource).getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'project not found' });
      }
      const { bucketName, pathPrefix } = projectS3Layout(project.home_dir);
      const filename = template.cases?.filename ?? TESTCASES_DEFAULT_FILENAME;
      const key = `${pathPrefix}/evaluations/${evalId}/testcases/${filename}`;

      const obj = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: key }),
      );
      const bytes: Buffer = Buffer.from(
        (await obj.Body!.transformToByteArray?.()) ??
          (await streamToBuffer(obj.Body as NodeJS.ReadableStream)),
      );

      if (include === 'body') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('X-TestCases-Filename', filename);
        return res.status(200).send(bytes);
      }
      const lineCount = bytes
        .toString('utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0).length;
      return res.status(200).json({
        filename,
        byteCount: bytes.byteLength,
        lineCount,
      });
    } catch (e: any) {
      const code = e.$metadata?.httpStatusCode ?? e.Code ?? null;
      if (code === 404 || e.name === 'NoSuchKey') {
        return res.status(404).json({ error: 'test cases not uploaded yet' });
      }
      res.status(500).json({ error: e.message ?? String(e) });
    }
  },
);

/**
 * `DELETE /api/v1/projects/{projectId}/evaluation/agents/evaluations/{evalId}/testcases`
 *
 * Removes the JSONL from the PVC and clears `template.cases.filename`.
 * Idempotent — returns 204 even if the file was already absent.
 */
router.delete(
  '/evaluations/:evalId/testcases',
  validateProject,
  async (req: Request, res: Response) => {
    try {
      const { projectId, evalId } = req.params;
      const template = await findTemplateByEvalId(projectId, evalId);
      if (!template) {
        return res
          .status(404)
          .json({ error: `evaluation '${evalId}' not found` });
      }

      const project = await new ProjectRepository(AppDataSource).getById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'project not found' });
      }
      const { bucketName, pathPrefix } = projectS3Layout(project.home_dir);
      const filename = template.cases?.filename ?? TESTCASES_DEFAULT_FILENAME;
      const key = `${pathPrefix}/evaluations/${evalId}/testcases/${filename}`;

      try {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: key }),
        );
      } catch (err: any) {
        // S3 DELETE is idempotent; ignore "not found".
        if (
          err.$metadata?.httpStatusCode !== 404 &&
          err.name !== 'NoSuchKey'
        ) {
          throw err;
        }
      }

      const repo = AppDataSource.getRepository(EvaluationTemplate);
      const nextCases: EvaluationTemplate['cases'] | undefined = template.cases
        ? {
            schemaVersion: template.cases.schemaVersion,
            ...(template.cases.sample && { sample: template.cases.sample }),
          }
        : undefined;
      await repo.update(
        { templateId: template.templateId },
        {
          cases: nextCases as EvaluationTemplate['cases'],
          lastModifiedBy: actorOf(req),
        },
      );

      res.status(204).send();
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? String(e) });
    }
  },
);

async function streamToBuffer(
  stream: NodeJS.ReadableStream,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Runs
// ─────────────────────────────────────────────────────────────

router.post('/templates/:templateId/runs', validateProject, runOptionsValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, templateId } = req.params;
    const template = await loadTemplateOr404(projectId, templateId, res);
    if (!template) return;

    const run = await EvaluationService.createRun(template, {
      runId: req.body.runId,
      name: req.body.name,
      actor: req.body.actor || actorOf(req),
      reason: req.body.reason,
      fromRunId: req.body.fromRunId,
      overrides: req.body.overrides,
    });

    res.status(202).json({ runId: run.runId, workflowId: run.workflowId, status: run.status, run });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/runs', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = AppDataSource.getRepository(EvaluationRun);
    const qb = repo.createQueryBuilder('r').where('r.projectId = :projectId', { projectId });
    if (req.query.templateId) qb.andWhere('r.templateId = :templateId', { templateId: req.query.templateId });
    if (req.query.status) qb.andWhere('r.status = :status', { status: req.query.status });
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const skip = req.query.skip ? Number(req.query.skip) : 0;
    const items = await qb.orderBy('r.createdAt', 'DESC').skip(skip).take(limit).getMany();
    res.json(items);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/runs/:runId', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationRun);
    const run = await repo.findOne({ where: { runId, projectId } });
    if (!run) return res.status(404).json({ error: 'Evaluation run not found' });
    res.json(run);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Workflow-only writer: status / results / progress / timestamps.
router.patch('/runs/:runId', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationRun);
    const run = await repo.findOne({ where: { runId, projectId } });
    if (!run) return res.status(404).json({ error: 'Evaluation run not found' });

    const allowed = ['status', 'results', 'startTime', 'endTime', 'workflowId'];
    const updateData: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updateData[key] = req.body[key];
    }
    // Optional audit append in the same call.
    if (Array.isArray(req.body.auditAppend) && req.body.auditAppend.length > 0) {
      const events = req.body.auditAppend.map((e: any) => ({
        at: new Date().toISOString(),
        actor: e.actor || actorOf(req),
        type: e.type || 'workflow_event',
        message: e.message,
        data: e.data,
      }));
      updateData.audit = [...(run.audit || []), ...events];
    }
    if (Object.keys(updateData).length > 0) {
      await repo.update({ runId, projectId }, updateData as any);
    }
    const updated = await repo.findOne({ where: { runId, projectId } });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Soft-cancel signal name — must match the worker's
// `EVALUATION_CANCEL_SIGNAL` (see `lib/evaluation/lib/workflow-signals.ts`).
// Sending the signal lets the workflow drain in-flight cases within
// `DEFAULT_STOP_GRACE_SECONDS` and produce a clean `cancelled` finalize
// path; falling back to a hard Temporal cancel kills activities mid-flight.
const EVALUATION_CANCEL_SIGNAL_NAME = 'evaluation.cancel';

router.post('/runs/:runId/cancel', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationRun);
    const run = await repo.findOne({ where: { runId, projectId } });
    if (!run) return res.status(404).json({ error: 'Evaluation run not found' });

    // Soft-cancel first: deliver the signal so the workflow can drain.
    // If the signal fails (workflow-engine unreachable / pre-existing
    // workflow without the handler), fall back to a hard Temporal
    // cancel so the user-visible cancel still works.
    if (run.workflowId) {
      const client = getEvaluationWorkflowClient();
      try {
        await client.signal(run.workflowId, EVALUATION_CANCEL_SIGNAL_NAME);
      } catch {
        await client.cancel(run.workflowId).catch(() => {});
      }
    }
    const audit = [
      ...(run.audit || []),
      {
        at: new Date().toISOString(),
        actor: actorOf(req),
        // Route emits `stop.requested` — the workflow's finalize()
        // writes the terminal `stopped` audit once drain completes.
        type: 'evaluation.stop.requested',
        message: 'Run cancellation requested',
      },
    ];
    // The route used to write `status: 'cancelled'` synchronously, but
    // with the signal-based drain the workflow owns the terminal status
    // transition. We append a stop.requested audit event and let the
    // workflow finalize the row; the audit alone gives the UI immediate
    // feedback that a cancel is in flight.
    await repo.update({ runId, projectId }, { audit } as any);
    const updated = await repo.findOne({ where: { runId, projectId } });
    res.json(updated);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:runId/baseline', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const updated = await EvaluationService.setBaseline(projectId, runId);
    res.json(updated);
  } catch (e: any) {
    if (e instanceof EvaluationNotFound) return res.status(404).json({ error: e.message });
    if (e instanceof EvaluationConflict) return res.status(409).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────
// Audit events
// ─────────────────────────────────────────────────────────────

router.get('/runs/:runId/audit-events', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const repo = AppDataSource.getRepository(EvaluationRun);
    const run = await repo.findOne({ where: { runId, projectId } });
    if (!run) return res.status(404).json({ error: 'Evaluation run not found' });
    res.json(run.audit || []);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/runs/:runId/audit-events', validateProject, async (req: Request, res: Response) => {
  try {
    const { projectId, runId } = req.params;
    const { type, message, data } = req.body || {};
    if (!type || typeof type !== 'string') {
      return res.status(400).json({ error: 'type (string) is required' });
    }
    const repo = AppDataSource.getRepository(EvaluationRun);
    const run = await repo.findOne({ where: { runId, projectId } });
    if (!run) return res.status(404).json({ error: 'Evaluation run not found' });

    const event = { at: new Date().toISOString(), actor: actorOf(req), type, message, data };
    const audit = [...(run.audit || []), event];
    await repo.update({ runId, projectId }, { audit } as any);
    res.status(201).json(event);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
