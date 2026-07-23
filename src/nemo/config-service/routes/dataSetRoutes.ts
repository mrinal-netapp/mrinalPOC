import 'reflect-metadata';
import { Router, Request } from 'express';
import axios from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { AppDataSource } from '../db/postgres';
import { DataSet } from '../models/DataSet';
import { DataSource as DataSourceEntity } from '../models/DataSource';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { Project as ProjectEntity } from '../models/Project';
import { DataSetHistory } from '../models/history/DataSetHistory';
import { ManifestService } from '../services/ManifestService';
import { DataSetService } from '../services/DataSetService';
import { createDataSetValidator, updateDataSetValidator } from '../validators/dataSetValidator';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import { Not } from 'typeorm';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { FacetService, ConflictError } from '../services/FacetService';
import { FacetEntityType } from '../models/Facet';
import { LakekeeperCatalogService } from '../services/LakekeeperCatalogService';
import {
  hasDependents,
  summaryForTargets,
  listDependents,
  removeForSource,
} from '../services/ReferenceEdgeService';
import { ensureKbReferenceEdgesIfCold } from '../services/ReferenceEdgeReconciler';
import { nextRunFromRefreshConfig } from '../utils/nextRunFromRefreshConfig';

const router = Router({ mergeParams: true });
const WORKFLOW_ENGINE_URL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';

// Authenticated client for state-changing calls into workflow-engine (e.g. the
// acquire proxy below). Falls back to an unauthenticated axios instance when no
// service-account credentials are configured (local/dev). Mirrors the client
// setup in dataSourceRoutes.ts.
const workflowEngineServiceAccountClient: ServiceAccountClient | null = createServiceAccountClientFromEnv();
const workflowEngineClient = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(WORKFLOW_ENGINE_URL)
  : axios.create({
      baseURL: WORKFLOW_ENGINE_URL,
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });


/**
 * Fetch live progress from the workflow-engine's in-memory progress store.
 * Uses a short timeout to avoid blocking list responses when the
 * workflow-engine is slow or unreachable.
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
    // Workflow-engine unreachable or no progress yet
  }
  return null;
}

/**
 * Enrich a dataset response with live progress from the workflow-engine
 * when the dataset is in_progress and has a jobId.
 * Also enriches in-progress facets with their own progress.
 */
async function enrichDatasetWithProgress(dataset: any): Promise<void> {
  // Entity-level progress (import workflow)
  if (dataset.status === 'in_progress' && dataset.jobId) {
    const live = await fetchLiveProgress(dataset.jobId);
    if (live) {
      const extra = live.extra ?? {};
      dataset.progress = {
        phase: live.phase,
        percentage: live.percentage ?? 0,
        message: live.message,
        totalFiles: extra.totalFiles ?? dataset.progress?.totalFiles,
        processedFiles: extra.processedFiles ?? dataset.progress?.processedFiles,
        currentFile: extra.currentFile ?? dataset.progress?.currentFile,
        estimatedRemainingFormatted: extra.estimatedRemainingFormatted,
        elapsedFormatted: extra.elapsedFormatted,
        lastUpdated: new Date().toISOString(),
        totalUnits: live.totalUnits,
        units: live.units,
      };
      // Populate stats from live progress during import
      const sourceFileCount = extra.sourceFileCount ?? extra.totalFiles;
      const rowCount = extra.rowCount;
      const columnCount = extra.columnCount;
      if (sourceFileCount != null || rowCount != null || columnCount != null) {
        dataset.stats = {
          ...(dataset.stats || {}),
          ...(sourceFileCount != null && { sourceFileCount: Number(sourceFileCount) }),
          ...(rowCount != null && { rowCount: Number(rowCount) }),
          ...(columnCount != null && { columnCount: Number(columnCount) }),
        };
      }
    }
  }

  // Facet-level progress (e.g. PII reprocess running independently)
  if (dataset.facets && Array.isArray(dataset.facets)) {
    await Promise.all(
      dataset.facets.map(async (facet: any) => {
        if (facet.state === 'in_progress' && facet.jobId) {
          const live = await fetchLiveProgress(facet.jobId);
          if (live) {
            facet.progress = {
              phase: live.phase,
              percentage: live.percentage ?? 0,
              message: live.message,
            };
          }
        }
      })
    );
  }
}

