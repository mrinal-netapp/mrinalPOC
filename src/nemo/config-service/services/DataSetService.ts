import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import axios, { AxiosInstance } from 'axios';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { DataSet, DatasetRefreshConfig } from '../models/DataSet';
import { DataSetHistory } from '../models/history/DataSetHistory';
import { BaseService } from './BaseService';
import { LakekeeperCatalogService, CatalogTable } from './LakekeeperCatalogService';
import { NotFoundError, ValidationError, PayloadTooLargeError } from '../utils/errors';
import { FindOptionsWhere, Not } from 'typeorm';
import { DataSetValidator } from './DataSetValidator';
import { ProjectRepository } from '../repositories/ProjectRepository';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { FacetService } from './FacetService';
import { Facet } from '../models/Facet';
import { cronFromRefreshConfig } from '../utils/cronFromRefreshConfig';
import {
  datasetAcquisitionScopeChanged,
  isAcquiredDataset,
} from '../utils/datasetAcquisitionScope';
import { KnowledgeBaseScheduleService } from './KnowledgeBaseScheduleService';
import { safeSegment, safeLog } from '../utils/safeStrings';

const dataSetRepo = () => AppDataSource.getRepository(DataSet);
const historyRepo = () => AppDataSource.getRepository(DataSetHistory);
const catalogService = new LakekeeperCatalogService();

export interface CreateDataSetRequest {
  name: string;
  description: string;
  type: 'acquired' | 'manual';
  originConnector?: string;
  /** Volume data source id — POSIX acquisition; mutually exclusive with connector-backed flows. */
  originVolume?: string;
  kind: 'unstructured' | 'structured';
  filterSpec?: Record<string, any>;
  fileProcessors?: string[];
  sqlQuery?: string;
  sourceDatabase?: string;
  sourceSchema?: string;
  enablePiiAnalysis?: boolean;
  piiAnalysisImageOnly?: boolean;
  /** Optional user-facing refresh schedule, accepted as `refresh_config` or `refreshConfig`. */
  refreshConfig?: DatasetRefreshConfig;
  refresh_config?: DatasetRefreshConfig;
  /** Optional user-supplied labels (free-form tags) for organization and search. */
  labels?: string[];
}

export interface UploadedFileInfo {
  key: string;
  url: string;
  size?: number;
  originalName?: string;
}

export interface UpdateDataSetRequest {
  name?: string;
  description?: string;
  type?: 'acquired' | 'manual';
  originConnector?: string;
  originVolume?: string;
  kind?: 'unstructured' | 'structured';
  filterSpec?: Record<string, any>;
  fileProcessors?: string[];
  sqlQuery?: string;
  sourceDatabase?: string;
  sourceSchema?: string;
  uploadedFiles?: UploadedFileInfo[];
  enablePiiAnalysis?: boolean;
  piiAnalysisImageOnly?: boolean;
  piiSummary?: {
    filesWithPii: number;
    totalFiles: number;
    piiAnalysisEnabled: boolean;
  };
  // Catalog fields - set by the import processor after PyIceberg registration
  catalogTableRef?: string;   // Full reference: namespace.table
  namespace?: string;         // Catalog namespace
  catalogTableName?: string;  // Table name in catalog
  refreshConfig?: DatasetRefreshConfig;
  refresh_config?: DatasetRefreshConfig;
  /** Optional user-supplied labels (free-form tags); pass `[]` to clear. */
  labels?: string[];
}

export interface ListDataSetsOptions {
  projectId: string;
  limit?: number;
  skip?: number;
  field?: string;
  value?: string;
  nameRegex?: string;
  includeCatalog?: boolean;
}

const WORKFLOW_ENGINE_URL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';

// workflow-engine routes are protected by AuthMiddleware when
// KEYCLOAK_INTERNAL_ISSUER is set. Use a service-account-authenticated axios
// client so dataset schedule create/delete is not rejected with 401 in
// secured deployments. Falls back to plain axios when service-account
// credentials are absent (dev / unsecured envs).
const workflowEngineServiceAccountClient: ServiceAccountClient | null =
  createServiceAccountClientFromEnv();
const workflowEngineClient: AxiosInstance = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(WORKFLOW_ENGINE_URL)
  : axios.create({
      baseURL: WORKFLOW_ENGINE_URL,
      headers: { 'Content-Type': 'application/json' },
    });

