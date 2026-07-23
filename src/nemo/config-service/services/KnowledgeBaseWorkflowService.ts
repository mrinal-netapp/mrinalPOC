import { get_logger } from '@agentstudio/observability-client-runtime';
import axios, { AxiosInstance } from 'axios';
import { Not } from 'typeorm';
import { ServiceAccountClient, createServiceAccountClientFromEnv } from '@agentstudio/common';
import { AppDataSource } from '../db/postgres';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { DataSet } from '../models/DataSet';
import { Project } from '../models/Project';
import { getProjectStorageRoot } from '../utils/defaultBucket';
import { safeSegment, safeLog } from '../utils/safeStrings';
import { readProjectVirtualKeyToken } from './bifrost/bifrostProjectGovernance';
import { resolveEmbeddingFields, resolveEmbeddingModelName } from './knowledgeBaseEmbedding';

const logger = get_logger();

const WORKFLOW_ENGINE_URL = process.env.WORKFLOW_ENGINE_URL || 'http://workflow-engine:8080';

const workflowEngineServiceAccountClient: ServiceAccountClient | null =
  createServiceAccountClientFromEnv();
const workflowEngineClient: AxiosInstance = workflowEngineServiceAccountClient
  ? workflowEngineServiceAccountClient.createAuthenticatedClient(WORKFLOW_ENGINE_URL)
  : axios.create({
      baseURL: WORKFLOW_ENGINE_URL,
      headers: { 'Content-Type': 'application/json' },
    });

export type KnowledgeBaseWorkflowSkipReason =
  | 'already_in_progress'
  | 'dataset_not_found'
  | 'dataset_not_ready'
  | 'embedding_model_not_found'
  | 'project_not_found';

export type KnowledgeBaseWorkflowTriggerResult =
  | { ok: true; workflowId: string }
  | { ok: false; reason: KnowledgeBaseWorkflowSkipReason; message: string };

export class KnowledgeBaseWorkflowService {
  private static alreadyInProgressResult(): KnowledgeBaseWorkflowTriggerResult {
    const message =
      'Cannot reprocess while knowledge base is being processed; wait for the current sync to finish.';
    return { ok: false, reason: 'already_in_progress', message };
  }