// Extend Request type to include projectId parameter
interface ProjectRequest extends Request {
  params: {
    projectId: string;
    id: string;
  };
}

type DatasetSyncStatus = 'Completed' | 'Synchronizing' | 'Failed' | 'Pending' | 'Never';

/**
 * Convert an epoch-millis value to an ISO string, returning null for invalid
 * input. Guards against a single corrupt `latestSnapshot.timestampMs` throwing
 * a RangeError and breaking the entire list/detail response. Note that
 * `Number.isFinite` is not sufficient: out-of-range but finite values (e.g.
 * 1e20, beyond the ±8.64e15ms Date range) produce an Invalid Date whose
 * `toISOString()` throws — so we check `getTime()` for NaN before formatting.
 */
function epochMsToIso(ms: unknown): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Map the dataset processing status onto the UI synchronization-status enum.
 *
 * Manual (upload) datasets have no external source to sync from — the "Sync"
 * tab/actions are disabled for them in the UI (see dataset-detail-sync.tsx /
 * dataset-detail.tsx: `isManual` disables sync). Their processing status
 * ('ready' after an import, etc.) is not a synchronization outcome, so always
 * report 'Never' (rendered as "Never synced") for them regardless of status,
 * rather than reusing the acquired-dataset status→sync-status mapping (which
 * would otherwise show a manual dataset as "Completed" once its import
 * finishes, implying a sync happened).
 */
function resolveSyncStatus(status: string | undefined, type?: string): DatasetSyncStatus {
  if (type === 'manual') {
    if (status === 'in_progress') return 'Synchronizing';
    if (status === 'errored') return 'Failed';
    return 'Never';
  }
  switch (status) {
    case 'in_progress':
      return 'Synchronizing';
    case 'ready':
      return 'Completed';
    case 'errored':
      return 'Failed';
    default:
      return 'Never';
  }
}

/**
 * Attach the UI-facing derived fields onto each dataset before it is returned:
 *   - dataSourceName: resolved name of the origin data source (batched lookup)
 *   - data_source_type: 'connector' | 'volume' | null (which origin field is set)
 *   - synchronization_status / synchronization_summary: derived from status +
 *     scheduleConfig + the persisted latestSnapshot (next sync left null)
 *   - latest_snapshot: UI-shaped projection of the persisted latestSnapshot
 * files_count is read by the UI from the persisted `stats` column directly.
 */