export class DataSetService extends BaseService {
  /**
   * Reconcile `refresh_config` -> Temporal schedule -> persisted `scheduleConfig`.
   *
   * When refreshConfig is provided we derive a 5-field cron expression and a
   * timezone, then ask the workflow-engine to create (or replace) the Temporal
   * Schedule. The resulting `temporalScheduleId` is mirrored into the legacy
   * `scheduleConfig` JSONB column so the workflow-engine's existing reader
   * keeps working untouched.
   *
   * When auto_refresh_enabled=false or paused=true the existing schedule (if
   * any) is torn down and `scheduleConfig.enabled` is set to false.
   */
  private static async applyRefreshConfig(
    projectId: string,
    datasetId: string,
    refreshConfig: DatasetRefreshConfig | null | undefined,
    currentScheduleConfig: DataSet['scheduleConfig'] | undefined,
  ): Promise<DataSet['scheduleConfig'] | undefined> {
    if (!refreshConfig) return currentScheduleConfig;

    const derived = cronFromRefreshConfig(refreshConfig);

    if (!derived) {
      // refresh disabled or paused: tear down any existing schedule
      if (currentScheduleConfig?.temporalScheduleId) {
        try {
          await workflowEngineClient.delete(
            `/api/v1/projects/${safeSegment(projectId)}/datasets/${safeSegment(datasetId)}/schedule`,
            { data: { temporalScheduleId: currentScheduleConfig.temporalScheduleId }, timeout: 5000 },
          );
        } catch (err: any) {
          console.warn(`[DataSetService] Failed to delete Temporal schedule ${safeLog(currentScheduleConfig.temporalScheduleId)}: ${safeLog(err.message)}`);
        }
      }
      return {
        cronExpression: currentScheduleConfig?.cronExpression || '',
        timezone: currentScheduleConfig?.timezone || refreshConfig.timezone || 'UTC',
        temporalScheduleId: undefined,
        enabled: false,
      };
    }

    // refresh enabled: create-or-replace the Temporal schedule
    try {
      const resp = await workflowEngineClient.post(
        `/api/v1/projects/${safeSegment(projectId)}/datasets/${safeSegment(datasetId)}/schedule`,
        {
          cronExpression: derived.cronExpression,
          timezone: derived.timezone,
          enabled: true,
          temporalScheduleId: currentScheduleConfig?.temporalScheduleId,
        },
        { timeout: 8000 },
      );
      const temporalScheduleId = resp.data?.temporalScheduleId as string | undefined;
      return {
        cronExpression: derived.cronExpression,
        timezone: derived.timezone,
        temporalScheduleId,
        enabled: true,
      };
    } catch (err: any) {
      console.warn(
        `[DataSetService] Failed to create Temporal schedule for dataset ${safeLog(datasetId)} ` +
          `(cron=${safeLog(derived.cronExpression)} tz=${safeLog(derived.timezone)}): ${safeLog(err.message)}. ` +
          `Persisting cron in scheduleConfig anyway; reconcile manually.`,
      );
      // We still persist the derived cron so a future reconcile can pick it up.
      return {
        cronExpression: derived.cronExpression,
        timezone: derived.timezone,
        temporalScheduleId: currentScheduleConfig?.temporalScheduleId,
        enabled: true,
      };
    }
  }

  /**
   * Tear down the Temporal refresh schedule for a dataset, if one exists.
   * Called on dataset deletion so we don't leak orphaned Temporal schedules.
   * Best-effort: failures are logged, never thrown (deletion must still proceed).
   * Mirrors KnowledgeBaseScheduleService.tearDownSchedule.
   */
  private static async tearDownSchedule(
    projectId: string,
    datasetId: string,
    scheduleConfig: DataSet['scheduleConfig'] | undefined,
  ): Promise<void> {
    const temporalScheduleId = scheduleConfig?.temporalScheduleId;
    if (!temporalScheduleId) return;
    try {
      await workflowEngineClient.delete(
        `/api/v1/projects/${safeSegment(projectId)}/datasets/${safeSegment(datasetId)}/schedule`,
        { data: { temporalScheduleId }, timeout: 5000 },
      );
      console.log(
        `[DataSetService] Tore down Temporal schedule ${safeLog(temporalScheduleId)} for dataset ${safeLog(datasetId)}`,
      );
    } catch (err: any) {
      console.warn(
        `[DataSetService] Failed to tear down Temporal schedule ${safeLog(temporalScheduleId)} for dataset ${safeLog(datasetId)}: ${safeLog(err.message)}`,
      );
    }
  }

