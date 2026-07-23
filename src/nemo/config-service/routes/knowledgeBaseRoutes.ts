import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import * as express from 'express';
import axios from 'axios';
import { AppDataSource } from '../db/postgres';
import { Not } from 'typeorm';
import { isPostgresUniqueViolation } from '../utils/pgErrors';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { DataSet } from '../models/DataSet';
import { Project } from '../models/Project';
import { KnowledgeBaseHistory } from '../models/history/KnowledgeBaseHistory';
import { createKnowledgeBaseValidator, updateKnowledgeBaseValidator } from '../validators/knowledgeBaseValidator';
import { validationResult } from 'express-validator';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { FacetService, ConflictError as FacetConflictError } from '../services/FacetService';
import { ConflictError } from '../utils/errors';
import { sendErrorResponse } from '../utils/errorHandler';
import { FacetEntityType } from '../models/Facet';
import { validateProject } from '../middleware/projectValidator';
import {
  applyForEntity,
  hasDependents,
  summaryForTargets,
  listDependents,
  removeForSource,
} from '../services/ReferenceEdgeService';
import { KnowledgeBaseScheduleService } from '../services/KnowledgeBaseScheduleService';
import {
  KnowledgeBaseWorkflowService,
} from '../services/KnowledgeBaseWorkflowService';
import {
  extractKnowledgeBaseWorkflowUpdate,
  knowledgeBaseProcessingOverridesChanged,
  splitKnowledgeBaseUpdateBody,
} from '../utils/knowledgeBaseUpdateWorkflow';
import { resolveEmbeddingFields, resolveEmbeddingModelName } from '../services/knowledgeBaseEmbedding';
import { safeSegment, safeLog, safeConsoleWarn } from '../utils/safeStrings';
import { readProjectVirtualKeyToken } from '../services/bifrost/bifrostProjectGovernance';

const router = express.Router({ mergeParams: true });

const KB_DUPLICATE_NAME_MESSAGE =
  'Knowledge base with this name already exists in this project';

const KB_IN_PROGRESS_REPROCESS_MESSAGE =
  'Cannot reprocess while knowledge base is being processed; wait for the current sync to finish.';

/**
 * Compute the next scheduled run from a KBSynchronizationConfig without
 * requiring an external cron-parser library. Works on the structured fields
 * (schedule_type, interval_minutes, time_of_day, day_of_week, day_of_month)
 * so no string parsing is needed. Returns an ISO-8601 string or null.
 */
function nextRunFromSyncConfig(
  cfg: import('../models/KnowledgeBase').KBSynchronizationConfig | null | undefined,
  scheduleEnabled: boolean,
): string | null {
  if (!cfg || cfg.sync_mode !== 'scheduled' || !scheduleEnabled) return null;

  // Only compute next-run for UTC schedules. Non-UTC timezone-aware computation
  // requires a tz library; returning a UTC-based time for non-UTC schedules would
  // be incorrect, so we bail out early for those cases.
  const tz = (cfg as any).timezone ?? 'UTC';
  if (tz !== 'UTC' && tz !== 'utc') return null;

  const now = new Date();

  if (cfg.schedule_type === 'hourly' && cfg.interval_minutes) {
    // Always produce a time strictly in the future by advancing to the next
    // interval boundary after the current one.
    const intervalMs = cfg.interval_minutes * 60 * 1000;
    const next = new Date(Math.floor(now.getTime() / intervalMs) * intervalMs + intervalMs);
    return next.toISOString();
  }

  if (cfg.schedule_type === 'cron') {
    // Without a cron-parser library we can't compute this for arbitrary expressions.
    return null;
  }

  // daily / weekly / monthly — time_of_day is "HH:MM" in UTC
  const [hStr, mStr] = (cfg.time_of_day ?? '00:00').split(':');
  const h = parseInt(hStr ?? '0', 10);
  const m = parseInt(mStr ?? '0', 10);

  if (cfg.schedule_type === 'daily') {
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
  }

  if (cfg.schedule_type === 'weekly' && cfg.day_of_week?.length) {
    const days = cfg.day_of_week.slice().sort((a, b) => a - b);
    let best: Date | null = null;
    for (const dow of days) {
      const diff = (dow - now.getUTCDay() + 7) % 7;
      const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff, h, m));
      if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 7);
      if (!best || candidate < best) best = candidate;
    }
    return best ? best.toISOString() : null;
  }

  if (cfg.schedule_type === 'monthly' && cfg.day_of_month) {
    // Coerce to integer — day_of_month may arrive as a string when the body is
    // persisted as-is before the Number() coercion in the validator runs.
    // Without this, candidate.getUTCDate() (number) would never equal a string
    // and next_scheduled_synchronization would always return null.
    const dom = Math.trunc(Number(cfg.day_of_month));
    if (!Number.isFinite(dom) || dom < 1 || dom > 31) return null;
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    // Iterate up to 14 months to find a month where the requested day exists
    // and is strictly in the future (handles months shorter than dom, e.g. day
    // 31 in April overflows without this check).
    for (let attempts = 0; attempts < 14; attempts++) {
      if (month > 11) { month = 0; year += 1; }
      const candidate = new Date(Date.UTC(year, month, dom, h, m));
      // If JS date-overflow occurred (dom > days in month), skip this month.
      if (candidate.getUTCDate() !== dom) {
        month += 1;
        continue;
      }
      if (candidate > now) return candidate.toISOString();
      month += 1;
    }
    return null;
  }

  return null;
}

const WORKFLOW_ENGINE_URL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
const KB_RETRIEVAL_SERVICE_URL = process.env.KB_RETRIEVAL_SERVICE_URL || process.env.VECTOR_QUERY_SERVICE_URL || '';

/**
 * Fetch live progress from the workflow-engine's in-memory progress store.
 * Returns the progress payload or null if unavailable.
 */
async function fetchLiveProgress(workflowId: string): Promise<Record<string, any> | null> {
  try {
    const resp = await axios.get(
      `${WORKFLOW_ENGINE_URL}/api/v1/workflows/${workflowId}/progress`,
      { timeout: 1500 }
    );
    if (resp.status === 200 && resp.data) {
      return resp.data;
    }
  } catch {
    // Workflow-engine unreachable or no progress yet — fall back to DB value
  }
  return null;
}

/**
 * Enrich a single KB with live progress from the workflow-engine when it is
 * in_progress and has a jobId. Mutates the object in place for efficiency.
 */