async function enrichDatasetsForResponse(datasets: any[]): Promise<void> {
  if (datasets.length === 0) return;

  const dsrcIds = Array.from(
    new Set(
      datasets
        .flatMap((d) => [d.originConnector, d.originVolume])
        .filter((x): x is string => Boolean(x)),
    ),
  );
  // Scope the lookup to the datasets' own project(s). Dataset payloads can carry
  // arbitrary origin ids, so resolving by id alone would leak the existence/name
  // of data sources owned by other projects into the response.
  const projectIds = Array.from(
    new Set(datasets.map((d) => d.projectId).filter((x): x is string => Boolean(x))),
  );
  const nameById = new Map<string, string>();
  if (dsrcIds.length > 0 && projectIds.length > 0) {
    const sources = await AppDataSource.getRepository(DataSourceEntity)
      .createQueryBuilder('ds')
      .select(['ds.id', 'ds.name'])
      .where('ds.id IN (:...ids)', { ids: dsrcIds })
      .andWhere('ds.projectId IN (:...projectIds)', { projectIds })
      .getMany();
    for (const s of sources) nameById.set(s.id, s.name);
  }

  for (const d of datasets) {
    const dsrcId: string | undefined = d.originConnector ?? d.originVolume ?? undefined;
    d.dataSourceName = dsrcId ? (nameById.get(dsrcId) ?? '') : '';
    d.data_source_type = d.originConnector ? 'connector' : d.originVolume ? 'volume' : null;

    const syncStatus = resolveSyncStatus(d.status, d.type);
    const lastCompleted = epochMsToIso(d.latestSnapshot?.timestampMs);
    // Manual (upload) datasets have no external source and no schedule — the
    // "Sync" tab/actions are disabled for them in the UI. `latestSnapshot` still
    // gets set for them (it's just marking when the last import completed), but
    // reporting that as a synchronization outcome is misleading, so these three
    // fields are always null for manual datasets regardless of any residual
    // scheduleConfig/refreshConfig/latestSnapshot values. `latest_snapshot`
    // (the Iceberg data-version projection below) is unaffected — that field is
    // legitimately shown for manual datasets too (it's the import's revision).
    const isManual = d.type === 'manual';
    const syncNever = syncStatus === 'Never';
    d.synchronization_status = syncStatus;
    d.synchronization_summary = {
      status: syncStatus,
      // Only surface the cron when the schedule is actually enabled; a paused or
      // disabled dataset retains its last cron string on scheduleConfig.
      schedule: (isManual || syncNever) ? null : (d.scheduleConfig?.enabled ? (d.scheduleConfig.cronExpression ?? null) : null),
      last_completed_synchronization: (isManual || syncNever) ? null : lastCompleted,
      // Derived from the structured refresh_config (hourly/daily/weekly/monthly,
      // UTC only). Raw cron and non-UTC schedules stay null — an accurate
      // next-run for those needs a tz-aware cron parser.
      next_scheduled_synchronization: (isManual || syncNever) ? null : nextRunFromRefreshConfig(d.refreshConfig),
    };

    // Only emit latest_snapshot when the timestamp is a valid epoch-millis value.
    d.latest_snapshot = d.latestSnapshot && lastCompleted
      ? {
          id: String(d.latestSnapshot.snapshotId),
          version: d.latestSnapshot.version,
          date: lastCompleted,
          total_files: d.latestSnapshot.totalFiles ?? 0,
          files_added: d.latestSnapshot.filesAdded ?? 0,
          files_removed: d.latestSnapshot.filesRemoved ?? 0,
        }
      : null;
  }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     DataSet:
 *       type: object
 *       required: [name, description, type, kind]
 *       properties:
 *         name:
 *           type: string
 *         description:
 *           type: string
 *         type:
 *           type: string
 *           enum: [acquired, manual]
 *         originConnector:
 *           type: string
 *         kind:
 *           type: string
 *           enum: [unstructured, structured]
 *         uploadedFiles:
 *           type: array
 *           items:
 *             type: string
 *           description: Array of file keys (for backward compatibility, files are stored in separate table)
 *         filterSpec:
 *           type: object
 *         fileProcessors:
 *           type: array
 *           items:
 *             type: string
 *         sqlQuery:
 *           type: string
 * tags:
 *   name: DataSets
 *   description: API endpoints for managing DataSets
 * /api/datasets:
 *   get:
 *     summary: List datasets
 *     tags: [DataSets]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: skip
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: field
 *         schema: { type: string }
 *       - in: query
 *         name: value
 *         schema: { type: string }
 *       - in: query
 *         name: nameRegex
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: List of datasets
 *   post:
 *     summary: Create a dataset
 *     tags: [DataSets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DataSet'
 *     responses:
 *       '201':
 *         description: Created
 * /api/datasets/{id}:
 *   get:
 *     summary: Get dataset by ID
 *     tags: [DataSets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       '200':
 *         description: Dataset
 *       '404':
 *         description: Not found
 *   put:
 *     summary: Update dataset by ID
 *     tags: [DataSets]
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
 *             $ref: '#/components/schemas/DataSet'
 *     responses:
 *       '200':
 *         description: Updated
 *       '404':
 *         description: Not found
 *   delete:
 *     summary: Delete dataset by ID
 *     tags: [DataSets]
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

router.post('/', createDataSetValidator, asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const dataset = await DataSetService.createDataSet(
    projectId,
    req.body,
    (req.user?.sub as string | undefined) || undefined,
  );
  sendSuccess(res, dataset, 201);
}));

// List with pagination and filtering
router.get('/', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

    const { limit = 20, skip = 0, field, value, nameRegex, includeCatalog, includeManifest } = req.query;
    // Support both includeManifest (legacy) and includeCatalog for backward compatibility
    const includeCatalogMetadata = includeCatalog === 'true' || includeManifest === 'true';
  
    const datasets = await DataSetService.listDataSets({
      projectId,
      limit: Number(limit),
      skip: Number(skip),
      field: field as string | undefined,
      value: value as string | undefined,
      nameRegex: nameRegex as string | undefined,
      includeCatalog: includeCatalogMetadata,
    });

  // Enrich only in-progress datasets/facets with live progress (skip ready/errored)
  const needsEnrichment = datasets.filter(
    ds => ds.status === 'in_progress' || (ds as any).facets?.some((f: any) => f.state === 'in_progress')
  );
  if (needsEnrichment.length > 0) {
    await Promise.all(needsEnrichment.map(ds => enrichDatasetWithProgress(ds)));
  }

  // Attach derived UI fields (data source name/type, sync status/summary, latest_snapshot)
  await enrichDatasetsForResponse(datasets);

  const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
  if (!includeSummary || datasets.length === 0) {
    return sendSuccess(res, datasets);
  }
  await ensureKbReferenceEdgesIfCold(projectId);
  const summary = await summaryForTargets('dataset', projectId, datasets.map((d) => d.id));
  const enriched = datasets.map((d) => Object.assign({}, d, {
    dependentsSummary: summary.get(d.id) ?? { total: 0, byKind: {} },
  }));
  sendSuccess(res, enriched);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const dataset = await DataSetService.getDataSet(req.params.id, true);
  
  // Verify project matches
  if (dataset.projectId !== projectId) {
    return sendError(res, new Error('DataSet not found in this project'), 404);
  }

  // Enrich with live progress if in_progress
  await enrichDatasetWithProgress(dataset);
  // Attach derived UI fields (data source name/type, sync status/summary, latest_snapshot)
  await enrichDatasetsForResponse([dataset]);

  sendSuccess(res, dataset);
}));