  /**
   * Create a new dataset
   * Creates domain metadata in PostgreSQL with status "in_progress".
   * Catalog registration happens later via DatasetImportWorkflow after files are uploaded.
   */
  static async createDataSet(
    projectId: string,
    data: CreateDataSetRequest,
    actor?: string
  ): Promise<DataSet & { catalogTable?: any }> {
    // Load project to derive bucket and path prefix from home_dir
    const projectRepo = new ProjectRepository(AppDataSource);
    const project = await projectRepo.getById(projectId);
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    // Always derive bucket from project home_dir (home_dir is required). Client must not send bucketName.
    const { bucketName: resolvedBucket, pathPrefix } = getProjectStorageRoot(project);

    // Validate request
    DataSetValidator.validateCreateRequest(projectId, data);
    await DataSetValidator.checkDuplicateName(projectId, data.name);

    // Use static warehouse name "nemo" and namespace [projectId]
    const warehouseName = 'nemo';
    const namespace = [projectId];

    // Normalize the refresh config (accept either snake_case or camelCase from clients).
    const refreshConfig = (data.refreshConfig ?? data.refresh_config) as DatasetRefreshConfig | undefined;

    // Create dataset with status "creating" - catalog registration happens later via workflow
    const repo = dataSetRepo();
    // Strip incoming refresh_config aliases — refreshConfig is the typed column name.
    const { refresh_config: _ignored, refreshConfig: _ignoredCamel, ...rest } = data as unknown as Record<string, unknown>;
    void _ignored;
    void _ignoredCamel;
    const plain: Partial<DataSet> = {
      ...(rest as Partial<DataSet>),
      projectId,
      bucketName: resolvedBucket,
      // description is optional in the API but NOT NULL in the DB; default an
      // omitted value to '' so it never leaks a constraint violation as a 500.
      description: typeof data.description === 'string' ? data.description : '',
      refreshConfig,
      modifiedBy: actor || undefined,
    };
    const ds = repo.create(plain);
    const savedDs = await repo.save(ds);

    // Use dataset name as table name (validated to be a valid table identifier)
    const tableName = savedDs.name;
    logger.info(`[DataSetService] Step 1: Dataset created in PostgreSQL with ID: ${savedDs.id}, name: ${savedDs.name}`);

    // Store warehouse/namespace info for later use by the import workflow
    logger.info(`[DataSetService] Step 2: Storing warehouse and namespace info for deferred catalog registration`);
    savedDs.warehouseName = warehouseName;
    savedDs.namespace = namespace.join('.');
    savedDs.catalogTableName = tableName;
    savedDs.status = 'in_progress';
    await repo.save(savedDs);

    // If a refresh_config was supplied, derive a cron + push to workflow-engine.
    if (refreshConfig) {
      const newScheduleConfig = await this.applyRefreshConfig(
        projectId,
        savedDs.id,
        refreshConfig,
        savedDs.scheduleConfig,
      );
      if (newScheduleConfig) {
        savedDs.scheduleConfig = newScheduleConfig;
        await repo.save(savedDs);
        logger.info(`[DataSetService] Applied refresh_config: ${safeLog(refreshConfig.schedule_type)} -> cron=${safeLog(newScheduleConfig.cronExpression)} tz=${safeLog(newScheduleConfig.timezone)}`);
      }
    }

    logger.info(`[DataSetService] Dataset creation completed. Dataset ID: ${savedDs.id}`);

    // Log S3 path using project home_dir path prefix
    logger.info(`[DataSetService] Next step: Upload files to s3://${resolvedBucket}/${pathPrefix}/datasets/${savedDs.id}/data_files/ then trigger import workflow`);

    return savedDs;
  }

  /**
   * Get dataset by ID
   */
  static async getDataSet(id: string, includeCatalog: boolean = true): Promise<DataSet & { catalogTable?: any }> {
    if (includeCatalog) {
      return await this.getDataSetWithCatalog(id);
    }

    const repo = dataSetRepo();
    const dataset = await repo.findOne({ where: { id } });
    
    if (!dataset) {
      throw new NotFoundError('DataSet', id);
    }

    return dataset;
  }

  /**
   * Get dataset with catalog table metadata and facets
   */
  private static async getDataSetWithCatalog(id: string): Promise<DataSet & { catalogTable?: any; facets?: Facet[] }> {
    const repo = dataSetRepo();
    const dataset = await repo.findOne({ where: { id } });
    
    if (!dataset) {
      throw new NotFoundError('DataSet', id);
    }

    // Fetch catalog table metadata if catalog references exist
    let catalogTable: CatalogTable | null = null;
    if (dataset.catalogTableRef && dataset.namespace && dataset.catalogTableName) {
      try {
        const namespace = dataset.namespace.split('.');
        catalogTable = await catalogService.getTable(namespace, dataset.catalogTableName, dataset.warehouseName);
      } catch (error: any) {
        logger.warn(`Catalog table not found for dataset ${id}: ${error.message}`);
      }
    }

    // Load facets with lazy backfill for PII
    const facets = await this.loadFacetsWithBackfill(dataset);

    // Strip piiSummary from response — PII data now lives in the PII facet
    const result = Object.assign({}, dataset, { catalogTable, facets });
    delete (result as any).piiSummary;
    return result;
  }