async function enrichWithLiveProgress(kb: KnowledgeBase): Promise<KnowledgeBase> {
  if (kb.status === 'in_progress' && kb.jobId) {
    const live = await fetchLiveProgress(kb.jobId);
    if (live) {
      const extra = live.extra ?? {};
      kb.progress = {
        phase: live.phase ?? kb.progress?.phase,
        percentage: live.percentage ?? kb.progress?.percentage ?? 0,
        totalFiles: extra.totalFiles ?? kb.progress?.totalFiles,
        processedFiles: extra.documentsProcessed ?? kb.progress?.processedFiles,
        totalDocuments: extra.totalDocuments ?? kb.progress?.totalDocuments,
        chunksCreated: extra.chunksCreated ?? kb.progress?.chunksCreated,
        vectorsCreated: extra.vectorsCreated ?? kb.progress?.vectorsCreated,
        currentFile: extra.currentFile ?? kb.progress?.currentFile,
        estimatedRemainingFormatted: extra.estimatedRemainingFormatted,
        elapsedFormatted: extra.elapsedFormatted,
        lastUpdated: new Date().toISOString(),
        totalUnits: live.totalUnits,
        units: live.units,
      };
      // Populate stats from progress.json so the Stats section shows documents, chunks, vectors, size during in_progress
      const documentCount = extra.documentCount ?? extra.documentsProcessed;
      const chunkCount = extra.chunkCount ?? extra.chunksCreated;
      const vectorCount = extra.vectorCount ?? extra.vectorsCreated;
      const storageMB = extra.storageMB;
      if (documentCount != null || chunkCount != null || vectorCount != null || storageMB != null) {
        kb.stats = {
          ...(kb.stats || {}),
          ...(documentCount != null && { documentCount: Number(documentCount) }),
          ...(chunkCount != null && { chunkCount: Number(chunkCount) }),
          ...(vectorCount != null && { vectorCount: Number(vectorCount) }),
          ...(storageMB != null && { storageMB: Number(storageMB) }),
        };
      }
    }
  }
  return kb;
}

/**
 * Fetch KB stats from the metadata API (kb-retrieval or vector-query) when the KB
 * is ready but stats are missing. Mutates kb.stats in place.
 */