router.put('/:id', updateDataSetValidator, asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  if (!projectId) {
    return sendError(res, new Error('projectId is required'), 400);
  }

  const dataset = await DataSetService.updateDataSet(
    req.params.id,
    projectId,
    req.body,
    (req.user?.sub as string | undefined) || undefined,
  );
  sendSuccess(res, dataset);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;

  if (await hasDependents('dataset', projectId, req.params.id)) {
    const page = await listDependents('dataset', projectId, req.params.id, { limit: 50 });
    return res.status(409).json({
      error:
        'Cannot delete this dataset because it is still in use. Update or remove those references, then try again.',
      code: 'HAS_DEPENDENTS',
      dependents: page,
    });
  }

  const result = await DataSetService.deleteDataSet(req.params.id, projectId);
  await removeForSource(undefined, 'dataset', projectId, req.params.id);
  sendSuccess(res, {
    deleted: true,
    workflowId: result.workflowId,
    message: result.workflowId
      ? 'Dataset deleted. S3 and catalog cleanup in progress.'
      : 'Dataset deleted.',
  });
}));

router.get('/:id/dependents', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const dataset = await DataSetService.getDataSet(req.params.id, false).catch(() => null);
  if (!dataset || dataset.projectId !== projectId) {
    return sendError(res, new Error('DataSet not found in this project'), 404);
  }

  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const cursor = (req.query.cursor as string | undefined) || undefined;
  const kind = (req.query.kind as string | undefined) || undefined;
  const page = await listDependents('dataset', projectId, req.params.id, { limit, cursor, kind });
  sendSuccess(res, page);
}));

// List knowledge bases that consume this dataset (reverse lookup).
// KnowledgeBase.sourceDataset historically stores a dataset id OR name, so we
// match on both (mirrors resolveKbDatasetTargetIds in ReferenceEdgeService).
// Returns the raw KB rows under `knowledge_bases`; the UI's normalizeKBListItem
// tolerates the entity shape (id, status, stats.fileCount, scheduleConfig, labels, createdAt).
router.get('/:id/knowledge-bases', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const dataset = await DataSetService.getDataSet(req.params.id, false).catch(() => null);
  if (!dataset || dataset.projectId !== projectId) {
    return sendError(res, new Error('DataSet not found in this project'), 404);
  }

  const knowledgeBases = await AppDataSource.getRepository(KnowledgeBase)
    .createQueryBuilder('kb')
    .where('kb.projectId = :projectId', { projectId })
    .andWhere('(kb.sourceDataset = :id OR kb.sourceDataset = :name)', {
      id: dataset.id,
      name: dataset.name,
    })
    .orderBy('kb.createdAt', 'DESC')
    .getMany();

  sendSuccess(res, { dataset_id: dataset.id, knowledge_bases: knowledgeBases });
}));