  /**
   * Load facets for a dataset, lazily backfilling PII facet from existing piiSummary
   */
  private static async loadFacetsWithBackfill(dataset: DataSet): Promise<Facet[]> {
    let facets = await FacetService.listFacets(dataset.projectId, 'dataset', dataset.id);

    // Lazy backfill: if dataset has piiSummary but no PII facet, create one
    const hasPiiFacet = facets.some(f => f.facetType === 'pii');
    if (!hasPiiFacet && dataset.enablePiiAnalysis && dataset.piiSummary) {
      const backfilledFacet = await FacetService.lazyBackfill(
        dataset.projectId,
        'dataset',
        dataset.id,
        'pii',
        dataset.piiSummary
      );
      if (backfilledFacet) {
        facets = await FacetService.listFacets(dataset.projectId, 'dataset', dataset.id);
      }
    }

    return facets;
  }

  /**
   * Update dataset
   * Updates both domain metadata and catalog table properties if needed
   * If uploadedFiles is provided, creates/updates the manifest with those files
   */
  static async updateDataSet(
    id: string,
    projectId: string,
    data: UpdateDataSetRequest,
    actor?: string
  ): Promise<DataSet & { catalogTable?: any }> {
    const repo = dataSetRepo();
    const currentDataSet = await repo.findOne({ where: { id, projectId } });
    
    if (!currentDataSet) {
      throw new NotFoundError('DataSet', id);
    }

    // Validate update rules
    DataSetValidator.validateUpdate(currentDataSet, data);

    // Check for duplicate name if name is being changed
    if (data.name && data.name !== currentDataSet.name) {
      await DataSetValidator.checkDuplicateName(projectId, data.name, id);
    }

    // Update catalog table properties if dataset has catalog reference
    if (currentDataSet.catalogTableRef && currentDataSet.namespace && currentDataSet.catalogTableName) {
      try {
        const namespace = currentDataSet.namespace.split('.');
        const catalogTable = await catalogService.getTable(namespace, currentDataSet.catalogTableName, currentDataSet.warehouseName);
        
        // Update table properties with new metadata
        const updatedProperties = {
          ...catalogTable.metadata.properties,
          'agentstudio.dataset.name': data.name || currentDataSet.name,
          ...(data.description && { 'agentstudio.dataset.description': data.description }),
        };

        await catalogService.updateTableMetadata(namespace, currentDataSet.catalogTableName, {
          properties: updatedProperties,
        }, currentDataSet.warehouseName);
      } catch (error: any) {
        logger.warn(`Failed to update catalog table properties: ${error.message}`);
      }
    }

    // Handle uploaded files - create/update manifest
    if (data.uploadedFiles && data.uploadedFiles.length > 0) {
      // Enforce per-file size cap (only applies to entries that carry a size; older
      // clients may omit it).
      const maxFileBytes = Number.parseInt(process.env.MANUAL_UPLOAD_MAX_FILE_BYTES || '', 10);
      const effectiveMax = Number.isFinite(maxFileBytes) && maxFileBytes >= 0
        ? maxFileBytes
        : 5 * 1024 * 1024 * 1024; // 5 GiB default
      if (effectiveMax > 0) {
        const oversized = data.uploadedFiles.filter(
          (f) => typeof f.size === 'number' && (f.size as number) > effectiveMax,
        );
        if (oversized.length > 0) {
          throw new PayloadTooLargeError(
            `Manual upload: ${oversized.length} file(s) exceed the per-file limit of ${effectiveMax} bytes. ` +
            `First offender: ${oversized[0].originalName || oversized[0].key} (${oversized[0].size} bytes).`,
          );
        }
      }
      logger.info(`[DataSetService] Updating manifest for dataset ${id} with ${data.uploadedFiles.length} files`);
      await this.updateManifestWithFiles(id, data.uploadedFiles);
    }

    // Normalize incoming refresh_config (accept either snake_case or camelCase).
    const incomingRefresh = (data.refreshConfig ?? data.refresh_config) as DatasetRefreshConfig | undefined;

    const shouldTriggerAcquisition =
      isAcquiredDataset(currentDataSet) &&
      datasetAcquisitionScopeChanged(currentDataSet, data as Record<string, unknown>);

    // Update dataset fields (excluding uploadedFiles which is handled separately).
    // Bucket is always derived from project home_dir at creation; ignore any client bucketName.
    const { uploadedFiles: _uploadedFiles, refresh_config: _ignoredSnake, ...dataToUpdate } = data as Record<string, unknown>;
    void _ignoredSnake;
    delete dataToUpdate.bucketName;
    Object.assign(currentDataSet, dataToUpdate);
    if (incomingRefresh) {
      currentDataSet.refreshConfig = incomingRefresh;
    }
    if (actor) {
      currentDataSet.modifiedBy = actor;
    }
    await repo.save(currentDataSet);

    // Reconcile schedule when refresh_config was provided in this update.
    if (incomingRefresh) {
      const newScheduleConfig = await this.applyRefreshConfig(
        projectId,
        currentDataSet.id,
        incomingRefresh,
        currentDataSet.scheduleConfig,
      );
      if (newScheduleConfig) {
        currentDataSet.scheduleConfig = newScheduleConfig;
        await repo.save(currentDataSet);
      }
    }

    if (shouldTriggerAcquisition) {
      try {
        const resp = await workflowEngineClient.post(
          `/api/v1/projects/${safeSegment(projectId)}/datasets/${safeSegment(id)}/acquire`,
          {},
          { timeout: 30000 },
        );
        logger.info(
          `[DataSetService] Acquisition workflow started after update for dataset ${safeLog(id)}: ${safeLog(resp.data?.workflowId)}`,
        );
      } catch (err: any) {
        logger.warn(
          `[DataSetService] Dataset ${safeLog(id)} updated but acquisition workflow failed to start: ${safeLog(err.message)}`,
        );
      }
    }

    // Return updated dataset with catalog info
    return await this.getDataSetWithCatalog(id);
  }