async function enrichWithMetadataStats(kb: KnowledgeBase): Promise<void> {
  if (kb.status !== 'ready' || !KB_RETRIEVAL_SERVICE_URL) return;
  const hasStats = kb.stats && (
    (kb.stats.chunkCount != null && kb.stats.chunkCount > 0) ||
    (kb.stats.documentCount != null && kb.stats.documentCount > 0)
  );
  if (hasStats) return;

  try {
    const projectId = kb.projectId;
    if (!projectId) return;
    const resp = await axios.get(
      `${KB_RETRIEVAL_SERVICE_URL}/api/v1/projects/${projectId}/knowledgebases/${kb.id}/metadata`,
      { timeout: 2000 }
    );
    if (resp.status !== 200 || !resp.data) return;
    const d = resp.data as { chunkCount?: number; chunk_count?: number; documentCount?: number; document_count?: number; storageMB?: number; storage_mb?: number; lastProcessedAt?: string; last_processed_at?: string };
    const chunkCount = d.chunkCount ?? d.chunk_count;
    const documentCount = d.documentCount ?? d.document_count;
    const storageMB = d.storageMB ?? d.storage_mb;
    const lastProcessedAt = d.lastProcessedAt ?? d.last_processed_at;
    if (chunkCount != null || documentCount != null || storageMB != null) {
      kb.stats = {
        ...(kb.stats || {}),
        ...(chunkCount != null && { chunkCount: Number(chunkCount), vectorCount: Number(chunkCount) }),
        ...(documentCount != null && { documentCount: Number(documentCount) }),
        ...(storageMB != null && { storageMB: Number(storageMB) }),
        ...(lastProcessedAt && { lastProcessedAt: String(lastProcessedAt) }),
      };
    }
  } catch {
    // Metadata service unreachable or KB not indexed yet — leave stats as-is
  }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     KnowledgeBase:
 *       type: object
 *       required: [name, sourceDataset, embeddingModel, chunkSize, vectorSize]
 *       properties:
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         sourceDataset:
 *           type: string
 *         embeddingModel:
 *           type: string
 *         chunkSize:
 *           type: integer
 *         vectorSize:
 *           type: integer
 *         dataType:
 *           type: string
 *           description: Deprecated - no longer used
 * tags:
 *   name: KnowledgeBases
 *   description: API endpoints for managing KnowledgeBases
 * /api/knowledgebases:
 *   get:
 *     summary: List knowledge bases
 *     tags: [KnowledgeBases]
 *     responses:
 *       '200':
 *         description: List of knowledge bases
 *   post:
 *     summary: Create a knowledge base
 *     tags: [KnowledgeBases]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/KnowledgeBase'
 *     responses:
 *       '201':
 *         description: Created
 * /api/knowledgebases/{id}:
 *   get:
 *     summary: Get knowledge base by ID
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Knowledge base
 *       '404':
 *         description: Not found
 *   put:
 *     summary: Update knowledge base by ID
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/KnowledgeBase'
 *     responses:
 *       '200':
 *         description: Updated
 *       '404':
 *         description: Not found
 *   delete:
 *     summary: Delete knowledge base by ID
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Deleted
 *       '404':
 *         description: Not found
 */

// Create KnowledgeBase and auto-trigger processing
router.post('/', validateProject, createKnowledgeBaseValidator, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const datasetRepo = AppDataSource.getRepository(DataSet);

    const { projectId } = req.params as { projectId: string };
    const rawName = req.body?.name;
    const name = typeof rawName === 'string' ? rawName.trim() : String(rawName ?? '').trim();
    const existing = await kbRepo.findOne({ where: { projectId, name } });
    if (existing) {
      throw new ConflictError(KB_DUPLICATE_NAME_MESSAGE);
    }

    // Resolve the embedding-model identity BEFORE persisting the KB row.
    // Doing this earlier than the workflow dispatch prevents an orphan KB
    // row from getting saved when the embeddingModel name doesn't match
    // any seeded built-in or user-registered remote model — the user can
    // then resubmit with a corrected model without hitting KB_DUPLICATE_NAME.
    const embeddingFields = await resolveEmbeddingFields(
      projectId,
      req.body || {},
      typeof req.body?.embeddingModel === 'string' ? req.body.embeddingModel : '',
    );
    if (!embeddingFields) {
      const requestedModel =
        (typeof req.body?.embeddingModelId === 'string' && req.body.embeddingModelId) ||
        (typeof req.body?.embeddingModel === 'string' && req.body.embeddingModel) ||
        '<unspecified>';
      return res.status(400).json({
        error: `No embedding model found in project catalog for '${requestedModel}'. Use a valid built-in (e.g. sentence-transformers/all-MiniLM-L6-v2) or register a remote embedding model first.`,
        code: 'EMBEDDING_MODEL_NOT_FOUND',
      });
    }

    // Always bind KB to route project to enforce project boundaries.
    // Stamp embeddingModelId at create-time so kb-retrieval-service can
    // resolve the model identity later without re-running the lookup.
    let kb: KnowledgeBase;
    try {
      kb = (await kbRepo.save(
        kbRepo.create({
          ...req.body,
          projectId,
          name,
          embeddingModelId: embeddingFields.embeddingModelId,
          // Validator now accepts requests carrying only `embeddingModelId`,
          // but `embeddingModel` is a NOT NULL column. Resolve from the
          // catalog row when the legacy field is absent.
          embeddingModel:
            (typeof req.body?.embeddingModel === 'string' && req.body.embeddingModel) ||
            embeddingFields.embeddingModel,
        })
      )) as unknown as KnowledgeBase;
    } catch (saveErr: unknown) {
      if (isPostgresUniqueViolation(saveErr)) {
        throw new ConflictError(KB_DUPLICATE_NAME_MESSAGE);
      }
      throw saveErr;
    }
    await applyForEntity(undefined, 'knowledge_base', projectId, kb);

    // Reconcile synchronizationConfig -> Temporal schedule.
    if (kb.synchronizationConfig) {
      try {
        const newScheduleConfig = await KnowledgeBaseScheduleService.applySynchronizationConfig(
          projectId,
          kb.id,
          kb.synchronizationConfig,
          kb.scheduleConfig,
        );
        if (newScheduleConfig) {
          kb.scheduleConfig = newScheduleConfig;
          await kbRepo.save(kb);
        }
      } catch (scheduleErr: any) {
        console.warn(
          `[knowledgeBaseRoutes] Failed to apply synchronizationConfig on KB ${kb.id}: ${scheduleErr.message}`,
        );
      }
    }

    // Auto-trigger KB creation workflow
    try {
      // Get source dataset
      const dataset = await datasetRepo.findOne({
        where: { id: kb.sourceDataset, projectId: kb.projectId }
      });

      if (!dataset) {
        // Return KB but with warning - dataset not found
        const freshKb = await kbRepo.findOne({ where: { id: kb.id } }) ?? kb;
        return res.status(201).json({
          ...freshKb,
          warning: 'KB created but workflow not started: source dataset not found'
        });
      }

      // Check if dataset is ready
      if (dataset.status !== 'ready') {
        // Return KB but with warning - dataset not ready
        const freshKb = await kbRepo.findOne({ where: { id: kb.id } }) ?? kb;
        return res.status(201).json({
          ...freshKb,
          warning: `KB created but workflow not started: source dataset status is '${dataset.status}', must be 'ready'`
        });
      }

      // Structured datasets have no file contents to extract text from — the
      // caller must specify textColumns (comma-separated column names), or
      // kb-processor will fail the run with "TEXT_COLUMNS is required for
      // structured datasets". Catch this early with the same warning-response
      // pattern used above instead of letting the workflow start and fail.
      if (dataset.kind === 'structured' && !(kb.textColumns && kb.textColumns.trim())) {
        const freshKb = await kbRepo.findOne({ where: { id: kb.id } }) ?? kb;
        return res.status(201).json({
          ...freshKb,
          warning: 'KB created but workflow not started: textColumns is required when the source dataset is structured (comma-separated list of column names)'
        });
      }

      // Derive bucket and pathPrefix from project home_dir
      const projectEntity = await AppDataSource.getRepository(Project).findOne({ where: { id: kb.projectId } });
      const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
      const namespace = kb.projectId;

      // Prepare workflow input with structured dataset support
      // Processing mode defaults to 'full' for new KB creation
      const processingMode = req.body.processingMode || 'full';
      // Resolve the per-project Bifrost virtual-key bearer so the kb-processor
      // activity can call the gateway. Soft-fail: kb-processor will raise a
      // clear "api_key is required" if absent, but log a warning here so
      // operators have a breadcrumb pointing at the missing K8s Secret
      // (gateway-setup workflow may not have run for legacy projects).
      let projectVirtualKeyToken = '';
      try {
        projectVirtualKeyToken = (await readProjectVirtualKeyToken(kb.projectId)) || '';
      } catch (vkErr: any) {
        logger.warn(
          `[knowledgeBaseRoutes] readProjectVirtualKeyToken failed for project ${safeLog(kb.projectId)}: ${safeLog(vkErr?.message || vkErr)}`,
        );
      }
      if (!projectVirtualKeyToken) {
        logger.warn(
          `[knowledgeBaseRoutes] No Bifrost virtual-key token for project ${safeLog(kb.projectId)} — kb-processor will fail with 'api_key is required'. Check that the as-proj-${safeLog(kb.projectId)}-vk K8s Secret exists and that gateway-setup has run.`,
        );
      }

      const workflowInput: Record<string, any> = {
        projectId: kb.projectId,
        knowledgeBaseId: kb.id,
        kbName: kb.name,
        sourceDatasetId: kb.sourceDataset,
        bucketName,
        pathPrefix,
        embeddingModel: kb.embeddingModel,
        chunkSize: kb.chunkSize,
        vectorSize: embeddingFields.embeddingDimensions || kb.vectorSize,
        dataType: kb.dataType,
        namespace,
        processingMode, // 'full' or 'incremental'
        // Chunking strategy support
        chunkStrategy: kb.chunkStrategy || 'fixed',
        chunkOverlap: kb.chunkOverlap ?? 50, // Default to 50 if not specified
        chunkOptions: kb.chunkOptions ? JSON.stringify(kb.chunkOptions) : '', // JSON string for strategy-specific options
        // Indexing mode for FTS/hybrid search support
        indexingMode: kb.indexingMode || 'hybrid',
        // Quantization support for vector index compression
        quantizationType: kb.quantizationType || 'auto',
        quantizationOptions: kb.quantizationOptions ? JSON.stringify(kb.quantizationOptions) : '', // JSON string
        // Structured dataset support
        datasetKind: dataset.kind || 'unstructured',
        catalogTableRef: dataset.catalogTableRef || '',
        textColumns: kb.textColumns || '', // User-specified columns for text extraction
        warehouseId: dataset.warehouseName || 'nemo',
        // Unified-embedding fields (Phase 5) — forwarded into the kb-processor
        // activity input so the gateway client has full model + auth context.
        embeddingModelId: embeddingFields.embeddingModelId,
        embeddingProvider: embeddingFields.embeddingProvider,
        embeddingProviderModelId: embeddingFields.embeddingProviderModelId,
        // Bifrost wire identifier (`<provider>/<gatewayBindingName>`). kb-processor
        // sends this as the `model` field on /v1/embeddings so the project VK's
        // allowed_models[] match succeeds.
        embeddingGatewayModelId: embeddingFields.embeddingGatewayModelId,
        embeddingEndpoint: embeddingFields.embeddingEndpoint,
        embeddingDimensions: embeddingFields.embeddingDimensions,
        projectVirtualKeyToken,
        llmGatewayUrl: process.env.LLM_GATEWAY_URL || '',
      };

      // Call workflow engine
      const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
      const response = await axios.post(
        `${workflowEngineURL}/api/v1/projects/${kb.projectId}/knowledgebases/${kb.id}/create`,
        workflowInput,
        {
          timeout: 30000,
          headers: {
            'Authorization': req.headers.authorization || ''
          }
        }
      );

      // Update KB status to in_progress and store jobId
      await kbRepo.update(kb.id, {
        status: 'in_progress',
        jobId: response.data.workflowId,
        namespace,
        bucketName,
      });

      // Return KB with workflow info
      const updatedKb = await kbRepo.findOne({ where: { id: kb.id } }) ?? kb;
      res.status(201).json({
        ...updatedKb,
        workflowId: response.data.workflowId,
        workflowStatus: 'running',
      });
    } catch (workflowErr: any) {
      // KB created but workflow failed to start - return KB with error info.
      // Log only the message/code to avoid circular-reference serialization of the
      // Axios error's HTTP Agent (which would throw and mask the 201 response).
      logger.error(`Failed to auto-trigger KB workflow: ${workflowErr?.message ?? workflowErr} (code: ${workflowErr?.code})`);
      const freshKb = await kbRepo.findOne({ where: { id: kb.id } }) ?? kb;
      res.status(201).json({
        ...freshKb,
        warning: 'KB created but workflow failed to start',
        workflowError: workflowErr.message,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get all KnowledgeBases
router.get('/', validateProject, async (req, res) => {
  try {
    const projectId = (req.params as { projectId?: string }).projectId ?? '';
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const kbs = await repo.find({ where: { projectId } });

    // Enrich in-progress KBs with live progress from workflow-engine
    const inProgress = kbs.filter(kb => kb.status === 'in_progress' && kb.jobId);
    await Promise.all(inProgress.map(kb => enrichWithLiveProgress(kb)));

    // Attach facets so GUI can show stats from embedding facet summary
    const facetMap = await FacetService.listFacetsBatch(projectId, KB_ENTITY_TYPE, kbs.map(kb => kb.id));
    const kbsWithFacets = kbs.map(kb => {
      const facets = facetMap.get(kb.id) ?? [];
      return Object.assign({}, kb, { facets });
    });

    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary || kbsWithFacets.length === 0) {
      return res.json(kbsWithFacets);
    }
    const summary = await summaryForTargets('knowledge_base', projectId, kbsWithFacets.map((k) => k.id));
    res.json(kbsWithFacets.map((k) => ({
      ...k,
      dependentsSummary: summary.get(k.id) ?? { total: 0, byKind: {} },
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get KnowledgeBase by ID
router.get('/:id', validateProject, async (req, res) => {
  try {
    const params = req.params as { projectId?: string; id: string };
    const projectId = params.projectId ?? '';
    const kbId = params.id;
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await repo.findOne({ where: { id: kbId, projectId } });
    if (!kb) return res.status(404).json({ error: 'KnowledgeBase not found' });

    // Enrich with live progress if in_progress
    await enrichWithLiveProgress(kb);

    // Attach facets so GUI gets stats from embedding facet summary (workflow-populated)
    const facets = await FacetService.listFacets(projectId, KB_ENTITY_TYPE, kbId);

    // Compute synchronizationSummary (mirrors the dataset route pattern).
    const scheduleEnabled = kb.scheduleConfig?.enabled ?? false;
    const synchronizationSummary = {
      schedule: scheduleEnabled ? (kb.scheduleConfig?.cronExpression ?? null) : null,
      last_completed_synchronization: kb.lastSyncedAt ?? null,
      next_scheduled_synchronization: nextRunFromSyncConfig(kb.synchronizationConfig, scheduleEnabled),
    };

    const kbWithFacets = Object.assign({}, kb, { facets, synchronizationSummary });

    res.json(kbWithFacets);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Paginated dependents for a KnowledgeBase
router.get('/:id/dependents', validateProject, async (req, res) => {
  try {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const exists = await repo.findOne({ where: { id, projectId } });
    if (!exists) return res.status(404).json({ error: 'KnowledgeBase not found' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('knowledge_base', projectId, id, { limit, cursor, kind });
    res.json(page);
  } catch (err: any) {
    sendErrorResponse(res, err);
  }
});

// Update KnowledgeBase
router.put('/:id', validateProject, updateKnowledgeBaseValidator, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await repo.findOne({ where: { id, projectId } });
    if (!kb) return res.status(404).json({ error: 'KnowledgeBase not found' });
    const { projectId: _ignoredProjectId, id: _ignoredId, ...rawUpdateBody } = req.body ?? {};
    const workflowUpdate = extractKnowledgeBaseWorkflowUpdate(rawUpdateBody);
    if (workflowUpdate) {
      if (req.user?.email) {
        return res.status(403).json({
          error: 'Workflow-managed fields cannot be set via the public API',
          code: 'WORKFLOW_FIELDS_FORBIDDEN',
        });
      }
      await repo.update({ id, projectId }, workflowUpdate);
      const updated = await repo.findOne({ where: { id, projectId } });
      if (!updated) return res.status(404).json({ error: 'KnowledgeBase not found' });
      await applyForEntity(undefined, 'knowledge_base', projectId, updated);
      return res.json(updated);
    }

    const { metadataUpdate, processingOverrides } = splitKnowledgeBaseUpdateBody(rawUpdateBody);
    const shouldReprocess = knowledgeBaseProcessingOverridesChanged(kb, processingOverrides);

    if (shouldReprocess && kb.status === 'in_progress') {
      return res.status(409).json({
        error: KB_IN_PROGRESS_REPROCESS_MESSAGE,
        code: 'KB_IN_PROGRESS',
      });
    }

    if (metadataUpdate.name != null && typeof metadataUpdate.name === 'string') {
      const nextName = metadataUpdate.name.trim();
      const nameTaken = await repo.findOne({
        where: { projectId, name: nextName, id: Not(id) },
      });
      if (nameTaken) {
        throw new ConflictError(KB_DUPLICATE_NAME_MESSAGE);
      }
      metadataUpdate.name = nextName;
    }
    const persistMetadataAndReconcile = async (): Promise<KnowledgeBase | null> => {
      try {
        if (Object.keys(metadataUpdate).length > 0) {
          await repo.update({ id, projectId }, metadataUpdate);
        }
      } catch (updErr: unknown) {
        if (isPostgresUniqueViolation(updErr)) {
          throw new ConflictError(KB_DUPLICATE_NAME_MESSAGE);
        }
        throw updErr;
      }
      const entity = await repo.findOne({ where: { id, projectId } });
      if (!entity) return null;
      await applyForEntity(undefined, 'knowledge_base', projectId, entity);

      if (metadataUpdate.synchronizationConfig !== undefined) {
        try {
          const newScheduleConfig = await KnowledgeBaseScheduleService.applySynchronizationConfig(
            projectId,
            id,
            entity.synchronizationConfig,
            entity.scheduleConfig,
          );
          if (newScheduleConfig) {
            entity.scheduleConfig = newScheduleConfig;
            await repo.save(entity);
          }
        } catch (scheduleErr: any) {
          safeConsoleWarn(
            '[knowledgeBaseRoutes] Failed to reconcile synchronizationConfig on KB',
            id,
            scheduleErr?.message ?? scheduleErr,
          );
        }
      }
      return entity;
    };

    let updated: KnowledgeBase;
    if (shouldReprocess) {
      updated = kb;
    } else {
      const persisted = await persistMetadataAndReconcile();
      if (!persisted) return res.status(404).json({ error: 'KnowledgeBase not found' });
      updated = persisted;
    }

    let workflowId: string | undefined;
    if (shouldReprocess) {
      let workflowResult;
      try {
        workflowResult = await KnowledgeBaseWorkflowService.triggerCreationWorkflow(projectId, updated, {
          overrides: processingOverrides,
          authorization: req.headers.authorization || '',
        });
      } catch (workflowErr: any) {
        const persisted = await persistMetadataAndReconcile();
        if (!persisted) return res.status(404).json({ error: 'KnowledgeBase not found' });
        logger.warn(
          `[knowledgeBaseRoutes] KB ${safeLog(id)} metadata saved but reprocessing workflow failed to start: ${safeLog(workflowErr?.message ?? workflowErr)}`,
        );
        return res.status(200).json({
          ...persisted,
          warning: 'Knowledge base updated but reprocessing workflow failed to start',
          workflowError: workflowErr?.message,
        });
      }

      if (workflowResult.ok) {
        workflowId = workflowResult.workflowId;
        const persisted = await persistMetadataAndReconcile();
        if (!persisted) return res.status(404).json({ error: 'KnowledgeBase not found' });
        updated = (await repo.findOne({ where: { id, projectId } })) ?? persisted;
      } else if (workflowResult.reason === 'already_in_progress') {
        return res.status(409).json({
          error: workflowResult.message,
          code: 'KB_IN_PROGRESS',
        });
      } else if (workflowResult.reason === 'embedding_model_not_found') {
        return res.status(400).json({
          error: workflowResult.message,
          code: 'EMBEDDING_MODEL_NOT_FOUND',
        });
      } else {
        const persisted = await persistMetadataAndReconcile();
        if (!persisted) return res.status(404).json({ error: 'KnowledgeBase not found' });
        return res.status(200).json({
          ...persisted,
          warning: workflowResult.message,
          workflowSkippedReason: workflowResult.reason,
        });
      }
    }

    if (workflowId) {
      return res.json({
        ...updated,
        workflowId,
        workflowStatus: 'running',
      });
    }
    res.json(updated);
  } catch (err: any) {
    sendErrorResponse(res, err);
  }
});

// Delete KnowledgeBase
router.delete('/:id', validateProject, async (req, res) => {
  const { projectId, id: kbId } = req.params as { projectId: string; id: string };

  try {
    const repo = AppDataSource.getRepository(KnowledgeBase);
    
    // Get KB before deleting to retrieve bucket info
    const kb = await repo.findOne({ where: { id: kbId, projectId } });
    if (!kb) {
      return res.status(404).json({ error: 'KnowledgeBase not found' });
    }

    if (await hasDependents('knowledge_base', projectId, kbId)) {
      const page = await listDependents('knowledge_base', projectId, kbId, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this knowledge base because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }

    // Terminate running KB workflows (embedding) before deletion
    try {
      const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
      await axios.post(
        `${workflowEngineURL}/api/v1/projects/${projectId}/knowledgebases/${kbId}/terminate`,
        {},
        {
          timeout: 10000,
          headers: { 'Authorization': req.headers.authorization || '' },
        }
      );
    } catch (terminateErr: any) {
      logger.warn(`Failed to terminate workflows for KB ${kbId}: ${terminateErr.message}`);
    }

    // Tear down any KB sync Temporal schedule before removing the row.
    await KnowledgeBaseScheduleService.tearDownSchedule(projectId, kbId, kb.scheduleConfig);

    await removeForSource(undefined, 'knowledge_base', projectId, kbId);
    await repo.delete({ id: kbId, projectId });

    // Trigger S3 cleanup workflow (async, don't wait for completion)
    try {
      const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
      const projectEntity = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
      const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
      
      // Fire and forget - S3 cleanup happens in background
      axios.delete(
        `${workflowEngineURL}/api/v1/projects/${projectId}/knowledgebases/${kbId}`,
        {
          data: { bucketName, pathPrefix },
          timeout: 10000,
          headers: {
            'Authorization': req.headers.authorization || ''
          }
        }
      ).then(response => {
        logger.info(`KB ${kbId} S3 cleanup workflow started: ${response.data.workflowId}`);
      }).catch(err => {
        // Log but don't fail - DB deletion already succeeded
        logger.warn(`Failed to start S3 cleanup workflow for KB ${kbId}:`, err.message);
      });

      res.json({ 
        message: 'KnowledgeBase deleted',
        s3CleanupStarted: true,
      });
    } catch (workflowErr: any) {
      // DB deletion succeeded, but workflow failed to start
      logger.warn('Failed to trigger S3 cleanup workflow:', workflowErr);
      res.json({ 
        message: 'KnowledgeBase deleted',
        warning: 'S3 cleanup workflow failed to start - manual cleanup may be required',
        s3CleanupStarted: false,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/knowledgebases/{id}/history:
 *   get:
 *     summary: List all history versions for a KnowledgeBase
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: KnowledgeBase ID
 *     responses:
 *       200:
 *         description: List of history versions
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       404:
 *         description: Not found
 */
router.get('/:id/history', validateProject, async (req, res) => {
  try {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await kbRepo.findOne({ where: { id, projectId } });
    if (!kb) return res.status(404).json({ error: 'KnowledgeBase not found' });
    const repo = AppDataSource.getRepository(KnowledgeBaseHistory);
    const history = await repo.find({
      where: { entityId: id },
      order: { version: 'DESC' },
    });
    if (!history || history.length === 0) return res.status(404).json({ error: 'No history found for this KnowledgeBase' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/knowledgebases/{id}/restore-version:
 *   post:
 *     summary: Restore a KnowledgeBase to a previous version
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: KnowledgeBase ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: number
 *                 description: Version number to restore
 *     responses:
 *       200:
 *         description: KnowledgeBase restored to previous version
 *       404:
 *         description: Not found
 */
router.post('/:id/restore-version', validateProject, async (req, res) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const { projectId, id } = req.params as { projectId: string; id: string };
    const historyRepo = AppDataSource.getRepository(KnowledgeBaseHistory);
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const existingKb = await kbRepo.findOne({ where: { id, projectId } });
    if (!existingKb) return res.status(404).json({ error: 'KnowledgeBase not found' });
    const history = await historyRepo.findOne({
      where: { entityId: id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });
    
    const { data } = history;
    const { id: _historyId, createdAt, updatedAt, ...restoreData } = data;
    
    const { projectId: _ignoredProjectId, id: _ignoredId, ...safeRestoreData } = restoreData as Record<string, any>;
    await kbRepo.update({ id, projectId }, safeRestoreData);
    const updated = await kbRepo.findOne({ where: { id, projectId } });
    if (!updated) return res.status(404).json({ error: 'KnowledgeBase not found' });
    await applyForEntity(undefined, 'knowledge_base', projectId, updated);
    res.json({ restored: true, data: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/knowledgebases/{id}/create:
 *   post:
 *     summary: Trigger knowledge base creation/reprocessing workflow
 *     description: |
 *       Triggers the KB processing workflow. Can optionally update embedding model
 *       and chunking settings before processing. Always uses full processing mode.
 *     tags: [KnowledgeBases]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Knowledge Base ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               embeddingModel:
 *                 type: string
 *                 description: Optionally change the embedding model
 *               chunkSize:
 *                 type: integer
 *                 description: Optionally change the chunk size
 *               chunkStrategy:
 *                 type: string
 *                 enum: [fixed, sentence, recursive, token, markdown]
 *               chunkOverlap:
 *                 type: integer
 *               chunkOptions:
 *                 type: object
 *               vectorSize:
 *                 type: integer
 *     responses:
 *       202:
 *         description: KB creation workflow started
 *       404:
 *         description: Not found
 */
router.post('/:id/create', async (req, res) => {
  const { projectId, id: kbId } = req.params as { projectId: string; id: string };

  try {
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const datasetRepo = AppDataSource.getRepository(DataSet);

    // Get KB
    let kb = await kbRepo.findOne({ where: { id: kbId, projectId } });
    if (!kb) {
      return res.status(404).json({ error: 'Knowledge base not found' });
    }

    // NOTE: Config fields (embeddingModel, chunkSize, quantizationType, etc.) are NOT
    // updated here. They are deferred until the workflow completes successfully. This
    // ensures that if reprocessing fails, the KB retains its original config that matches
    // the live index. The new settings are passed via the workflow input and applied
    // atomically on success by the workflow's UpdateKBStatusWithStatsActivity.

    // Get source dataset
    const dataset = await datasetRepo.findOne({ where: { id: kb.sourceDataset, projectId } });
    if (!dataset) {
      return res.status(404).json({ error: 'Source dataset not found' });
    }

    // Validate dataset is ready
    if (dataset.status !== 'ready') {
      return res.status(400).json({ error: `Source dataset must be in 'ready' status, current status: ${dataset.status}` });
    }

    // Derive bucket and pathPrefix from project home_dir
    const projectEntity = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
    const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);

    // Set namespace to projectId for isolation
    const namespace = projectId;

    // Forward the per-project Bifrost virtual-key token + resolved embedding
    // identity into the workflow (same as the create path). Without the token
    // the kb-processor activity fails with "api_key is required"; without
    // embeddingGatewayModelId a remote model 403s (model_blocked). Non-fatal:
    // an existing KB always has embeddingModel, but if it can't be resolved we
    // still forward the token so reprocessing isn't blocked.
    let projectVirtualKeyToken = '';
    try {
      projectVirtualKeyToken = (await readProjectVirtualKeyToken(projectId)) || '';
    } catch (vkErr: any) {
      logger.warn(
        `[knowledgeBaseRoutes] readProjectVirtualKeyToken failed for project ${safeLog(projectId)}: ${safeLog(vkErr?.message || vkErr)}`,
      );
    }
    if (!projectVirtualKeyToken) {
      logger.warn(
        `[knowledgeBaseRoutes] No Bifrost virtual-key token for project ${safeLog(projectId)} — kb-processor will fail with 'api_key is required'. Check that the as-proj-${safeLog(projectId)}-vk K8s Secret exists and that gateway-setup has run.`,
      );
    }
    // Only accept a non-empty string embeddingModel override; otherwise fall back to the
    // persisted KB value (mirrors the create handler) so a non-string body value
    // can't reach the TypeORM name lookup and turn a bad request into a 500.
    const embeddingModelName = resolveEmbeddingModelName(req.body?.embeddingModel, kb.embeddingModel);
    const embeddingFields = await resolveEmbeddingFields(projectId, req.body || {}, embeddingModelName);

    // Prepare workflow input - always use full processing mode.
    // Overlay any req.body overrides on top of current KB values so the processor
    // uses the NEW settings while the DB retains the OLD settings until success.
    const processingMode = 'full';
    const chunkStrategy = req.body.chunkStrategy ?? kb.chunkStrategy ?? 'fixed';
    const defaultChunkOverlap =
      chunkStrategy === 'sentence' || chunkStrategy === 'token' ? 0 : 50;
    const workflowInput: Record<string, any> = {
      projectId,
      knowledgeBaseId: kbId,
      kbName: kb.name,
      sourceDatasetId: kb.sourceDataset,
      bucketName,
      pathPrefix,
      embeddingModel: embeddingFields?.embeddingModel ?? embeddingModelName,
      chunkSize: req.body.chunkSize ?? kb.chunkSize,
      // Prefer the resolved model's dimensions so switching embedding models
      // can't index at the old (wrong) vector size; fall back to an explicit
      // override, then the persisted KB value.
      vectorSize: embeddingFields?.embeddingDimensions ?? req.body.vectorSize ?? kb.vectorSize,
      dataType: req.body.dataType ?? kb.dataType ?? '',
      namespace,
      processingMode,
      // Chunking strategy support (overlay req.body overrides)
      chunkStrategy,
      chunkOverlap: req.body.chunkOverlap ?? kb.chunkOverlap ?? defaultChunkOverlap,
      chunkOptions: req.body.chunkOptions
        ? JSON.stringify(req.body.chunkOptions)
        : kb.chunkOptions ? JSON.stringify(kb.chunkOptions) : '',
      // Indexing mode for FTS/hybrid search support
      indexingMode: req.body.indexingMode ?? kb.indexingMode ?? 'hybrid',
      // Quantization support for vector index compression
      quantizationType: req.body.quantizationType ?? kb.quantizationType ?? 'auto',
      quantizationOptions: req.body.quantizationOptions
        ? JSON.stringify(req.body.quantizationOptions)
        : kb.quantizationOptions ? JSON.stringify(kb.quantizationOptions) : '',
        // Structured dataset support
        datasetKind: dataset.kind || 'unstructured',
      catalogTableRef: dataset.catalogTableRef || '',
      textColumns: kb.textColumns || '',
      warehouseId: dataset.warehouseName || 'nemo',
      // Gateway auth + embedding identity — fixes "api_key is required" on reprocess.
      projectVirtualKeyToken,
      llmGatewayUrl: process.env.LLM_GATEWAY_URL || '',
      ...(embeddingFields
        ? {
            embeddingModelId: embeddingFields.embeddingModelId,
            embeddingProvider: embeddingFields.embeddingProvider,
            embeddingProviderModelId: embeddingFields.embeddingProviderModelId,
            embeddingGatewayModelId: embeddingFields.embeddingGatewayModelId,
            embeddingEndpoint: embeddingFields.embeddingEndpoint,
            embeddingDimensions: embeddingFields.embeddingDimensions,
          }
        : {}),
    };

    // Call workflow engine
    const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    const response = await axios.post(
      `${workflowEngineURL}/api/v1/projects/${projectId}/knowledgebases/${kbId}/create`,
      workflowInput,
      {
        timeout: 30000,
        headers: {
          'Authorization': req.headers.authorization || ''
        }
      }
    );

    // Update KB status to in_progress, reset progress and error, and store jobId.
    // Config fields are intentionally NOT updated here -- they are deferred to
    // workflow success so the KB record always matches the live index.
    await kbRepo.update(kbId, {
      status: 'in_progress',
      jobId: response.data.workflowId,
      namespace,
      bucketName,
      progress: { phase: 'queued', percentage: 0 },
      errorMessage: null as any,
    });

    res.status(202).json({
      workflowId: response.data.workflowId,
      status: 'running',
      knowledgeBaseId: kbId,
      projectId,
    });
  } catch (err: any) {
    logger.error('Failed to start KB creation workflow:', err);
    res.status(500).json({ error: err.message || 'Failed to start KB creation workflow' });
  }
});

// ─── Sync versions (blue-green LanceDB prefixes) ───────────────────────────
// These are thin proxies to the workflow-engine, which is the only service
// that has direct access to the underlying POSIX/S3 storage where each
// successful sync writes a `lancedb-run-{workflowRunId}/` (or legacy
// `lancedb-{YYYYMMDD-HHMMSS}/`) prefix and the active pointer in
// `metadata.json`.

router.get('/:id/versions', validateProject, async (req, res) => {
  const { projectId, id: kbId } = req.params as { projectId: string; id: string };
  try {
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await repo.findOne({ where: { id: kbId, projectId } });
    if (!kb) return res.status(404).json({ error: 'KnowledgeBase not found' });

    const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    const resp = await axios.get(
      `${workflowEngineURL}/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kbId)}/versions`,
      {
        timeout: 15000,
        headers: { Authorization: req.headers.authorization || '' },
      },
    );
    res.json(resp.data);
  } catch (err: any) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    res.status(502).json({ error: `Failed to list KB versions: ${err.message}` });
  }
});

router.post('/:id/versions/:versionId/rollback', validateProject, async (req, res) => {
  const { projectId, id: kbId, versionId } = req.params as {
    projectId: string;
    id: string;
    versionId: string;
  };
  try {
    const repo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await repo.findOne({ where: { id: kbId, projectId } });
    if (!kb) return res.status(404).json({ error: 'KnowledgeBase not found' });

    if (kb.status === 'in_progress') {
      return res.status(409).json({
        error: 'Cannot roll back while KB is being processed; wait for the current sync to finish.',
      });
    }

    const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
    const resp = await axios.post(
      `${workflowEngineURL}/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kbId)}/versions/${safeSegment(versionId)}/rollback`,
      {},
      {
        timeout: 15000,
        headers: { Authorization: req.headers.authorization || '' },
      },
    );

    // Best-effort: mirror the active path on the DB row so the GUI reflects
    // the rollback. Retrieval has already honored the new metadata.json path.
    const rolledBackTo = resp.data?.rolledBackTo;
    if (rolledBackTo?.lanceTablePath) {
      try {
        await repo.update({ id: kbId, projectId }, { lanceTablePath: rolledBackTo.lanceTablePath });
      } catch (dbErr: any) {
        console.warn(
          `[knowledgeBaseRoutes] Rollback succeeded on workflow-engine but DB update failed for KB ${safeLog(kbId)}: ${safeLog(dbErr.message)}`,
        );
      }
    }

    res.json(resp.data);
  } catch (err: any) {
    if (err.response) {
      return res.status(err.response.status).json(err.response.data);
    }
    res.status(502).json({ error: `Failed to roll back KB: ${err.message}` });
  }
});

// ─── Facet routes ────────────────────────────────────────────────────────────
const KB_ENTITY_TYPE: FacetEntityType = 'knowledge_base';

// List all facets for a KB
router.get('/:id/facets', async (req, res) => {
  const { projectId, id: kbId } = req.params as { projectId: string; id: string };
  try {
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const kb = await kbRepo.findOne({ where: { id: kbId, projectId } });
    if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

    const facets = await FacetService.listFacets(projectId, KB_ENTITY_TYPE, kbId);
    res.json({ facets });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get one facet
router.get('/:id/facets/:facetType', async (req, res) => {
  const { projectId, id: kbId, facetType } = req.params as unknown as { projectId: string; id: string; facetType: string };
  try {
    const facet = await FacetService.getFacet(projectId, KB_ENTITY_TYPE, kbId, facetType);
    if (!facet) return res.status(404).json({ error: `Facet '${facetType}' not found` });
    res.json(facet);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update facet state (called by workflow activities)
router.put('/:id/facets/:facetType', async (req, res) => {
  const { projectId, id: kbId, facetType } = req.params as unknown as { projectId: string; id: string; facetType: string };
  const { state, jobId, errorMessage, summary } = req.body;

  if (!state || !['in_progress', 'ready', 'errored'].includes(state)) {
    return res.status(400).json({ error: 'Invalid state. Must be one of: in_progress, ready, errored' });
  }

  try {
    const facet = await FacetService.updateFacetState(
      projectId, KB_ENTITY_TYPE, kbId, facetType, state,
      { jobId, errorMessage, summary, expectedJobId: jobId }
    );
    res.json(facet);
  } catch (err: any) {
    if (err instanceof FacetConflictError) {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

// Trigger facet population job (e.g. embedding reprocess)
router.post('/:id/facets/:facetType/run', async (req, res) => {
  const { projectId, id: kbId, facetType } = req.params as unknown as { projectId: string; id: string; facetType: string };

  try {
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);
    const datasetRepo = AppDataSource.getRepository(DataSet);

    const kb = await kbRepo.findOne({ where: { id: kbId, projectId } });
    if (!kb) return res.status(404).json({ error: 'Knowledge base not found' });

    // Mutual exclusion: reject if KB is in_progress
    if (kb.status === 'in_progress') {
      return res.status(400).json({ error: 'Knowledge base is currently being processed; wait for it to complete' });
    }

    if (kb.status !== 'ready' && kb.status !== 'errored') {
      return res.status(400).json({ error: `Knowledge base must be in 'ready' or 'errored' status, current: ${kb.status}` });
    }

    if (facetType === 'embedding') {
      // Get source dataset
      const dataset = await datasetRepo.findOne({ where: { id: kb.sourceDataset, projectId } });
      if (!dataset) return res.status(404).json({ error: 'Source dataset not found' });
      if (dataset.status !== 'ready') {
        return res.status(400).json({ error: `Source dataset must be in 'ready' status, current: ${dataset.status}` });
      }

      // Build workflow input with optional overrides from request body
      const projectEntity = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
      const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
      const namespace = projectId;

      const workflowInput: Record<string, any> = {
        projectId,
        knowledgeBaseId: kbId,
        kbName: kb.name,
        sourceDatasetId: kb.sourceDataset,
        bucketName,
        pathPrefix,
        embeddingModel: req.body.embeddingModel ?? kb.embeddingModel,
        chunkSize: req.body.chunkSize ?? kb.chunkSize,
        vectorSize: req.body.vectorSize ?? kb.vectorSize,
        dataType: kb.dataType,
        namespace,
        processingMode: 'full',
        chunkStrategy: req.body.chunkStrategy ?? kb.chunkStrategy ?? 'fixed',
        chunkOverlap: req.body.chunkOverlap ?? kb.chunkOverlap ?? 50,
        chunkOptions: req.body.chunkOptions
          ? JSON.stringify(req.body.chunkOptions)
          : kb.chunkOptions ? JSON.stringify(kb.chunkOptions) : '',
        indexingMode: req.body.indexingMode ?? kb.indexingMode ?? 'hybrid',
        quantizationType: req.body.quantizationType ?? kb.quantizationType ?? 'auto',
        quantizationOptions: req.body.quantizationOptions
          ? JSON.stringify(req.body.quantizationOptions)
          : kb.quantizationOptions ? JSON.stringify(kb.quantizationOptions) : '',
        datasetKind: dataset.kind || 'unstructured',
        catalogTableRef: dataset.catalogTableRef || '',
        textColumns: kb.textColumns || '',
        warehouseId: dataset.warehouseName || 'nemo',
      };

      const workflowEngineURL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
      const response = await axios.post(
        `${workflowEngineURL}/api/v1/projects/${projectId}/knowledgebases/${kbId}/create`,
        workflowInput,
        { timeout: 30000, headers: { 'Authorization': req.headers.authorization || '' } }
      );

      // Update KB status to in_progress
      await kbRepo.update(kbId, {
        status: 'in_progress',
        jobId: response.data.workflowId,
        namespace,
        bucketName,
        progress: { phase: 'queued', percentage: 0 },
        errorMessage: null as any,
      });

      // Upsert embedding facet to in_progress
      const { started, facet } = await FacetService.startFacetJob(
        projectId, KB_ENTITY_TYPE, kbId, 'embedding', response.data.workflowId
      );

      return res.status(202).json({
        workflowId: response.data.workflowId,
        status: started ? 'started' : 'already_running',
        facet,
        knowledgeBaseId: kbId,
        projectId,
      });
    }

    return res.status(400).json({ error: `Unknown facet type: '${facetType}'` });
  } catch (err: any) {
    logger.error('Failed to start facet job:', err);
    res.status(500).json({ error: err.message || 'Failed to start facet job' });
  }
});

export default router;