// ─── Snapshot routes ─────────────────────────────────────────────────────────
// Iceberg-snapshot management for a dataset's catalog table. KB readers
// resolve the current snapshot at read time via PyIceberg, so expiring the
// latest snapshot and letting its parent become current implicitly reroutes
// downstream consumers to the previous data — no KB code changes required.

const snapshotCatalogService = new LakekeeperCatalogService();

/**
 * Resolve the dataset + catalog (namespace / tableName) for a snapshot route.
 * Enforces project ownership, presence of a registered catalog table, and
 * a non-importing state (we don't allow snapshot mutations while an import
 * is in flight to avoid racing with the importer's commits).
 */
async function loadDatasetForSnapshotRoute(
  projectId: string,
  id: string,
  res: any,
): Promise<{ dataset: DataSet; namespace: string[]; tableName: string; warehouseName: string | undefined } | null> {
  const dataset = await DataSetService.getDataSet(id, false).catch(() => null);
  if (!dataset || dataset.projectId !== projectId) {
    sendError(res, new Error('DataSet not found in this project'), 404);
    return null;
  }
  if (!dataset.namespace || !dataset.catalogTableName) {
    sendError(
      res,
      new Error('Dataset has no registered catalog table yet; snapshots are only available after import completes'),
      409,
    );
    return null;
  }
  if (dataset.status === 'in_progress') {
    sendError(
      res,
      new Error('Dataset is currently being imported; snapshot operations are blocked until it reaches ready/errored'),
      409,
    );
    return null;
  }
  return {
    dataset,
    namespace: dataset.namespace.split('.'),
    tableName: dataset.catalogTableName,
    warehouseName: dataset.warehouseName as string | undefined,
  };
}

// List all snapshots + current pointer for the dataset's catalog table.
router.get('/:id/snapshots', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const ctx = await loadDatasetForSnapshotRoute(projectId, req.params.id, res);
  if (!ctx) return;
  const { namespace, tableName, warehouseName } = ctx;

  const [snapshots, currentSnapshotId] = await Promise.all([
    snapshotCatalogService.getTableSnapshots(namespace, tableName, warehouseName),
    snapshotCatalogService.getCurrentSnapshotId(namespace, tableName, warehouseName),
  ]);

  const items = snapshots.map((s) => ({
    snapshotId: Number(s['snapshot-id']),
    parentSnapshotId:
      typeof s['parent-snapshot-id'] === 'number' ? Number(s['parent-snapshot-id']) : null,
    timestampMs: Number(s['timestamp-ms']),
    summary: s['summary'] ?? null,
    operation: s['summary']?.['operation'] ?? null,
    manifestList: s['manifest-list'] ?? null,
  }));

  sendSuccess(res, { currentSnapshotId, snapshots: items });
}));

// Expire a single snapshot. When the target is the current snapshot we first
// roll `main` back to its parent (or, if no parent, to the most recent other
// snapshot) before issuing remove-snapshots, so the table never points at a
// missing id. Returns the new current snapshot id when it changed.
router.post('/:id/snapshots/:snapshotId/expire', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const ctx = await loadDatasetForSnapshotRoute(projectId, req.params.id, res);
  if (!ctx) return;
  const { namespace, tableName } = ctx;

  const snapshotId = Number(req.params.snapshotId);
  if (!Number.isFinite(snapshotId)) {
    return sendError(res, new Error('snapshotId must be a number'), 400);
  }

  try {
    const { newCurrentSnapshotId } = await snapshotCatalogService.expireSnapshot(
      namespace,
      tableName,
      snapshotId,
    );
    sendSuccess(res, {
      expired: snapshotId,
      newCurrentSnapshotId,
    });
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('not found')) return sendError(res, err, 404);
    if (msg.includes('only snapshot') || msg.includes('no parent or sibling')) {
      return sendError(res, err, 409);
    }
    throw err;
  }
}));