  /**
   * Create or update the draft manifest with uploaded files.
   * This is called when files are uploaded directly to S3 and passed via updateDataSet.
   * The GUI sends the full list of files (existing + new) as the source of truth,
   * so when a draft already exists we replace its file list entirely.
   * For a new manual dataset with no committed manifest yet, we auto-commit the draft
   * so the dataset import workflow is triggered (avoids relying solely on GUI commit).
   */
  private static async updateManifestWithFiles(
    dataSetId: string,
    uploadedFiles: UploadedFileInfo[]
  ): Promise<void> {
    // Import ManifestService dynamically to avoid circular dependencies
    const { ManifestService } = await import('./ManifestService');
    
    // Get existing manifests
    const manifests = await ManifestService.listManifests(dataSetId);
    
    // Find or create a draft manifest
    let draftManifest = manifests.find(m => m.status === 'draft');
    const uris = uploadedFiles.map(f => f.url);

    // Detect files removed by this edit (present in the latest committed
    // manifest's file set but absent from the new list) and best-effort
    // delete their underlying storage objects. Without this, a deleted file's
    // object lingers on disk/S3 and the next import's directory scan finds it
    // again, so the delete never actually reaches the dataset table.
    const latestCommitted = manifests
      .filter(m => m.status === 'committed')
      .sort((a, b) => b.manifestId - a.manifestId)[0];
    if (latestCommitted?.files?.length) {
      const newUriSet = new Set(uris);
      const removedUris = latestCommitted.files
        .map(f => f.uri)
        .filter((uri): uri is string => Boolean(uri) && !newUriSet.has(uri!));
      if (removedUris.length > 0) {
        logger.info(`[DataSetService] Dataset ${dataSetId} edit removed ${removedUris.length} file(s); deleting from storage`);
        ManifestService.deleteS3Objects(removedUris).catch((err) => {
          logger.warn(`[DataSetService] Failed to clean up removed files for dataset ${dataSetId}:`, err);
        });
      }
    }

    if (!draftManifest) {
      // Create a new draft manifest with the file URIs
      logger.info(`[DataSetService] Creating new draft manifest for dataset ${dataSetId} with ${uris.length} files`);
      draftManifest = await ManifestService.createManifest(dataSetId, uris, {});
      logger.info(`[DataSetService] Created draft manifest: ${draftManifest.id}`);
    } else {
      // Replace existing draft manifest files with the full list from the GUI.
      // The GUI sends all files (existing + new) so the backend should set them
      // as the complete file list, not append to existing records.
      logger.info(`[DataSetService] Replacing ${uris.length} files in existing draft manifest ${draftManifest.id}`);
      await ManifestService.replaceManifestFiles(draftManifest.id, uris);
      logger.info(`[DataSetService] Replaced files in draft manifest: ${draftManifest.id}`);
    }

    // Auto-commit when this is the first batch of files for a new dataset (no committed manifest yet).
    // This ensures the dataset import workflow is triggered even if the GUI does not call commit
    // (e.g. manual dataset creation with uploaded files).
    const hasCommitted = manifests.some(m => m.status === 'committed');
    if (!hasCommitted && uris.length > 0) {
      const dataSet = await dataSetRepo().findOne({ where: { id: dataSetId } });
      if (dataSet?.status === 'in_progress') {
        logger.info(`[DataSetService] First batch of files for dataset ${dataSetId}; committing draft to trigger import workflow`);
        ManifestService.updateManifestStatus(draftManifest.id, 'committed').catch((err) => {
          logger.error(`[DataSetService] Failed to auto-commit manifest for dataset ${dataSetId}:`, err);
        });
      }
    }
  }