  /**
   * Start (or restart) the KB creation workflow. Processing overrides are
   * overlaid on the persisted KB row for the workflow input only — they are
   * not written to PostgreSQL here (same contract as POST /:id/create).
   */
  static async triggerCreationWorkflow(
    projectId: string,
    kb: KnowledgeBase,
    options?: {
      overrides?: Record<string, unknown>;
      authorization?: string;
    },
  ): Promise<KnowledgeBaseWorkflowTriggerResult> {
    const overrides = options?.overrides ?? {};
    const kbRepo = AppDataSource.getRepository(KnowledgeBase);

    const freshKb = await kbRepo.findOne({ where: { id: kb.id, projectId } });
    if (!freshKb) {
      throw new Error(`Knowledge base '${kb.id}' not found in project '${projectId}'`);
    }
    if (freshKb.status === 'in_progress') {
      logger.info(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: already in_progress`,
      );
      return this.alreadyInProgressResult();
    }

    const sourceDatasetId =
      (typeof overrides.sourceDataset === 'string' && overrides.sourceDataset.trim()) || freshKb.sourceDataset;
    const datasetRepo = AppDataSource.getRepository(DataSet);
    const dataset = await datasetRepo.findOne({
      where: { id: sourceDatasetId, projectId },
    });
    if (!dataset) {
      const message = `Knowledge base updated but reprocessing workflow not started: source dataset '${sourceDatasetId}' not found`;
      logger.warn(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: source dataset ${safeLog(sourceDatasetId)} not found`,
      );
      return { ok: false, reason: 'dataset_not_found', message };
    }
    if (dataset.status !== 'ready') {
      const message = `Knowledge base updated but reprocessing workflow not started: source dataset status is '${dataset.status}', must be 'ready'`;
      logger.warn(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: source dataset status is '${dataset.status}'`,
      );
      return { ok: false, reason: 'dataset_not_ready', message };
    }

    const projectEntity = await AppDataSource.getRepository(Project).findOne({
      where: { id: projectId },
    });
    if (!projectEntity) {
      const message = `Knowledge base updated but reprocessing workflow not started: project '${projectId}' not found`;
      logger.warn(
        `[KnowledgeBaseWorkflowService] Project ${safeLog(projectId)} missing; aborting workflow for KB ${safeLog(kb.id)}`,
      );
      return { ok: false, reason: 'project_not_found', message };
    }

    const { bucketName, pathPrefix } = getProjectStorageRoot(projectEntity);
    const namespace = projectId;

    const embeddingModelName = resolveEmbeddingModelName(overrides.embeddingModel, freshKb.embeddingModel);
    const embeddingFields = await resolveEmbeddingFields(projectId, overrides, embeddingModelName);
    const hasEmbeddingOverride =
      (typeof overrides.embeddingModelId === 'string' && overrides.embeddingModelId.trim()) ||
      (typeof overrides.embeddingModel === 'string' && overrides.embeddingModel.trim());
    if (hasEmbeddingOverride && !embeddingFields) {
      const requested =
        (typeof overrides.embeddingModelId === 'string' && overrides.embeddingModelId.trim()) ||
        embeddingModelName;
      const message = `Knowledge base updated but reprocessing workflow not started: no embedding model found for '${requested}'`;
      logger.warn(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: embedding model ${safeLog(requested)} not found`,
      );
      return { ok: false, reason: 'embedding_model_not_found', message };
    }

    let projectVirtualKeyToken = '';
    try {
      projectVirtualKeyToken = (await readProjectVirtualKeyToken(projectId)) || '';
    } catch (vkErr: any) {
      logger.warn(
        `[KnowledgeBaseWorkflowService] readProjectVirtualKeyToken failed for project ${safeLog(projectId)}: ${safeLog(vkErr?.message || vkErr)}`,
      );
    }

    const chunkOptions =
      overrides.chunkOptions !== undefined
        ? overrides.chunkOptions
        : freshKb.chunkOptions;
    const quantizationOptions =
      overrides.quantizationOptions !== undefined
        ? overrides.quantizationOptions
        : freshKb.quantizationOptions;

    const chunkStrategy = overrides.chunkStrategy ?? freshKb.chunkStrategy ?? 'fixed';
    const defaultChunkOverlap =
      chunkStrategy === 'sentence' || chunkStrategy === 'token' ? 0 : 50;

    const workflowInput: Record<string, unknown> = {
      projectId,
      knowledgeBaseId: freshKb.id,
      kbName: freshKb.name,
      sourceDatasetId,
      bucketName,
      pathPrefix,
      embeddingModel: embeddingFields?.embeddingModel ?? embeddingModelName,
      chunkSize: overrides.chunkSize ?? freshKb.chunkSize,
      vectorSize: embeddingFields?.embeddingDimensions ?? overrides.vectorSize ?? freshKb.vectorSize,
      dataType: overrides.dataType ?? freshKb.dataType ?? '',
      namespace,
      processingMode: 'full',
      chunkStrategy,
      chunkOverlap: overrides.chunkOverlap ?? freshKb.chunkOverlap ?? defaultChunkOverlap,
      chunkOptions: chunkOptions ? JSON.stringify(chunkOptions) : '',
      indexingMode: overrides.indexingMode ?? freshKb.indexingMode ?? 'hybrid',
      quantizationType: overrides.quantizationType ?? freshKb.quantizationType ?? 'auto',
      quantizationOptions: quantizationOptions ? JSON.stringify(quantizationOptions) : '',
      datasetKind: dataset.kind || 'unstructured',
      catalogTableRef: dataset.catalogTableRef || '',
      textColumns: overrides.textColumns ?? freshKb.textColumns ?? '',
      warehouseId: dataset.warehouseName || 'nemo',
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

    const headers: Record<string, string> = {};
    if (options?.authorization) {
      headers.Authorization = options.authorization;
    }

    const latestKb = await kbRepo.findOne({ where: { id: kb.id, projectId } });
    if (!latestKb) {
      throw new Error(`Knowledge base '${kb.id}' not found in project '${projectId}'`);
    }
    if (latestKb.status === 'in_progress') {
      logger.info(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: in_progress before dispatch`,
      );
      return this.alreadyInProgressResult();
    }
    const priorStatus = latestKb.status;
    const priorProgress = latestKb.progress;
    const priorErrorMessage = latestKb.errorMessage;
    const priorNamespace = latestKb.namespace;
    const priorBucketName = latestKb.bucketName;

    const claimResult = await kbRepo.update(
      { id: kb.id, projectId, status: Not('in_progress') },
      {
        status: 'in_progress',
        namespace,
        bucketName,
        progress: { phase: 'queued', percentage: 0 },
        errorMessage: null as any,
      },
    );
    if (!claimResult.affected) {
      logger.info(
        `[KnowledgeBaseWorkflowService] Skipping workflow for KB ${safeLog(kb.id)}: claim lost to concurrent trigger`,
      );
      return this.alreadyInProgressResult();
    }

    let resp;
    try {
      resp = await workflowEngineClient.post(
        `/api/v1/projects/${safeSegment(projectId)}/knowledgebases/${safeSegment(kb.id)}/create`,
        workflowInput,
        { timeout: 30000, headers },
      );
    } catch (dispatchErr) {
      await kbRepo.update(
        { id: kb.id, projectId, status: 'in_progress' },
        {
          status: priorStatus,
          progress: priorProgress as any,
          errorMessage: priorErrorMessage,
          namespace: priorNamespace,
          bucketName: priorBucketName,
        },
      );
      throw dispatchErr;
    }

    const workflowId = resp.data?.workflowId;
    if (typeof workflowId !== 'string' || workflowId.trim() === '') {
      await kbRepo.update(
        { id: kb.id, projectId, status: 'in_progress' },
        {
          status: priorStatus,
          progress: priorProgress as any,
          errorMessage: priorErrorMessage,
          namespace: priorNamespace,
          bucketName: priorBucketName,
        },
      );
      throw new Error('Workflow engine returned success without a workflowId');
    }

    await kbRepo.update({ id: kb.id, projectId }, {
      jobId: workflowId,
    });

    logger.info(
      `[KnowledgeBaseWorkflowService] KB creation workflow started for ${safeLog(kb.id)} (workflowId=${safeLog(workflowId)})`,
    );
    return { ok: true, workflowId };
  }
}