// Explicit "rollback to" / "set current" endpoint for manual recovery. The
// expire endpoint is the user-facing happy path; this is for operators who
// need to move `main` without dropping the previous head from history.
router.post('/:id/snapshots/:snapshotId/set-current', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const ctx = await loadDatasetForSnapshotRoute(projectId, req.params.id, res);
  if (!ctx) return;
  const { namespace, tableName, warehouseName } = ctx;

  const snapshotId = Number(req.params.snapshotId);
  if (!Number.isFinite(snapshotId)) {
    return sendError(res, new Error('snapshotId must be a number'), 400);
  }

  const snapshots = await snapshotCatalogService.getTableSnapshots(namespace, tableName, warehouseName);
  if (!snapshots.some((s) => Number(s['snapshot-id']) === snapshotId)) {
    return sendError(res, new Error(`Snapshot ${snapshotId} not found`), 404);
  }
  const previousCurrent = await snapshotCatalogService.getCurrentSnapshotId(namespace, tableName, warehouseName);
  await snapshotCatalogService.setCurrentSnapshot(namespace, tableName, snapshotId, previousCurrent);
  sendSuccess(res, { currentSnapshotId: snapshotId, previousSnapshotId: previousCurrent });
}));

// List all history versions for a DataSet
/**
 * @swagger
 * /api/datasets/{id}/history:
 *   get:
 *     summary: List all history versions for a DataSet
 *     tags: [DataSets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: DataSet ID
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
router.get('/:id/history', async (req, res) => {
  try {
    const repo = AppDataSource.getRepository(DataSetHistory);
    const history = await repo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    if (!history || history.length === 0) return res.status(404).json({ error: 'No history found for this DataSet' });
    res.json(history);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /api/datasets/{id}/restore-version:
 *   post:
 *     summary: Restore a DataSet to a previous version
 *     tags: [DataSets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: DataSet ID
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
 *         description: DataSet restored to previous version
 *       404:
 *         description: Not found
 */
router.post('/:id/restore-version', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return sendError(res, new Error('version (number) is required in body'), 400);
  }

  const dataset = await DataSetService.restoreDataSetVersion(req.params.id, projectId, version);
  sendSuccess(res, { restored: true, data: dataset });
}));


// Patch dataset fields (used by workflow to update acquisitionConfig watermark)
router.patch('/:id', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id } = req.params as { id: string };
  const repo = AppDataSource.getRepository(DataSet);
  const dataset = await repo.findOne({ where: { id, projectId } });
  if (!dataset) {
    return sendError(res, new Error('DataSet not found'), 404);
  }

  // Merge acquisitionConfig (only update provided sub-fields, keep existing)
  if (req.body.acquisitionConfig && dataset.acquisitionConfig) {
    dataset.acquisitionConfig = { ...dataset.acquisitionConfig, ...req.body.acquisitionConfig };
  } else if (req.body.acquisitionConfig) {
    dataset.acquisitionConfig = req.body.acquisitionConfig;
  }

  if (req.body.scheduleConfig && dataset.scheduleConfig) {
    dataset.scheduleConfig = { ...dataset.scheduleConfig, ...req.body.scheduleConfig };
  } else if (req.body.scheduleConfig) {
    dataset.scheduleConfig = req.body.scheduleConfig;
  }

  await repo.save(dataset);
  return sendSuccess(res, dataset, 200);
}));


// Update dataset status (used by workflow/job-kb-update processor)
router.put('/:id/status', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id } = req.params as { id: string };
  const { status, errorMessage } = req.body;

  if (!status || !['in_progress', 'ready', 'errored'].includes(status)) {
    return sendError(res, new Error('Invalid status. Must be one of: in_progress, ready, errored'), 400);
  }

  const dataset = await DataSetService.updateDatasetStatus(projectId, id, status, errorMessage);
  return sendSuccess(res, dataset, 200);
}));


/**
 * @swagger
 * /api/v1/projects/{projectId}/datasets/{id}/import:
 *   post:
 *     summary: Trigger dataset import workflow
 *     tags: [DataSets]
 *     description: |
 *       Triggers the dataset import workflow which:
 *       - For structured data: converts files to Parquet, infers schema, registers with Lakekeeper catalog
 *       - For unstructured data: creates metadata table with file info, registers with Lakekeeper catalog
 *       
 *       Call this endpoint after uploading files to the dataset's data_files/ directory.
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Dataset ID
 *     responses:
 *       '202':
 *         description: Import workflow started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workflowId:
 *                   type: string
 *                 status:
 *                   type: string
 *                 datasetId:
 *                   type: string
 *       '404':
 *         description: Dataset not found
 */