  /**
   * Delete dataset - triggers async workflow for catalog table and S3 cleanup
   * Then deletes the dataset record from the database
   */
  static async deleteDataSet(id: string, projectId: string): Promise<{ workflowId?: string }> {
    const repo = dataSetRepo();
    
    // Verify dataset exists and belongs to project
    const dataset = await repo.findOne({ where: { id, projectId } });
    if (!dataset) {
      throw new NotFoundError('DataSet', id);
    }
    
    // Terminate any running workflows (acquisition, import, PII) before deletion
    try {
      const { DatasetDeleteService } = await import('./DatasetDeleteService');
      const deleteService = new DatasetDeleteService();
      await deleteService.terminateDatasetWorkflows(projectId, id);
    } catch (error: any) {
      logger.warn(`[DataSetService] Failed to terminate workflows for dataset ${id}: ${error.message}`);
    }

    // Tear down the refresh Temporal schedule (if any) so it doesn't outlive the dataset.
    await this.tearDownSchedule(projectId, id, dataset.scheduleConfig);

    let workflowId: string | null = null;
    
    // Trigger async deletion workflow for catalog table and S3 files
    if (dataset.catalogTableRef && dataset.namespace && dataset.catalogTableName) {
      try {
        const { DatasetDeleteService } = await import('./DatasetDeleteService');
        const deleteService = new DatasetDeleteService();
        
        // Resolve bucket and path prefix from project home_dir
        const projectRepo = new ProjectRepository(AppDataSource);
        const project = await projectRepo.getById(projectId);
        const { bucketName, pathPrefix } = getProjectStorageRoot(project!);
        const warehouseId = (project?.metadata?.warehouseId as string) || projectId;

        workflowId = await deleteService.startDatasetDeletion(
          projectId,
          id,
          dataset.catalogTableName,
          dataset.namespace,
          warehouseId,
          bucketName,
          pathPrefix
        );
        
        logger.info(`[DataSetService] Started dataset deletion workflow for ${id}: ${workflowId}`);
      } catch (error: any) {
        logger.warn(`[DataSetService] Failed to start deletion workflow for dataset ${id}: ${error.message}`);
        logger.warn('[DataSetService] Dataset record will be deleted, but S3/catalog cleanup may be incomplete');
      }
    }
    
    // Delete the dataset record from database
    await repo.delete({ id, projectId });
    logger.info(`[DataSetService] Deleted dataset record: ${id}`);
    
    return { workflowId: workflowId || undefined };
  }

