import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { AppDataSource } from '../db/postgres';
import { DataSource as DataSourceEntity } from '../models/DataSource';
import { DataSet } from '../models/DataSet';
import { DataSourceHistory } from '../models/history/DataSourceHistory';
import {
  createDataSourceValidator,
  updateDataSourceValidator,
  listDataSourceQueryValidator,
  scanDataSourceValidator,
  listAssociatedDataSetsQueryValidator,
} from '../validators/dataSourceValidator';
import { validateProject } from '../middleware/projectValidator';
import { validationResult } from 'express-validator';
import { Not } from 'typeorm';
import { validateBucketName } from '../utils/bucketNameValidation';
import { validateVolumeConfigUpdate } from '../utils/volumeConfigValidation';
import { DataSourceRepository } from '../repositories/DataSourceRepository';
import { DataSourceModel, DataSourceMountHealth, ErrorResponse, ScanConfig } from '../types/dataSource';
import { safeLog } from '../utils/safeStrings';
import {
  applyForEntity,
  removeForSource,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';

const router = Router({ mergeParams: true });

const workflowEngineUrl = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';
const workflowEngineServiceAccountClient: ServiceAccountClient | null = createServiceAccountClientFromEnv();
const workflowEngineClient = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(workflowEngineUrl)
  : axios.create({
      baseURL: workflowEngineUrl,
      timeout: 120000,
      headers: { 'Content-Type': 'application/json' },
    });

async function workflowExplorerList(
  projectId: string,
  connectorId: string,
  action: string,
  payload: Record<string, unknown>,
  refresh = true
): Promise<{ nodes?: any[]; error?: { code?: string; message?: string } }> {
  const { data } = await workflowEngineClient.post('/api/v1/explore/session/preflight/list', {
    action,
    payload,
    projectId,
    connectorId,
    refresh,
  });
  return data;
}

/**
 * Kicks off the async VolumeScanWorkflow in workflow-engine. Returns the
 * Temporal workflowId so the caller can persist it in scan_status. Throws on
 * upstream failure; callers should translate to scan_status.state='failed'.
 */
async function startVolumeScan(
  projectId: string,
  dataSourceId: string,
  scanConfig: ScanConfig
): Promise<{ workflowId: string; status: string }> {
  const { data } = await workflowEngineClient.post('/api/v1/connectors/volume-scan', {
    projectId,
    dataSourceId,
    scanConfig,
  });
  return data;
}

/**
 * Best-effort scan trigger for a volume data source. Updates scan_status
 * inline based on outcome. Never throws to the caller; failures are logged
 * and persisted as scan_status.state='failed'.
 */
async function triggerVolumeScan(
  repo: DataSourceRepository,
  projectId: string,
  dataSourceId: string,
  scanConfig: ScanConfig | undefined
): Promise<void> {
  if (!scanConfig || scanConfig.scan_depth === 'none') {
    // Skipped: also drop any prior result so callers don't see a stale
    // completed result attached to a "skipped" status.
    await repo.updateScanState(projectId, dataSourceId, {
      scan_status: { state: 'skipped' },
      scan_result: null,
    });
    return;
  }

  // Starting a new scan: transition to `pending` and clear any prior
  // scan_result so the UI doesn't show stale completion data while the new
  // scan is in flight.
  await repo.updateScanState(projectId, dataSourceId, {
    scan_status: { state: 'pending' },
    scan_result: null,
  });

  try {
    const { workflowId } = await startVolumeScan(projectId, dataSourceId, scanConfig);
    await repo.updateScanState(projectId, dataSourceId, {
      scan_status: {
        state: 'scanning',
        started_at: new Date().toISOString(),
        workflow_id: workflowId,
      },
    });
    console.log(`[Scan] Started volume scan workflow ${safeLog(workflowId)} for ${safeLog(projectId)}/${safeLog(dataSourceId)}`);
  } catch (err: any) {
    console.error(`[Scan] Failed to start volume scan for ${safeLog(projectId)}/${safeLog(dataSourceId)}: ${safeLog(err.message)}`);
    await repo.updateScanState(projectId, dataSourceId, {
      scan_status: {
        state: 'failed',
        last_error: err?.response?.data?.error || err?.message || 'failed to start scan workflow',
        completed_at: new Date().toISOString(),
      },
      scan_result: null,
    });
  }
}

function mountHealthFromExplorerMetadata(metadata: Record<string, any> | undefined): DataSourceMountHealth {
  const mp = metadata?.mount_preflight;
  const blocking = Array.isArray(mp?.blocking) ? mp.blocking : [];
  const warnings = Array.isArray(mp?.warnings) ? mp.warnings : [];
  const can = mp?.can_mount === true && blocking.length === 0;
  return {
    status: can ? 'healthy' : blocking.length ? 'unhealthy' : 'unknown',
    last_checked_at: new Date().toISOString(),
    blocking,
    warnings,
    probed_lif: typeof metadata?.nfs_data_lif === 'string' ? metadata.nfs_data_lif : undefined,
  };
}

async function resolveOntapConnectorId(
  repo: DataSourceRepository,
  projectId: string,
  meta: Record<string, any>,
  clusterUrlHint?: string
): Promise<string | null> {
  const fromMeta = typeof meta.connector_id === 'string' ? meta.connector_id.trim() : '';
  if (fromMeta) return fromMeta;

  const connectors = await repo.list(projectId, { type: 'connector', limit: 200 });
  const ontap = connectors.find(
    (c) =>
      c.connector_config?.provider === 'ontap' ||
      (c.connector_config as any)?.connector_type === 'storage'
  );
  if (ontap) return ontap.id;

  if (clusterUrlHint) {
    const normalized = clusterUrlHint.replace(/\/$/, '');
    const byUrl = connectors.find(
      (c) =>
        (c.connector_config as any)?.cluster_url &&
        String((c.connector_config as any).cluster_url)
          .trim()
          .replace(/\/$/, '') === normalized
    );
    if (byUrl) return byUrl.id;
  }
  return null;
}

function getRepo() {
  return new DataSourceRepository(AppDataSource);
}

/** Cap on how many associated datasets are embedded per data source in list/detail responses. */
const ASSOCIATED_DATASETS_CAP = 20;

/**
 * Batch-attach `associated_datasets` (capped) and `associated_datasets_count`
 * onto each data source. A dataset is associated when it is origin-linked to
 * the source (DataSet.originConnector for connectors, DataSet.originVolume for
 * volumes) — mirrors the default (includeManual=false) behaviour of
 * GET /:id/datasets. Runs a single grouped query over the page's ids.
 */
async function attachAssociatedDatasets(
  projectId: string,
  sources: DataSourceModel[]
): Promise<void> {
  if (sources.length === 0) return;
  const ids = sources.map((s) => s.id);
  const dataSetRepo = AppDataSource.getRepository(DataSet);
  const rows = await dataSetRepo
    .createQueryBuilder('ds')
    .select(['ds.id', 'ds.name', 'ds.originConnector', 'ds.originVolume'])
    .where('ds.projectId = :projectId', { projectId })
    .andWhere('(ds.originConnector IN (:...ids) OR ds.originVolume IN (:...ids))', { ids })
    .orderBy('ds.createdAt', 'DESC')
    .getMany();

  const bySource = new Map<string, { dset_id: string; name: string }[]>();
  for (const d of rows) {
    const key = d.originConnector ?? d.originVolume;
    if (!key) continue;
    const arr = bySource.get(key) ?? [];
    arr.push({ dset_id: d.id, name: d.name });
    bySource.set(key, arr);
  }

  for (const s of sources) {
    const all = bySource.get(s.id) ?? [];
    s.associated_datasets = all.slice(0, ASSOCIATED_DATASETS_CAP);
    s.associated_datasets_count = all.length;
  }
}

// List data sources with optional type filter
router.get('/', validateProject, listDataSourceQueryValidator, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors.array().map((e: any) => e.path ? `${e.path}: ${e.msg}` : e.msg).join(', ');
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' } as ErrorResponse);
    }
    const projectId = req.params.projectId;
    const { type, limit = '20', skip = '0', nameRegex } = req.query;
    const repo = getRepo();

    const results = await repo.list(projectId, {
      type: type as any,
      limit: Number(limit),
      skip: Number(skip),
      nameRegex: nameRegex as string,
    });

    await attachAssociatedDatasets(projectId, results);

    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to list data sources', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Create a data source
router.post('/', validateProject, createDataSourceValidator, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors.array().map((e: any) => e.path ? `${e.path}: ${e.msg}` : e.msg).join(', ');
      logger.error(`[DataSource Validation] Errors: ${JSON.stringify(errors.array())}`);
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' } as ErrorResponse);
    }

    const projectId = req.params.projectId;
    const repo = getRepo();

    const { name, type } = req.body;

    // Validate name (reuse bucket name validation for consistency)
    if (type === 'volume') {
      const nameValidation = validateBucketName(name.trim());
      if (!nameValidation.valid) {
        return res.status(400).json({ error: nameValidation.error || 'Invalid volume name', code: 'INVALID_NAME' } as ErrorResponse);
      }
    }

    // Check uniqueness within project
    if (await repo.exists(projectId, name.trim())) {
      return res.status(409).json({ error: 'A data source with this name already exists in this project', code: 'CONFLICT' } as ErrorResponse);
    }

    const result = await repo.create(projectId, {
      ...req.body,
      name: name.trim(),
    }, (req.user?.sub as string | undefined) || undefined);

    logger.info(
      `[DataSource Created] Project: ${projectId} | ` +
      `Name: ${result.name} | ` +
      `Type: ${result.type} | ` +
      `ID: ${result.id}`
    );

    // For volumes, try to assign to a deployment (non-blocking)
    if (type === 'volume') {
      try {
        const { DeploymentRepository } = await import('../repositories/DeploymentRepository');
        const { DeploymentAssignmentRepository } = await import('../repositories/DeploymentAssignmentRepository');
        const { ConfigVersionRepository } = await import('../repositories/ConfigVersionRepository');
        const deploymentRepo = new DeploymentRepository(AppDataSource);
        const assignmentRepo = new DeploymentAssignmentRepository(AppDataSource);
        const configVersionRepo = new ConfigVersionRepository(AppDataSource);

        const region = req.body.volume_config?.region;
        const existingAssignments = await assignmentRepo.listByBucket(projectId, result.name, 'active');
        if (existingAssignments.length === 0) {
          const allDeployments = await deploymentRepo.list();
          if (allDeployments.length > 0) {
            const scoredDeployments = await Promise.all(
              allDeployments.map(async (deployment) => {
                const currentAssignments = await assignmentRepo.listByDeployment(deployment.id);
                const assignmentCount = currentAssignments.length;
                const maxBuckets = deployment.capacity?.max_buckets;
                const hasCapacity = !maxBuckets || assignmentCount < maxBuckets;

                let score = 0;
                if (region && deployment.region === region) score += 1000;
                if (hasCapacity) {
                  score += maxBuckets ? (maxBuckets - assignmentCount) * 10 : 100;
                }
                return { deployment, score, hasCapacity };
              })
            );

            const bestDeployment = scoredDeployments
              .filter((d) => d.hasCapacity)
              .sort((a, b) => b.score - a.score)[0];

            if (bestDeployment) {
              await assignmentRepo.create({
                project_id: projectId,
                bucket_name: result.name,
                deployment_id: bestDeployment.deployment.id,
                role: 'primary',
                priority: 0,
                status: 'active',
                assignment_reason: `auto_assigned: region_match=${region && bestDeployment.deployment.region === region}`,
                load_balance_weight: 100,
              });
              await configVersionRepo.incrementVersion();
              logger.info(`[Assignment] Assigned data source ${projectId}/${result.name} to deployment ${bestDeployment.deployment.id}`);
            }
          }
        }
      } catch (error: any) {
        logger.error(`[DataSource Created] Failed to assign to deployment:`, error.message);
      }
    }

    await applyForEntity(undefined, 'data_source', projectId, result);

    // Kick off volume scan after deployment assignment. Non-blocking: response
    // returns immediately with scan_status populated by the trigger helper.
    let finalResult = result;
    if (type === 'volume') {
      await triggerVolumeScan(repo, projectId, result.id, req.body.scan_config);
      const refreshed = await repo.get(projectId, result.id);
      if (refreshed) finalResult = refreshed;
    }

    res.status(201).json(finalResult);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to create data source', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Bulk ONTAP re-resolve (staged plan for operator review)
router.post('/bulk-preflight', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId as string;
    const repo = getRepo();
    const filter = (req.body && req.body.filter) || {};
    const wantSource = filter.source as string | undefined;

    const list = await repo.list(projectId, { type: 'volume', limit: 500 });
    const candidates = list.filter((ds) => {
      if (wantSource && (ds.metadata as any)?.source !== wantSource) return false;
      return true;
    });

    const results: any[] = [];
    for (const ds of candidates) {
      const meta = ds.metadata || {};
      if (wantSource === undefined && meta.source !== 'ontap-connector-explorer') continue;

      const clusterUrl = typeof meta.ontap_cluster_url === 'string' ? meta.ontap_cluster_url : undefined;
      const connectorId = await resolveOntapConnectorId(repo, projectId, meta, clusterUrl);
      if (!connectorId) {
        results.push({
          id: ds.id,
          name: ds.name,
          error: 'no_ontap_connector',
        });
        continue;
      }

      const payload: Record<string, unknown> = {
        svm_uuid: meta.svm_uuid,
        svm_name: meta.svm_name,
        volume_uuid: meta.volume_uuid,
        volume_name: meta.volume_name,
      };

      try {
        const resp = await workflowExplorerList(projectId, connectorId, 'resolveBestMountForVolume', payload, true);
        if (resp.error) {
          results.push({
            id: ds.id,
            name: ds.name,
            error: resp.error,
          });
          continue;
        }
        const node = resp.nodes?.[0];
        const resource = node?.resource || {};
        const proposed = typeof resource.endpoint === 'string' ? resource.endpoint : '';
        const current = ds.volume_config?.volume_info?.endpoint || '';
        const mp = node?.metadata?.mount_preflight;
        const blocking = Array.isArray(mp?.blocking) ? mp.blocking : [];
        results.push({
          id: ds.id,
          name: ds.name,
          current_endpoint: current,
          proposed_endpoint: proposed,
          mount_preflight: mp,
          mount_options: resource.mount_options,
          would_change: !!proposed && current !== proposed,
          blocking,
        });
      } catch (e: any) {
        results.push({ id: ds.id, name: ds.name, error: e.message || String(e) });
      }
    }

    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'bulk-preflight failed', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Apply bulk ONTAP endpoint updates (re-runs resolve per id)
router.post('/bulk-apply', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId as string;
    const repo = getRepo();
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const dryRun = !!req.body?.dry_run;
    if (!ids.length) {
      return res.status(400).json({ error: 'ids (string[]) is required', code: 'VALIDATION_ERROR' } as ErrorResponse);
    }

    const outcomes: any[] = [];

    for (const id of ids) {
      const ds = await repo.get(projectId, id);
      if (!ds || ds.type !== 'volume') {
        outcomes.push({ id, ok: false, error: 'not_found' });
        continue;
      }
      const meta = ds.metadata || {};
      const clusterUrl = typeof meta.ontap_cluster_url === 'string' ? meta.ontap_cluster_url : undefined;
      const connectorId = await resolveOntapConnectorId(repo, projectId, meta, clusterUrl);
      if (!connectorId) {
        outcomes.push({ id, ok: false, error: 'no_ontap_connector' });
        continue;
      }

      const payload: Record<string, unknown> = {
        svm_uuid: meta.svm_uuid,
        svm_name: meta.svm_name,
        volume_uuid: meta.volume_uuid,
        volume_name: meta.volume_name,
      };

      try {
        const resp = await workflowExplorerList(projectId, connectorId, 'resolveBestMountForVolume', payload, true);
        if (resp.error) {
          outcomes.push({ id, ok: false, error: resp.error });
          continue;
        }
        const node = resp.nodes?.[0];
        const resource = node?.resource || {};
        const mp = node?.metadata?.mount_preflight;
        const blocking = Array.isArray(mp?.blocking) ? mp.blocking : [];
        if (blocking.length) {
          outcomes.push({ id, ok: false, skipped: true, blocking });
          continue;
        }

        const endpoint = typeof resource.endpoint === 'string' ? resource.endpoint : '';
        const mountOptions = Array.isArray(resource.mount_options) ? resource.mount_options : undefined;
        if (!endpoint) {
          outcomes.push({ id, ok: false, error: 'no_proposed_endpoint' });
          continue;
        }

        if (dryRun) {
          outcomes.push({ id, ok: true, dry_run: true, proposed_endpoint: endpoint });
          continue;
        }

        const mh = mountHealthFromExplorerMetadata(node?.metadata || {});
        const volType = ds.volume_config?.volume_info?.type || 'nfs';
        await repo.update(projectId, id, {
          volume_config: {
            volume_info: {
              type: volType,
              endpoint,
              ...(mountOptions ? { mount_options: mountOptions as string[] } : {}),
            },
          },
          metadata: {
            ...meta,
            last_ontap_bulk_repair_at: new Date().toISOString(),
          },
          mount_health: mh,
        });
        outcomes.push({ id, ok: true });
      } catch (e: any) {
        outcomes.push({ id, ok: false, error: e.message || String(e) });
      }
    }

    res.json({ outcomes });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'bulk-apply failed', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

router.post('/:id/preflight', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId as string;
    const id = req.params.id;
    const repo = getRepo();
    const ds = await repo.get(projectId, id);
    if (!ds || ds.type !== 'volume') {
      return res.status(404).json({ error: 'Volume data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    const meta = ds.metadata || {};
    const clusterUrl = typeof meta.ontap_cluster_url === 'string' ? meta.ontap_cluster_url : undefined;
    const connectorId = await resolveOntapConnectorId(repo, projectId, meta, clusterUrl);
    if (!connectorId) {
      return res.status(400).json({
        error: 'No ONTAP connector found for this project (set metadata.connector_id or add an ONTAP connector).',
        code: 'NO_CONNECTOR',
      } as ErrorResponse);
    }

    const payload: Record<string, unknown> = {
      svm_uuid: meta.svm_uuid,
      svm_name: meta.svm_name,
      volume_uuid: meta.volume_uuid,
      volume_name: meta.volume_name,
    };

    try {
      const resp = await workflowExplorerList(projectId, connectorId, 'testVolumeMount', payload, true);
      if (resp.error) {
        const mh: DataSourceMountHealth = {
          status: 'unhealthy',
          last_checked_at: new Date().toISOString(),
          blocking: [resp.error.message || 'explorer error'],
        };
        await repo.update(projectId, id, { mount_health: mh });
        return res.json({ mount_health: mh, explorer_error: resp.error });
      }
      const node = resp.nodes?.[0];
      const metadata = (node?.metadata || {}) as Record<string, any>;
      const mh = mountHealthFromExplorerMetadata(metadata);
      await repo.update(projectId, id, { mount_health: mh });
      const updated = await repo.get(projectId, id);
      return res.json({ mount_health: mh, explorer: { metadata }, data_source: updated });
    } catch (e: any) {
      return res.status(502).json({
        error: e.response?.data?.error || e.message || 'workflow-engine request failed',
        code: 'UPSTREAM_ERROR',
      } as ErrorResponse);
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'preflight failed', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Get a data source by ID
router.get('/:id', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = getRepo();
    const result = await repo.get(projectId, req.params.id);

    if (!result) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    await attachAssociatedDatasets(projectId, [result]);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to get data source', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Update a data source
router.put('/:id', validateProject, updateDataSourceValidator, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = getRepo();

    const current = await repo.get(projectId, req.params.id);
    if (!current) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    // Check name uniqueness if name is being changed
    if (req.body.name && req.body.name !== current.name) {
      if (await repo.exists(projectId, req.body.name.trim())) {
        return res.status(409).json({ error: 'A data source with this name already exists in this project', code: 'CONFLICT' } as ErrorResponse);
      }
    }

    // Validate volume config updates (static NFS export path, dynamic storage class)
    if (req.body.volume_config && current.type === 'volume') {
      const volumeErr = validateVolumeConfigUpdate(req.body.volume_config, current.volume_config);
      if (volumeErr) {
        return res.status(400).json({ error: volumeErr, code: 'INVALID_REQUEST' } as ErrorResponse);
      }
    }

    // scan_config is volume-only on update too. Allow it through only for volumes.
    if (req.body.scan_config !== undefined && current.type !== 'volume') {
      return res.status(400).json({
        error: 'scan_config is only allowed on volume data sources',
        code: 'INVALID_REQUEST',
      } as ErrorResponse);
    }

    const previousScanConfig = current.scan_config;
    const result = await repo.update(projectId, req.params.id, req.body, (req.user?.sub as string | undefined) || undefined);
    if (result) {
      await applyForEntity(undefined, 'data_source', projectId, result);
    }

    // If scan_config changed (and we're a volume), retrigger the scan.
    let finalResult = result;
    if (
      result &&
      current.type === 'volume' &&
      req.body.scan_config !== undefined &&
      JSON.stringify(previousScanConfig) !== JSON.stringify(req.body.scan_config)
    ) {
      await triggerVolumeScan(repo, projectId, result.id, req.body.scan_config);
      const refreshed = await repo.get(projectId, result.id);
      if (refreshed) finalResult = refreshed;
    }
    res.json(finalResult);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update data source', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Manual rescan trigger (volume data sources only). Optional scan_config in
// body overrides the stored value before triggering.
router.post('/:id/scan', validateProject, scanDataSourceValidator, async (req: Request, res: Response) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors.array().map((e: any) => e.path ? `${e.path}: ${e.msg}` : e.msg).join(', ');
      return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' } as ErrorResponse);
    }

    const projectId = req.params.projectId as string;
    const id = req.params.id;
    const repo = getRepo();

    const current = await repo.get(projectId, id);
    if (!current) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }
    if (current.type !== 'volume') {
      return res.status(400).json({
        error: 'Scan applies only to volume data sources',
        code: 'INVALID_REQUEST',
      } as ErrorResponse);
    }

    const overrideConfig = req.body?.scan_config as ScanConfig | undefined;
    if (overrideConfig) {
      await repo.updateScanConfig(projectId, id, overrideConfig);
    }
    const effectiveConfig = overrideConfig || current.scan_config;
    if (!effectiveConfig) {
      return res.status(400).json({
        error: 'No scan_config available; provide one in the request body or set it on the data source first',
        code: 'INVALID_REQUEST',
      } as ErrorResponse);
    }

    await triggerVolumeScan(repo, projectId, id, effectiveConfig);
    const refreshed = await repo.get(projectId, id);
    return res.status(202).json(refreshed);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to trigger scan', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// List datasets associated with a data source.
//   - connector (cn-*): DataSet.originConnector = id
//   - volume    (vol-*): DataSet.originVolume = id [+ optional ?includeManual=true
//                          adds DataSet.type='manual' AND bucketName = DataSource.name]
router.get(
  '/:id/datasets',
  validateProject,
  listAssociatedDataSetsQueryValidator,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const details = errors.array().map((e: any) => e.path ? `${e.path}: ${e.msg}` : e.msg).join(', ');
        return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' } as ErrorResponse);
      }

      const projectId = req.params.projectId as string;
      const id = req.params.id;
      const repo = getRepo();

      const ds = await repo.get(projectId, id);
      if (!ds) {
        return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
      }

      const { limit = '20', skip = '0', nameRegex, includeManual } = req.query;
      const includeManualFlag = String(includeManual ?? 'false').toLowerCase() === 'true';

      const dataSetRepo = AppDataSource.getRepository(DataSet);
      const qb = dataSetRepo.createQueryBuilder('ds').where('ds.projectId = :projectId', { projectId });

      if (ds.type === 'connector') {
        qb.andWhere('ds.originConnector = :id', { id });
      } else {
        // volume
        if (includeManualFlag) {
          // Either explicitly origin-volume-linked OR a manual dataset on this volume bucket.
          qb.andWhere(
            '(ds.originVolume = :id OR (ds.type = :manualType AND ds.bucketName = :bucketName))',
            { id, manualType: 'manual', bucketName: ds.name }
          );
        } else {
          qb.andWhere('ds.originVolume = :id', { id });
        }
      }

      if (nameRegex && typeof nameRegex === 'string' && nameRegex.length > 0) {
        qb.andWhere('ds.name ILIKE :nameRegex', { nameRegex: `%${nameRegex}%` });
      }

      qb.orderBy('ds.createdAt', 'DESC')
        .take(Number(limit))
        .skip(Number(skip));

      const items = await qb.getMany();
      const result = items.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        type: d.type,
        kind: d.kind,
        originConnector: d.originConnector,
        originVolume: d.originVolume,
        bucketName: d.bucketName,
        status: d.status,
        // file_scope: source-file count captured at import completion (falls back
        // to the latest snapshot's file count, then 0 when neither is set yet).
        file_scope: d.stats?.sourceFileCount ?? d.latestSnapshot?.totalFiles ?? 0,
        // synchronization_schedule: derived cron persisted on scheduleConfig.
        synchronization_schedule: d.scheduleConfig?.cronExpression ?? null,
        labels: Array.isArray(d.labels) ? d.labels : [],
        createdAt: d.createdAt?.toISOString?.() ?? d.createdAt,
        updatedAt: d.updatedAt?.toISOString?.() ?? d.updatedAt,
      }));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({
        error: error.message || 'Failed to list associated datasets',
        code: 'INTERNAL_ERROR',
      } as ErrorResponse);
    }
  }
);

// Record connection test result (connectors only)
router.patch('/:id/connection-test-result', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const id = req.params.id;
    const repo = getRepo();

    const current = await repo.get(projectId, id);
    if (!current) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }
    if (current.type !== 'connector') {
      return res.status(400).json({ error: 'Connection test result applies only to connectors', code: 'INVALID_REQUEST' } as ErrorResponse);
    }

    const { success, message } = req.body;
    if (typeof success !== 'boolean') {
      return res.status(400).json({ error: 'body.success (boolean) is required', code: 'VALIDATION_ERROR' } as ErrorResponse);
    }

    const result = await repo.updateConnectionTestResult(projectId, id, {
      success,
      message: typeof message === 'string' ? message : undefined,
    });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to record connection test result', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Delete a data source
router.delete('/:id', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const repo = getRepo();

    const current = await repo.get(projectId, req.params.id);
    if (!current) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    // Terminate running connector workflows (test, explorer) before deletion
    if (current.type === 'connector') {
      try {
        await workflowEngineClient.post(
          `/api/v1/projects/${projectId}/connectors/${req.params.id}/terminate`
        );
      } catch (terminateErr: any) {
        logger.warn(`Failed to terminate workflows for connector ${req.params.id}: ${terminateErr.message}`);
      }
    }

    await repo.delete(projectId, req.params.id);
    await removeForSource(undefined, 'data_source', projectId, req.params.id);

    logger.info(
      `[DataSource Deleted] Project: ${projectId} | ` +
      `Name: ${current.name} | ` +
      `Type: ${current.type}`
    );

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete data source', code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// List history for a data source
router.get('/:id/history', validateProject, async (req: Request, res: Response) => {
  try {
    const projectId = req.params.projectId;
    const entityRepo = AppDataSource.getRepository(DataSourceEntity);
    const ds = await entityRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!ds) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    const historyRepo = AppDataSource.getRepository(DataSourceHistory);
    const history = await historyRepo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });

    if (!history || history.length === 0) {
      return res.status(404).json({ error: 'No history found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

// Restore a data source to a previous version
router.post('/:id/restore-version', validateProject, async (req: Request, res: Response) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body', code: 'VALIDATION_ERROR' } as ErrorResponse);
  }

  try {
    const projectId = req.params.projectId;
    const entityRepo = AppDataSource.getRepository(DataSourceEntity);
    const ds = await entityRepo.findOne({ where: { id: req.params.id, projectId } });
    if (!ds) {
      return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
    }

    const historyRepo = AppDataSource.getRepository(DataSourceHistory);
    const history = await historyRepo.findOne({
      where: { entityId: req.params.id, version },
    });
    if (!history) {
      return res.status(404).json({ error: 'Version not found in history', code: 'NOT_FOUND' } as ErrorResponse);
    }

    const { data } = history;
    const { id, createdAt, updatedAt, ...restoreData } = data;

    await entityRepo.update({ id: req.params.id, projectId }, { ...restoreData, projectId });
    const updated = await entityRepo.findOne({ where: { id: req.params.id, projectId } });
    if (updated) {
      await applyForEntity(undefined, 'data_source', projectId, updated);
    }

    res.json({ restored: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' } as ErrorResponse);
  }
});

export default router;