router.post('/:id/import', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id } = req.params as { id: string };

  // Get dataset to validate it exists and get details
  const dataset = await DataSetService.getDataSet(id, false);
  if (!dataset) {
    return sendError(res, new Error('Dataset not found'), 404);
  }

  if (dataset.projectId !== projectId) {
    return sendError(res, new Error('Dataset not found in this project'), 404);
  }

  // Mutual exclusion: reject import if PII facet is in_progress
  const piiFacet = await FacetService.getFacet(projectId, ENTITY_TYPE, id, 'pii');
  if (piiFacet && piiFacet.state === 'in_progress') {
    return sendError(res, new Error('PII analysis is in progress; wait for it to complete before re-importing'), 400);
  }

  // Import DatasetImportService dynamically to avoid circular dependencies
  const { DatasetImportService } = await import('../services/DatasetImportService');
  const importService = new DatasetImportService();

  // Resolve bucket and pathPrefix from project home_dir
  const projectEntity = await AppDataSource.getRepository(ProjectEntity).findOne({ where: { id: projectId } });
  const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
  // Pass warehouse NAME (not UUID) — the Lakekeeper REST catalog /config endpoint
  // expects the warehouse name; PyIceberg resolves the UUID prefix automatically.
  const warehouseName = dataset.warehouseName || 'nemo';

  const { ManifestService } = await import('../services/ManifestService');
  await ManifestService.prepareDatasetReimport(dataset, bucketName, pathPrefix);

  // Trigger the import workflow
  const workflowId = await importService.startDatasetImport(
    projectId,
    id,
    dataset.name,
    dataset.kind,
    bucketName,
    dataset.namespace || projectId,
    warehouseName,
    pathPrefix,
    dataset.enablePiiAnalysis ?? false,
    dataset.piiAnalysisImageOnly ?? false,
    undefined,
    dataset.type,
  );

  if (workflowId) {
    // Update dataset with workflow ID
    await DataSetService.updateDatasetJobId(projectId, id, workflowId);
    
    return sendSuccess(res, {
      workflowId,
      status: 'running',
      datasetId: id,
      message: 'Import workflow started successfully',
    }, 202);
  } else {
    return sendError(res, new Error('Failed to start import workflow'), 500);
  }
}));

/**
 * @swagger
 * /api/v1/projects/{projectId}/datasets/{id}/acquire:
 *   post:
 *     summary: Trigger an on-demand dataset acquisition (snapshot) workflow
 *     tags: [DataSets]
 *     description: |
 *       Triggers a one-shot data acquisition Temporal workflow, creating a new
 *       snapshot. The acquire workflow is owned by the workflow-engine; this
 *       route proxies to it so the UI can use the shared config-service base URL
 *       (mirrors POST /:id/import).
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Dataset ID
 *     responses:
 *       '202':
 *         description: Acquisition workflow started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 workflowId: { type: string }
 *                 status: { type: string }
 *                 datasetId: { type: string }
 *       '404':
 *         description: Dataset not found in this project
 */
router.post('/:id/acquire', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id } = req.params as { id: string };

  // Validate the dataset exists and belongs to the project before dispatching.
  const dataset = await DataSetService.getDataSet(id, false);
  if (!dataset || dataset.projectId !== projectId) {
    return sendError(res, new Error('Dataset not found in this project'), 404);
  }

  try {
    const { data } = await workflowEngineClient.post(
      `/api/v1/projects/${projectId}/datasets/${id}/acquire`,
      {},
    );
    // Forward the workflow-engine response verbatim ({ workflowId, status, datasetId }).
    return sendSuccess(res, data, 202);
  } catch (err: any) {
    const status = err?.response?.status ?? 502;
    const message =
      err?.response?.data?.error || err?.message || 'Failed to start acquisition workflow';
    return sendError(res, new Error(message), status);
  }
}));

// ─── Facet routes ────────────────────────────────────────────────────────────
const ENTITY_TYPE: FacetEntityType = 'dataset';