  /**
   * List datasets with filtering and pagination
   */
  static async listDataSets(options: ListDataSetsOptions): Promise<(DataSet & { catalogTable?: any })[]> {
    const { projectId, limit = 20, skip = 0, field, value, nameRegex, includeCatalog = false } = options;
    
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    const repo = dataSetRepo();
    const queryBuilder = repo.createQueryBuilder('ds');
    
    // Always filter by projectId
    queryBuilder.where('ds.projectId = :projectId', { projectId });

    // Apply filters
    if (field && value) {
      queryBuilder.andWhere(`ds.${field} = :value`, { value });
    }

    if (nameRegex) {
      queryBuilder.andWhere('ds.name ILIKE :nameRegex', { nameRegex: `%${nameRegex}%` });
    }

    // Apply pagination
    queryBuilder.skip(Number(skip)).take(Number(limit));
    queryBuilder.orderBy('ds.createdAt', 'DESC');

    const datasets = await queryBuilder.getMany();

    if (datasets.length === 0) return [];

    // Batch-load all facets in a single query instead of N individual queries
    const datasetIds = datasets.map(ds => ds.id);
    const facetMap = await FacetService.listFacetsBatch(projectId, 'dataset', datasetIds);

    // Lazy backfill PII facets where needed, then re-fetch those specific facets
    const backfillPromises: Promise<void>[] = [];
    for (const ds of datasets) {
      const facets = facetMap.get(ds.id) ?? [];
      const hasPiiFacet = facets.some(f => f.facetType === 'pii');
      if (!hasPiiFacet && ds.enablePiiAnalysis && ds.piiSummary) {
        backfillPromises.push(
          FacetService.lazyBackfill(ds.projectId, 'dataset', ds.id, 'pii', ds.piiSummary)
            .then(async (backfilled) => {
              if (backfilled) {
                const refreshed = await FacetService.listFacets(ds.projectId, 'dataset', ds.id);
                facetMap.set(ds.id, refreshed);
              }
            })
        );
      }
    }
    if (backfillPromises.length > 0) await Promise.all(backfillPromises);

    // Catalog metadata (optional, parallelized)
    const catalogMap = new Map<string, CatalogTable>();
    if (includeCatalog) {
      const catalogPromises = datasets
        .filter(ds => ds.catalogTableRef && ds.namespace && ds.catalogTableName)
        .map(async (ds) => {
          try {
            const namespace = ds.namespace!.split('.');
            const table = await catalogService.getTable(namespace, ds.catalogTableName!, ds.warehouseName);
            if (table) catalogMap.set(ds.id, table);
          } catch {
            // ignore
          }
        });
      await Promise.all(catalogPromises);
    }

    return datasets.map(ds => {
      const facets = facetMap.get(ds.id) ?? [];
      const catalogTable = catalogMap.get(ds.id);
      const result = Object.assign({}, ds, { facets, ...(catalogTable ? { catalogTable } : {}) });
      delete (result as any).piiSummary;
      return result;
    });
  }

  /**
   * Restore dataset from history version
   */
  static async restoreDataSetVersion(
    id: string,
    projectId: string,
    version: number
  ): Promise<DataSet & { catalogTable?: any }> {
    const repo = dataSetRepo();
    const dataset = await repo.findOne({ where: { id, projectId } });
    
    if (!dataset) {
      throw new NotFoundError('DataSet', id);
    }

    // Get history version
    const history = await historyRepo().findOne({
      where: { entityId: id, version } as FindOptionsWhere<DataSetHistory>,
    });

    if (!history) {
      throw new NotFoundError('DataSetHistory', `version ${version}`);
    }

    // Restore dataset fields from history
    const restoreData = history.data as any;
    const { id: historyId, createdAt, updatedAt, uploadedFiles, bucketName, fileCount, ...dataToRestore } = restoreData;

    // Update dataset
    Object.assign(dataset, dataToRestore);
    await repo.save(dataset);

    // Note: File restoration would need to recreate Iceberg table snapshots
    // This restore only restores metadata - data restoration would require Iceberg snapshot operations
    return await this.getDataSetWithCatalog(id);
  }

  /**
   * Get dataset history
   */
  static async getDataSetHistory(id: string): Promise<DataSetHistory[]> {
    return await historyRepo().find({
      where: { entityId: id } as FindOptionsWhere<DataSetHistory>,
      order: { version: 'DESC' },
    });
  }