// List all facets for a dataset
router.get('/:id/facets', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id } = req.params as { id: string };

  const dataset = await DataSetService.getDataSet(id, false);
  if (!dataset || dataset.projectId !== projectId) {
    return sendError(res, new Error('Dataset not found in this project'), 404);
  }

  const facets = await FacetService.listFacets(projectId, ENTITY_TYPE, id);
  return sendSuccess(res, { facets });
}));

// Get one facet
router.get('/:id/facets/:facetType', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id, facetType } = req.params as { id: string; facetType: string };

  const facet = await FacetService.getFacet(projectId, ENTITY_TYPE, id, facetType);
  if (!facet) {
    return sendError(res, new Error(`Facet '${facetType}' not found for this dataset`), 404);
  }
  return sendSuccess(res, facet);
}));

// Update facet state (called by processor/workflow)
router.put('/:id/facets/:facetType', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id, facetType } = req.params as { id: string; facetType: string };
  const { state, jobId, errorMessage, summary } = req.body;

  if (!state || !['in_progress', 'ready', 'errored'].includes(state)) {
    return sendError(res, new Error('Invalid state. Must be one of: in_progress, ready, errored'), 400);
  }

  try {
    const facet = await FacetService.updateFacetState(
      projectId, ENTITY_TYPE, id, facetType, state,
      { jobId, errorMessage, summary, expectedJobId: jobId }
    );
    return sendSuccess(res, facet);
  } catch (err: any) {
    if (err instanceof ConflictError) {
      return sendError(res, err, 409);
    }
    throw err;
  }
}));

// Trigger facet population job
router.post('/:id/facets/:facetType/run', asyncHandler(async (req, res) => {
  const projectId = (req as ProjectRequest).params.projectId;
  const { id, facetType } = req.params as { id: string; facetType: string };

  // Validate dataset exists
  const dataset = await DataSetService.getDataSet(id, false);
  if (!dataset || dataset.projectId !== projectId) {
    return sendError(res, new Error('Dataset not found in this project'), 404);
  }

  // Mutual exclusion: reject if entity is in_progress (import running)
  if (dataset.status === 'in_progress') {
    return sendError(res, new Error('Dataset is currently being imported; wait for import to complete'), 400);
  }

  // Must be in ready or errored state
  if (dataset.status !== 'ready' && dataset.status !== 'errored') {
    return sendError(res, new Error('Dataset must be in "ready" or "errored" status to run facet jobs'), 400);
  }

  // Route to the appropriate facet job handler
  if (facetType === 'pii') {
    return await handlePiiFacetRun(req, res, projectId, id, dataset);
  }

  return sendError(res, new Error(`Unknown facet type: '${facetType}'`), 400);
}));

/**
 * Handle PII facet run: triggers the import workflow with reprocessPiiOnly=true.
 * Entity status is NOT changed; only the facet transitions to in_progress.
 */
async function handlePiiFacetRun(req: any, res: any, projectId: string, datasetId: string, dataset: any) {
  const { DatasetImportService } = await import('../services/DatasetImportService');
  const importService = new DatasetImportService();

  const projectEntity = await AppDataSource.getRepository(ProjectEntity).findOne({ where: { id: projectId } });
  const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity!);
  const warehouseName = dataset.warehouseName || 'nemo';

  const workflowId = await importService.startDatasetImport(
    projectId,
    datasetId,
    dataset.name,
    dataset.kind,
    bucketName,
    dataset.namespace || projectId,
    warehouseName,
    pathPrefix,
    true, // enablePiiAnalysis
    dataset.piiAnalysisImageOnly ?? false,
    true, // reprocessPiiOnly
    dataset.type,
  );

  if (!workflowId) {
    return sendError(res, new Error('Failed to start PII reprocessing workflow'), 500);
  }

  // Enable PII analysis flag on the dataset (user preference)
  const repo = AppDataSource.getRepository(DataSet);
  dataset.enablePiiAnalysis = true;
  await repo.save(dataset);

  // Upsert facet to in_progress with jobId (Layer 1 guard)
  const { started, facet } = await FacetService.startFacetJob(
    projectId, ENTITY_TYPE, datasetId, 'pii', workflowId
  );

  return sendSuccess(res, {
    workflowId,
    status: started ? 'started' : 'already_running',
    facet,
    datasetId,
  }, 202);
}

export default router;