  /**
   * Best-effort capture of a dataset's stats + latest-snapshot summary from the
   * Iceberg catalog. Called once at import completion (status -> ready) so the
   * read paths (list/detail) don't have to hit the catalog per request.
   *
   * Returns an empty object when the dataset has no registered catalog table or
   * when the catalog is unreachable; callers should leave the existing values
   * untouched in that case.
   */
  private static async captureDatasetSummary(
    dataset: DataSet,
  ): Promise<{ stats?: DataSet['stats']; latestSnapshot?: DataSet['latestSnapshot'] }> {
    const num = (v: unknown): number | undefined =>
      v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;

    // Read the Iceberg catalog snapshot (best-effort). A catalog failure here
    // must NOT suppress the manual manifest count computed further below, which
    // does not depend on the catalog at all.
    let latestSnapshot: DataSet['latestSnapshot'] | undefined;
    let rowCount: number | undefined;
    if (dataset.catalogTableRef && dataset.namespace && dataset.catalogTableName) {
      try {
        const namespace = dataset.namespace.split('.');
        const [snapshots, currentSnapshotId] = await Promise.all([
          catalogService.getTableSnapshots(namespace, dataset.catalogTableName, dataset.warehouseName),
          catalogService.getCurrentSnapshotId(namespace, dataset.catalogTableName, dataset.warehouseName),
        ]);

        if (snapshots.length > 0) {
          // Sort oldest -> newest so version numbers are stable across calls.
          const sorted = [...snapshots].sort(
            (a, b) => Number(a['timestamp-ms']) - Number(b['timestamp-ms']),
          );
          const currentIdx =
            currentSnapshotId != null
              ? sorted.findIndex((s) => Number(s['snapshot-id']) === currentSnapshotId)
              : -1;
          const idx = currentIdx >= 0 ? currentIdx : sorted.length - 1;
          const snap = sorted[idx];
          const summary = (snap['summary'] ?? {}) as Record<string, string>;
          rowCount = num(summary['total-records']);
          // Only persist a snapshot summary when the core numerics are valid;
          // otherwise we'd store NaN and downstream `new Date(NaN)` would throw.
          const snapshotId = num(snap['snapshot-id']);
          const timestampMs = num(snap['timestamp-ms']);
          if (snapshotId != null && timestampMs != null) {
            latestSnapshot = {
              snapshotId,
              version: idx + 1,
              timestampMs,
              totalFiles: num(summary['total-data-files']),
              filesAdded: num(summary['added-data-files']),
              filesRemoved: num(summary['deleted-data-files']),
            };
          }
        }
      } catch (err: any) {
        console.warn(
          `[DataSetService] Failed to capture catalog summary for dataset ${safeLog(dataset.id)}: ${safeLog(err?.message ?? String(err))}`,
        );
      }
    }

    // Source-file count: manual datasets are authoritative via the manifest
    // (independent of the catalog); acquired datasets use the snapshot's
    // data-file count.
    let sourceFileCount: number | undefined;
    if (dataset.type === 'manual') {
      try {
        const { ManifestService } = await import('./ManifestService');
        sourceFileCount = await ManifestService.countFiles(dataset.id);
      } catch (err: any) {
        console.warn(
          `[DataSetService] Failed to count manifest files for dataset ${safeLog(dataset.id)}: ${safeLog(err?.message ?? String(err))}`,
        );
      }
    } else {
      sourceFileCount = latestSnapshot?.totalFiles;
    }

    const stats: DataSet['stats'] = {
      ...(sourceFileCount != null ? { sourceFileCount } : {}),
      ...(rowCount != null ? { rowCount } : {}),
    };

    return {
      stats: Object.keys(stats).length > 0 ? stats : undefined,
      latestSnapshot,
    };
  }

  /**
   * Update dataset status
   * Used by workflow to update status after processing
   */
  static async updateDatasetStatus(
    projectId: string,
    datasetId: string,
    status: 'in_progress' | 'ready' | 'errored',
    errorMessage?: string
  ): Promise<DataSet> {
    const repo = dataSetRepo();
    const dataset = await repo.findOne({ where: { id: datasetId, projectId } });

    if (!dataset) {
      throw new NotFoundError('DataSet', datasetId);
    }

    const previousStatus = dataset.status;
    dataset.status = status;
    if (status === 'errored' && errorMessage) {
      dataset.errorMessage = errorMessage;
    } else {
      // Clear previous error when status is ready or in_progress so retrigger success shows no stale error
      dataset.errorMessage = null as any;
    }

    // On import completion, capture a stats + latest-snapshot summary from the
    // catalog so the list/detail endpoints can render files_count and
    // latest_snapshot without reading the Iceberg catalog per request.
    if (status === 'ready') {
      const summary = await this.captureDatasetSummary(dataset);
      if (summary.stats) dataset.stats = summary.stats;
      if (summary.latestSnapshot) dataset.latestSnapshot = summary.latestSnapshot;
    }

    await repo.save(dataset);

    // Fan out KB reprocess for any KB whose synchronizationConfig.sync_mode is
    // 'after_dataset_updates' and whose sourceDataset matches this dataset.
    // Guard with previousStatus to avoid double-firing when both the Go
    // workflow and the Python merge path PUT 'ready'.
    if (status === 'ready' && previousStatus !== 'ready') {
      KnowledgeBaseScheduleService.fanOutAfterDatasetReady(projectId, datasetId).catch((err) => {
        logger.warn(
          `[DataSetService] Fan-out of after_dataset_updates KBs failed for dataset ${safeLog(datasetId)}: ${safeLog(err.message)}`,
        );
      });
    }
    logger.info(`[DataSetService] Dataset ${datasetId} status updated to: ${status}`);

    return dataset;
  }

  /**
   * Update dataset job ID
   * Used to track workflow execution ID
   */
  static async updateDatasetJobId(
    projectId: string,
    datasetId: string,
    jobId: string
  ): Promise<DataSet> {
    const repo = dataSetRepo();
    const dataset = await repo.findOne({ where: { id: datasetId, projectId } });

    if (!dataset) {
      throw new NotFoundError('DataSet', datasetId);
    }

    dataset.jobId = jobId;
    await repo.save(dataset);
    logger.info(`[DataSetService] Dataset ${datasetId} jobId updated to: ${jobId}`);

    return dataset;
  }
}

