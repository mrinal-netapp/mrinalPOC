import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import 'reflect-metadata';
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { AppDataSource } from '../db/postgres';
import { Model } from '../models/Model';
import { ModelHistory } from '../models/history/ModelHistory';
import { createModelValidator, updateModelValidator } from '../validators/modelValidator';
import { validationResult } from 'express-validator';
import { Request, Response } from 'express';
import { Not, QueryFailedError } from 'typeorm';
import { ConflictError } from '../utils/errors';
import { sendErrorResponse } from '../utils/errorHandler';
import { isPostgresUniqueViolation } from '../utils/pgErrors';
import { getCredentialService } from '../services/CredentialService';
import { getProviderRegistry } from '../providers/registry';
import { getStaticModelMetadata } from '../providers/staticMetadata';
import { getModelPricingDefault } from '../catalog/modelPricingCatalog';
import {
  enrichModelInfoFromCatalog,
  getKnownEmbeddingModelInfo,
} from '../providers/embeddingDimensions';
import { getLLMGatewayClient } from '../services/gatewayClient';
import {
  buildGatewayBindingName,
  buildGatewayModelId,
  mapLlmProviderToBifrost,
} from '../services/bifrost/bifrostProviderOps';
import { getLogStats, getLogTokenSplit } from '../services/bifrost/bifrostOps';
import {
  readProjectVirtualKeyToken,
  resolveProjectVirtualKeyId,
} from '../services/bifrost/bifrostProjectGovernance';
import {
  assignModelGovernance,
  removeModelGovernance,
  type ModelGovernanceLimits,
} from '../services/bifrost/bifrostProjectGovernance';
import { ChatMessage, BifrostModelParams } from '../services/LLMGatewayClient';
import { upsertProvider, providerDisplayName } from '../services/ModelProviderService';
import { safeLog } from '../utils/safeStrings';
import {
  applyForEntity,
  removeForSource,
  hasDependents,
  summaryForTargets,
  listDependents,
} from '../services/ReferenceEdgeService';
import { ensureKbEmbeddingModelReferenceEdgesIfMissing } from '../services/ReferenceEdgeReconciler';
import { requireProjectInitForCreate } from '../utils/projectInitGuard';

const router = Router({ mergeParams: true });
const MAX_INFER_MESSAGES = 64;
const MAX_INFER_MESSAGE_LENGTH = 20000;

// Defaults mirror the Bifrost provider PUT (concurrency_and_buffer_size).
const DEFAULT_PROVIDER_CONCURRENCY = 1000;
const DEFAULT_PROVIDER_BUFFER_SIZE = 5000;

/**
 * Optimistically seed the provider's health cache row as `connected` once a
 * model has been registered against it (Bifrost + DB already written by the
 * time this runs), so the Providers overview shows it green without waiting
 * for a manual Refresh. Best-effort: a cache-write failure must never fail the
 * request — the provider is still surfaced live from the credentials/models
 * derivation. No-ops when the model carries no provider id.
 */
async function cacheProjectProvider(
  projectId: string,
  provider?: string,
  proxyConfig?: { concurrency?: number; bufferSize?: number },
): Promise<void> {
  if (!provider) return;
  const concurrency =
    typeof proxyConfig?.concurrency === 'number' && proxyConfig.concurrency > 0
      ? proxyConfig.concurrency
      : DEFAULT_PROVIDER_CONCURRENCY;
  const bufferSize =
    typeof proxyConfig?.bufferSize === 'number' && proxyConfig.bufferSize > 0
      ? proxyConfig.bufferSize
      : DEFAULT_PROVIDER_BUFFER_SIZE;
  try {
    await upsertProvider({
      projectId,
      providerId: provider,
      name: providerDisplayName(provider),
      concurrency,
      bufferSize,
      connectionStatus: 'connected',
    });
  } catch (provErr) {
    logger.warn(
      `[modelRoutes] provider cache upsert failed for ${safeLog(provider)}: ${safeLog(
        (provErr as Error).message,
      )}`,
    );
  }
}

/**
 * @swagger
 * components:
 *  schemas:
 *    Model:
 *      type: object
 *      properties:
 *        name:
 *          type: string
 *        displayName:
 *          type: string
 *        provider:
 *          type: string
 *          enum: [openai, openai_compatible, aws_bedrock, azure, google, local]
 *        providerModelId:
 *          type: string
 *        credentialId:
 *          type: string
 *          format: uuid
 *        modelType:
 *          type: string
 *          enum: [llm, embedding]
 *        model_info:
 *          type: object
 *          properties:
 *            architecture:
 *              type: string
 *            base_model:
 *              type: string
 *            variant:
 *              type: string
 *            parameters:
 *              type: string
 *            quantization:
 *              type: string
 *            size:
 *              type: number
 *        endpoint:
 *          type: string
 *        auth:
 *          type: object
 *          properties:
 *            access_token:
 *              type: string
 *            secret_key:
 *              type: string
 *        limits:
 *          type: object
 *          properties:
 *            tpm:
 *              type: number
 *            timeout:
 *              type: number
 *            stream_timeout:
 *              type: number
 *            max_retries:
 *              type: number
 *        rateCardOverride:
 *          type: object
 *        createdAt:
 *          type: string
 *          format: date-time
 *        updatedAt:
 *          type: string
 *          format: date-time
 *      required:
 *        - name
 * tags:
 *   name: Model
 *   description: Model management
 */

/**
 * @swagger
 * /api/v1/projects/{projectId}/models:
 *   post:
 *     summary: Create a new Model
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Model'
 *     responses:
 *       201:
 *         description: Model created
 *       400:
 *         description: Validation error
 */
router.post('/', createModelValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  // Block user POST until the project's gateway-setup activity has run.
  // Without it, the project has no Bifrost virtual key and BifrostGatewayClient
  // cannot assign newly-created models to one — the model row would land in
  // the DB but be unreachable through the gateway. Built-in seeding also
  // happens during gateway-setup, so this guard also prevents racing
  // BuiltinModelsService.seedBuiltinsForProject.
  if (!(await requireProjectInitForCreate(req, res))) return;
  try {
    const { projectId } = req.params;
    const {
      provider,
      credentialId,
      providerModelId,
      providerDeploymentName,
      endpoint,
      concurrentRequests,
      bufferSize,
    } =
      req.body as {
        provider?: string;
        credentialId?: string;
        providerModelId?: string;
        providerDeploymentName?: string;
        endpoint?: string;
        concurrentRequests?: unknown;
        bufferSize?: unknown;
      };
    const parsedConcurrentRequests =
      typeof concurrentRequests === 'number'
        ? concurrentRequests
        : Number.parseInt(String(concurrentRequests ?? ''), 10);
    const parsedBufferSize =
      typeof bufferSize === 'number'
        ? bufferSize
        : Number.parseInt(String(bufferSize ?? ''), 10);
    const proxyConfig = {
      concurrency:
        Number.isFinite(parsedConcurrentRequests) && parsedConcurrentRequests > 0
          ? parsedConcurrentRequests
          : undefined,
      bufferSize:
        Number.isFinite(parsedBufferSize) && parsedBufferSize > 0
          ? parsedBufferSize
          : undefined,
    };
    const modelName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const modelRepo = AppDataSource.getRepository(Model);
    const existingByName = await modelRepo.findOne({ where: { projectId, name: modelName } });
    if (existingByName) {
      throw new ConflictError('Model with this name already exists in this project');
    }

    const llmgateway = getLLMGatewayClient();
    const remoteProviders = ['openai', 'openai_compatible', 'aws_bedrock', 'azure', 'google'];

    if (llmgateway.isEnabled()) {
      if (provider && remoteProviders.includes(provider) && !credentialId) {
        return res.status(400).json({ error: `credentialId is required for provider ${provider}` });
      }
      if (provider === 'ollama' && !endpoint) {
        return res.status(400).json({ error: 'endpoint is required for ollama provider' });
      }

      const providerParams: BifrostModelParams = {
        model: `openai/${providerModelId || req.body.name}`,
      };

      let credentialMetadata: Record<string, unknown> | undefined;
      let credentialName: string | undefined;
      if (credentialId) {
        const credService = getCredentialService();
        const credential = await credService.getById(projectId, credentialId);
        if (!credential) {
          return res.status(404).json({ error: 'Credential not found' });
        }
        credentialName = credential.name;
        const secretData = await credService.readSecretData(projectId, credentialId);
        if (!secretData) {
          return res.status(500).json({ error: 'Failed to read credential secret' });
        }

        if (secretData.api_key) {
          providerParams.api_key = secretData.api_key;
        }

        // Google Vertex AI authenticates with a service-account JSON, carried
        // through to Bifrost's `vertex_key_config.auth_credentials`. Kept on
        // provider_params (transient, sent to the gateway) so the secret never
        // lands on the persisted Model row. Empty => ADC / IAM role auth.
        if (secretData.service_account_json) {
          providerParams.auth_credentials = secretData.service_account_json;
        }

        const apiBase = credential.metadata?.endpoint || credential.metadata?.api_base;
        if (apiBase) {
          providerParams.api_base = apiBase;
        }
        credentialMetadata = credential.metadata as Record<string, unknown> | undefined;
      }

      if (provider === 'ollama' && endpoint) {
        providerParams.api_base = endpoint;
        delete providerParams.api_key;
      }

      const modelId = randomUUID();

      const effectiveProviderModelId = providerModelId || req.body.name;
      // For Azure the deployment URL path uses the deployment name, which can
      // be distinct from the model id we route on. Fall back to the model id
      // when the caller has not specified one (identity mapping).
      const effectiveDeploymentName =
        providerDeploymentName || effectiveProviderModelId;

      // Resolve embedding-model dimensions before persist. Without this,
      // the KB workflow later silently falls back to 384-d (see
      // knowledgeBaseRoutes.resolveEmbeddingFields) and creates a
      // mis-dimensioned LanceDB index. The cascade is:
      //   1. Caller-supplied `model_info.dimensions` (wizard override) wins.
      //   2. Otherwise enrich from the static catalog
      //      (providers/embeddingDimensions.ts).
      //   3. If still missing, fail loudly — do NOT default — because
      //      wrong dimensions corrupt the vector index.
      let resolvedModelInfo: Record<string, unknown> | undefined =
        req.body.model_info && typeof req.body.model_info === 'object'
          ? { ...(req.body.model_info as Record<string, unknown>) }
          : undefined;
      if (req.body.modelType === 'embedding') {
        const userDim =
          typeof resolvedModelInfo?.dimensions === 'number' && (resolvedModelInfo.dimensions as number) > 0
            ? (resolvedModelInfo!.dimensions as number)
            : undefined;
        if (userDim === undefined) {
          // Strip an invalid 0/negative before enrich so the catalog can
          // populate. Without this, enrichModelInfoFromCatalog's "set if
          // missing" logic would treat 0 as set and skip the fill.
          if (resolvedModelInfo && typeof resolvedModelInfo.dimensions === 'number' && (resolvedModelInfo.dimensions as number) <= 0) {
            delete resolvedModelInfo.dimensions;
          }
          resolvedModelInfo = enrichModelInfoFromCatalog(
            resolvedModelInfo,
            provider,
            effectiveProviderModelId,
          ) as Record<string, unknown>;
        }
        const finalDim =
          typeof resolvedModelInfo?.dimensions === 'number' && (resolvedModelInfo.dimensions as number) > 0
            ? (resolvedModelInfo.dimensions as number)
            : undefined;
        if (finalDim === undefined) {
          logger.warn(
            `[modelRoutes] Rejecting embedding model registration: ` +
            `provider=${safeLog(provider)} providerModelId=${safeLog(effectiveProviderModelId)} ` +
            `— no model_info.dimensions and no static catalog match.`,
          );
          return res.status(400).json({
            error:
              `Embedding model ${effectiveProviderModelId} has no known vector dimensions. ` +
              `Provide model_info.dimensions in the request (the RegisterModelWizard "Dimensions" field), ` +
              `or extend providers/embeddingDimensions.ts to add it to the static catalog.`,
            code: 'EMBEDDING_DIMENSIONS_REQUIRED',
          });
        }
      }
      // Unique Bifrost routing identifier so two credentials in the same
      // project can register the same upstream model without colliding on
      // the routing rule CEL or the VK allowed_models list.
      const gatewayBindingNameValue = buildGatewayBindingName(
        projectId,
        credentialId,
        effectiveProviderModelId,
        // Pass provider so openai_compatible gets the bare providerModelId
        // (Bifrost forwards it verbatim to the upstream proxy after the
        // as-openai-compat-<short>/ prefix strip — see buildGatewayBindingName).
        provider,
      );
      // Bake the provider prefix Bifrost requires (`<bifrost-provider>/<model>`)
      // at registration time, so downstream callers don't recompute it. Built
      // from the binding name so the prefix and routing id stay in sync.
      // For `openai_compatible` this resolves to `as-openai-compat-<short>/<binding>`
      // (per-credential custom Bifrost provider), NOT `openai/<binding>` —
      // see bifrostProviderOps.ts for why. credentialId is enforced for all
      // remote providers up at the validation block (`remoteProviders` check),
      // so by the time we reach this call openai_compatible is guaranteed
      // to have one — buildGatewayModelId's lenient `openai/` fallback is
      // never taken on the registration path.
      const gatewayModelIdValue = buildGatewayModelId(provider, gatewayBindingNameValue, credentialId);

      logger.info(
        `[modelRoutes] Registering model in Bifrost gateway: id=${safeLog(modelId)} provider=${safeLog(provider)} ` +
        `providerModelId=${safeLog(effectiveProviderModelId)} ` +
        `gatewayBindingName=${safeLog(gatewayBindingNameValue)} ` +
        `gatewayModelId=${safeLog(gatewayModelIdValue)} ` +
        (effectiveDeploymentName !== effectiveProviderModelId
          ? `providerDeploymentName=${safeLog(effectiveDeploymentName)} `
          : '') +
        `credential=${safeLog(credentialName || credentialId || '(none)')} ` +
        `api_base=${safeLog(providerParams.api_base || '(none)')} has_api_key=${!!providerParams.api_key}`,
      );

      const llmGatewayRegistration = await llmgateway.addModel({
        model_name: modelId,
        provider_params: providerParams,
        model_info: {
          id: modelId,
          provider,
          providerModelId: effectiveProviderModelId,
          providerDeploymentName: effectiveDeploymentName,
          gatewayBindingName: gatewayBindingNameValue,
          gatewayModelId: gatewayModelIdValue,
          modelType: req.body.modelType,
          credentialId,
          credentialName,
          projectId,
          credentialMetadata,
          // Per-model budget + rate limit, applied to the project VK as a
          // Bifrost model-config. Validated by createModelValidator.
          rpm: req.body.rpm,
          tpm: req.body.tpm,
          spendingLimit: req.body.spendingLimit,
          spendingLimitPeriod: req.body.spendingLimitPeriod,
          concurrentRequests: proxyConfig.concurrency,
          bufferSize: proxyConfig.bufferSize,
          // Surface embedding catalog fields (dimensions / chunk hint /
          // category / description) into Bifrost's own catalog so any
          // downstream consumer reading the gateway's model registry
          // sees the same values we persisted on the Model row.
          ...(req.body.modelType === 'embedding' && resolvedModelInfo
            ? {
                dimensions: resolvedModelInfo.dimensions,
                recommendedChunkSize: resolvedModelInfo.recommendedChunkSize,
                category: resolvedModelInfo.category,
                description: resolvedModelInfo.description,
              }
            : {}),
        },
      });

      const rateCardOverride =
        llmGatewayRegistration && typeof llmGatewayRegistration === 'object'
          ? {
              ...(req.body.rateCardOverride || {}),
              _gateway: {
                provider: 'bifrost',
                ...llmGatewayRegistration,
              },
            }
          : req.body.rateCardOverride;

      const model = modelRepo.create({
        ...req.body,
        id: modelId,
        projectId,
        name: modelName,
        providerDeploymentName: effectiveDeploymentName !== effectiveProviderModelId
          ? effectiveDeploymentName
          : req.body.providerDeploymentName,
        gatewayBindingName: gatewayBindingNameValue,
        gatewayModelId: gatewayModelIdValue,
        ...(rateCardOverride ? { rateCardOverride } : {}),
        // Persist the dimension-resolved model_info (overrides the
        // ...req.body spread when the embedding cascade ran above).
        ...(resolvedModelInfo ? { model_info: resolvedModelInfo } : {}),
      });
      try {
        await modelRepo.save(model);
      } catch (saveErr) {
        if (isPostgresUniqueViolation(saveErr)) {
          throw new ConflictError('Model with this name already exists in this project');
        }
        throw saveErr;
      }
      await cacheProjectProvider(projectId, provider, proxyConfig);
      await applyForEntity(undefined, 'model', projectId, model);
      logger.info(`[modelRoutes] Model created: id=${modelId} name=${req.body.name}`);
      return res.status(201).json(model);
    }

    // Non-gateway path (LLM gateway disabled — e.g. local-only deployments).
    // Apply the same dimension cascade as the gateway path so the persisted
    // row always carries model_info.dimensions for embedding models.
    let nonGatewayModelInfo: Record<string, unknown> | undefined =
      req.body.model_info && typeof req.body.model_info === 'object'
        ? { ...(req.body.model_info as Record<string, unknown>) }
        : undefined;
    if (req.body.modelType === 'embedding') {
      const userDim =
        typeof nonGatewayModelInfo?.dimensions === 'number' && (nonGatewayModelInfo.dimensions as number) > 0
          ? (nonGatewayModelInfo!.dimensions as number)
          : undefined;
      if (userDim === undefined) {
        if (nonGatewayModelInfo && typeof nonGatewayModelInfo.dimensions === 'number' && (nonGatewayModelInfo.dimensions as number) <= 0) {
          delete nonGatewayModelInfo.dimensions;
        }
        nonGatewayModelInfo = enrichModelInfoFromCatalog(
          nonGatewayModelInfo,
          provider,
          providerModelId || modelName,
        ) as Record<string, unknown>;
      }
      const finalDim =
        typeof nonGatewayModelInfo?.dimensions === 'number' && (nonGatewayModelInfo.dimensions as number) > 0
          ? (nonGatewayModelInfo.dimensions as number)
          : undefined;
      if (finalDim === undefined) {
        return res.status(400).json({
          error:
            `Embedding model ${providerModelId || modelName} has no known vector dimensions. ` +
            `Provide model_info.dimensions in the request, or extend providers/embeddingDimensions.ts.`,
          code: 'EMBEDDING_DIMENSIONS_REQUIRED',
        });
      }
    }
    const model = modelRepo.create({
      ...req.body,
      projectId,
      name: modelName,
      ...(nonGatewayModelInfo ? { model_info: nonGatewayModelInfo } : {}),
    });
    try {
      await modelRepo.save(model);
    } catch (saveErr) {
      if (isPostgresUniqueViolation(saveErr)) {
        throw new ConflictError('Model with this name already exists in this project');
      }
      throw saveErr;
    }
    await cacheProjectProvider(projectId, provider, proxyConfig);
    await applyForEntity(undefined, 'model', projectId, model);
    res.status(201).json(model);
  } catch (err) {
    if (err instanceof ConflictError) {
      return sendErrorResponse(res, err);
    }
    if (isPostgresUniqueViolation(err)) {
      return sendErrorResponse(
        res,
        new ConflictError('Model with this name already exists in this project')
      );
    }
    const error = err as Error;
    console.error('[modelRoutes] POST /models failed:', safeLog(error.message));
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models:
 *   get:
 *     summary: Get all Models for a project
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of models
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const where: Record<string, string> = { projectId };
    if (req.query.modelClass) where.modelClass = req.query.modelClass as string;
    if (req.query.modelType) where.modelType = req.query.modelType as string;
    const models = await repo.find({ where, order: { createdAt: 'DESC' } });

    // Default-on; clients pass ?include=dependentsSummary=false to opt out.
    const includeSummary = (req.query.include as string | undefined) !== 'dependentsSummary=false';
    if (!includeSummary || models.length === 0) {
      return res.json(models);
    }
    await ensureKbEmbeddingModelReferenceEdgesIfMissing(projectId);
    const summary = await summaryForTargets('model', projectId, models.map((m) => m.id));
    const enriched = models.map((m) => ({
      ...m,
      dependentsSummary: summary.get(m.id) ?? { total: 0, byKind: {} },
    }));
    res.json(enriched);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/list-available:
 *   post:
 *     summary: List available models from a provider
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider]
 *             properties:
 *               provider:
 *                 type: string
 *                 enum: [openai, openai_compatible, aws_bedrock, azure, google, local]
 *               credentialId:
 *                 type: string
 *                 format: uuid
 *               type:
 *                 type: string
 *                 enum: [llm, embedding]
 *     responses:
 *       200:
 *         description: List of available models from the provider
 *       400:
 *         description: Invalid request
 */
router.post('/list-available', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const { provider, credentialId, type } = req.body;

    if (!provider) {
      return res.status(400).json({ error: 'provider is required' });
    }

    const registry = getProviderRegistry();
    if (!registry.has(provider)) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    let credentials: Record<string, string> = {};
    let metadata: Record<string, any> | undefined;

    // For remote providers, resolve credential to get secret data
    if (credentialId) {
      const credService = getCredentialService();
      const credential = await credService.getById(projectId, credentialId);
      if (!credential) {
        return res.status(404).json({ error: 'Credential not found' });
      }
      metadata = credential.metadata || undefined;

      const secretData = await credService.readSecretData(projectId, credentialId);
      if (!secretData) {
        return res.status(500).json({ error: 'Failed to read credential secret' });
      }
      credentials = secretData;
    }

    const models = await registry.listModels(
      provider,
      credentials,
      metadata,
      type as 'llm' | 'embedding' | undefined
    );

    // Stamp known embedding dimensions onto each model so the
    // RegisterModelWizard can prefill its "Dimensions" input without
    // duplicating the catalog client-side. Provider adapters (e.g.
    // openai.ts:listModels) can't fill this because /v1/models doesn't
    // return dimensions — see providers/embeddingDimensions.ts.
    for (const m of models) {
      if (m.type === 'embedding' && m.dimensions === undefined) {
        const known = getKnownEmbeddingModelInfo(provider, m.id);
        if (known) {
          m.dimensions = known.dimensions;
        }
      }
    }

    res.json({ provider, models });
  } catch (err: any) {
    logger.error('[modelRoutes] list-available error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/classes:
 *   get:
 *     summary: List distinct model classes in this project
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of distinct modelClass strings
 */
router.get('/classes', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const rows: { modelClass: string }[] = await AppDataSource.getRepository(Model)
      .createQueryBuilder('model')
      .select('DISTINCT model.modelClass', 'modelClass')
      .where('model.projectId = :projectId', { projectId })
      .andWhere('model.modelClass IS NOT NULL')
      .orderBy('model.modelClass', 'ASC')
      .getRawMany();
    res.json(rows.map(r => r.modelClass));
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/pricing-defaults:
 *   get:
 *     summary: Default (list) pricing for a provider model, per 1M tokens
 *     description: >
 *       Resolves the Bifrost Model Catalog list price for a `(provider, model)`
 *       so the Add-model UI can show a default price hint. Returns
 *       `pricing: null` when the model is not in the catalog (custom/self-hosted
 *       or newly released models). This is the provider list price, not the
 *       project's negotiated/effective rate.
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: provider
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: model
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pricing found, or `{ pricing: null }` when unknown
 *       400:
 *         description: Missing provider or model
 */
router.get('/pricing-defaults', async (req: Request, res: Response) => {
  try {
    const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
    const model = typeof req.query.model === 'string' ? req.query.model.trim() : '';
    if (!provider || !model) {
      return res
        .status(400)
        .json({ error: 'Both "provider" and "model" query parameters are required.' });
    }
    const pricing = await getModelPricingDefault(provider, model);
    return res.json({ provider, model, pricing });
  } catch (err) {
    const error = err as Error;
    return res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}:
 *   get:
 *     summary: Get a Model by ID
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Model found
 *       404:
 *         description: Model not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const model = await repo.findOne({ where: { id, projectId } });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    const staticMeta = getStaticModelMetadata(model.provider, model.providerModelId);
    // Backfill gatewayModelId for legacy rows that pre-date the column so
    // callers (agent-service runtime, infer fallback) can rely on the field
    // being present without re-onboarding every existing model. Stored value
    // wins when present.
    const gatewayModelId =
      model.gatewayModelId
      || (model.providerModelId
        ? buildGatewayModelId(model.provider, model.providerModelId, model.credentialId)
        : undefined);

    // Fetch the project's Bifrost virtual-key bearer token so agent-service
    // can authenticate per-project (team-scoped routing, future budgets/RL).
    // Failures are tolerated here - readProjectVirtualKeyToken returns
    // undefined when neither the K8s Secret nor the metadata mirror has a
    // value, in which case agent-service will fail-loud on the runtime side
    // with a clearer error than the gateway would produce. We do not surface
    // K8s/Bifrost errors as 5xx on this read endpoint because the model
    // metadata itself is fine and callers that don't need the gateway token
    // (e.g. the GUI's model detail page) should still get it.
    // `gatewayApiKey` is the project's Bifrost virtual-key bearer token — a
    // secret. Only the SERVICE lane (agent-service / eval-worker resolving the
    // token to authenticate to Bifrost) needs it; the GUI model page does not.
    // The unified guard sets `req.agentStudioContext` on the USER lane and
    // leaves it unset on the service lane, so we return the token only when
    // there is no user context. (When the guard is disabled the field is
    // returned as before — no behavior change until the guard is enabled.)
    const isUserLane = !!(req as { agentStudioContext?: unknown }).agentStudioContext;
    let gatewayApiKey: string | undefined;
    if (!isUserLane) {
      try {
        gatewayApiKey = await readProjectVirtualKeyToken(projectId);
      } catch (err: any) {
        console.warn(
          `[modelRoutes] GET /:id: failed to load VK token for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
        );
      }
    }

    res.json({
      ...model,
      gatewayModelId,
      ...(gatewayApiKey ? { gatewayApiKey } : {}),
      contextWindow: staticMeta?.contextWindow,
      maxOutputTokens: staticMeta?.maxOutputTokens,
      supportsExtendedOutput: staticMeta?.supportsExtendedOutput,
    });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}/infer:
 *   post:
 *     summary: Run chat inference using a registered LLM model
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [role, content]
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [system, user, assistant]
 *                     content:
 *                       type: string
 *               temperature:
 *                 type: number
 *               maxTokens:
 *                 type: number
 *     responses:
 *       200:
 *         description: Model inference result
 *       400:
 *         description: Validation error
 *       404:
 *         description: Model not found
 *       422:
 *         description: Model is not an LLM
 */
router.post('/:id/infer', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const { messages, temperature, maxTokens } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages must be a non-empty array' });
    }
    if (messages.length > MAX_INFER_MESSAGES) {
      return res.status(400).json({ error: `messages exceeds max length (${MAX_INFER_MESSAGES})` });
    }

    const validRoles = new Set(['system', 'user', 'assistant']);
    const normalizedMessages: ChatMessage[] = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        return res.status(400).json({ error: 'each message must be an object' });
      }
      if (!validRoles.has(m.role)) {
        return res.status(400).json({ error: `invalid message role: ${m.role}` });
      }
      if (typeof m.content !== 'string' || m.content.length === 0) {
        return res.status(400).json({ error: 'message content must be a non-empty string' });
      }
      if (m.content.length > MAX_INFER_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message content exceeds max length (${MAX_INFER_MESSAGE_LENGTH})` });
      }
      normalizedMessages.push({ role: m.role, content: m.content });
    }

    if (temperature != null && (typeof temperature !== 'number' || Number.isNaN(temperature))) {
      return res.status(400).json({ error: 'temperature must be a number' });
    }
    if (maxTokens != null && (!Number.isInteger(maxTokens) || maxTokens <= 0)) {
      return res.status(400).json({ error: 'maxTokens must be a positive integer' });
    }

    const repo = AppDataSource.getRepository(Model);
    const model = await repo.findOne({ where: { id, projectId } });
    if (!model) {
      return res.status(404).json({ error: 'Model not found' });
    }
    if (model.modelType && model.modelType !== 'llm') {
      return res.status(422).json({ error: 'Only LLM models support inference' });
    }

    const llmgateway = getLLMGatewayClient();
    if (!llmgateway.isEnabled()) {
      return res.status(502).json({ error: 'LLM gateway is not configured' });
    }

    const inferPayload = {
      messages: normalizedMessages,
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
    };

    // Bifrost expects the provider-prefixed gateway model id on the wire
    // (e.g. `azure/<binding>` or `openai/gpt-4o`), not the AgentStudio
    // UUID. Prefer the value stored at registration (`gatewayModelId`)
    // and compute it from `providerModelId` for legacy rows that
    // pre-date that column.
    //
    // The previous revision had a UUID fallback for rows that were
    // registered against a UUID-keyed Bifrost routing rule. That
    // fallback was removed alongside the routing-rule machinery in
    // `bifrostOps.ts` / `BifrostGatewayClient.addModel` -- without a
    // per-model rule, the UUID retry is guaranteed to fail with
    // "provider is required", so it'd just turn one failing request
    // into two.
    const wireModelId =
      model.gatewayModelId
      || (model.providerModelId
        ? buildGatewayModelId(model.provider, model.providerModelId, model.credentialId)
        : null);
    if (!wireModelId) {
      return res.status(422).json({
        error:
          'Model is missing both gatewayModelId and providerModelId; cannot infer ' +
          'a wire-form model id for Bifrost. Re-register the model.',
      });
    }

    // Load the project's Bifrost virtual-key bearer so the playground
    // call carries the SAME credential agent-service would use at
    // runtime. The cluster master key was used here previously, which
    // bypassed team-scoped routing rules, per-project budgets / rate-
    // limits, and audit. 503 (not 502) when the VK isn't available
    // because the situation is "this project's gateway resource isn't
    // ready yet" (e.g. ProjectInitWorkflow Step 0 hasn't completed,
    // K8s Secret was deleted out of band) -- transient by nature, the
    // GUI may want to surface "retry later".
    let projectVk: string | undefined;
    try {
      projectVk = await readProjectVirtualKeyToken(projectId);
    } catch (err: any) {
      console.warn(
        `[modelRoutes] /:id/infer: readProjectVirtualKeyToken failed for project ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
      );
    }
    if (!projectVk) {
      return res.status(503).json({
        error:
          `No Bifrost virtual-key token available for project ${projectId}. ` +
          'The project gateway setup may not have completed yet -- retry, ' +
          'or check that ProjectInitWorkflow Step 0 has finished.',
      });
    }

    const t0 = Date.now();
    const result = await llmgateway.chatCompletion(
      { model: wireModelId, ...inferPayload },
      { apiKey: projectVk },
    );
    const latencyMs = Date.now() - t0;

    return res.json({
      response: result.response,
      latencyMs,
      modelName: result.modelName || model.displayName || model.name,
      usage: result.usage,
    });
  } catch (err: any) {
    const status = err?.status;
    const detail = err?.message || 'Inference failed';
    if (status === 408 || status === 504) {
      return res.status(504).json({ error: detail });
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(502).json({ error: detail });
    }
    return res.status(502).json({ error: detail });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}:
 *   put:
 *     summary: Update a Model by ID (display fields only; credential/endpoint changes require delete + re-register)
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Model'
 *     responses:
 *       200:
 *         description: Model updated
 *       400:
 *         description: Validation error
 *       404:
 *         description: Model not found
 */
router.put('/:id', updateModelValidator, async (req: Request, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { projectId, id } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const model = await repo.findOne({ where: { id, projectId } });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    // Built-ins are system-managed: only the human-facing `displayName` can
    // be edited. Anything else (provider, providerModelId, isBuiltin itself,
    // credential reference, model_info, ...) would either de-sync the row
    // from its Bifrost provider key or shadow the seeded values when the
    // startup backfill runs next. Build a clean update body containing
    // ONLY displayName (allow-list), so future validator additions that
    // inject derived keys can't accidentally bypass this guard.
    if (model.isBuiltin) {
      const offending = Object.keys(req.body as Record<string, unknown>).filter(
        (k) => k !== 'displayName',
      );
      if (offending.length > 0) {
        return res.status(400).json({
          error: `Cannot modify ${offending.join(', ')} on a built-in model. Only displayName is editable.`,
          code: 'BUILTIN_MODEL_IMMUTABLE',
          allowedFields: ['displayName'],
        });
      }
      // Clamp req.body to the allow-list before it reaches the update path
      // below (defense-in-depth in case a future linter coerces additional
      // fields onto req.body).
      const displayName = (req.body as Record<string, unknown>).displayName;
      (req as { body: Record<string, unknown> }).body =
        displayName !== undefined ? { displayName } : {};
    }

    const updateBody = { ...req.body } as Record<string, unknown>;
    if (typeof updateBody.name === 'string') {
      updateBody.name = updateBody.name.trim();
      const taken = await repo.findOne({
        where: { projectId, name: updateBody.name as string, id: Not(id) },
      });
      if (taken) {
        throw new ConflictError('Model with this name already exists in this project');
      }
    }
    try {
      await repo.update({ id, projectId }, updateBody as Record<string, unknown>);
    } catch (updErr) {
      if (isPostgresUniqueViolation(updErr)) {
        throw new ConflictError('Model with this name already exists in this project');
      }
      throw updErr;
    }
    const updated = await repo.findOne({ where: { id, projectId } });
    if (updated) {
      // Keep Bifrost per-model governance (model-configs) in sync when
      // limits are edited on an existing model.
      const governanceBindingName =
        updated.gatewayBindingName || updated.providerModelId || updated.name;
      const governanceProvider = mapLlmProviderToBifrost(updated.provider);
      const governanceLimits: ModelGovernanceLimits = {
        rpm: updated.rpm,
        tpm: updated.tpm,
        spendingLimit: updated.spendingLimit,
        spendingLimitPeriod: updated.spendingLimitPeriod,
      };
      const hasAnyGovernanceLimit =
        (typeof governanceLimits.rpm === 'number' && governanceLimits.rpm > 0) ||
        (typeof governanceLimits.tpm === 'number' && governanceLimits.tpm > 0) ||
        (typeof governanceLimits.spendingLimit === 'number' &&
          governanceLimits.spendingLimit > 0);

      if (governanceBindingName && governanceProvider) {
        try {
          if (hasAnyGovernanceLimit) {
            await assignModelGovernance(
              projectId,
              { provider: governanceProvider, modelName: governanceBindingName },
              governanceLimits,
            );
          } else {
            await removeModelGovernance(projectId, {
              provider: governanceProvider,
              modelName: governanceBindingName,
            });
          }
        } catch (govErr) {
          logger.warn(
            `[modelRoutes] PUT /models/${safeLog(id)} governance sync failed: ${safeLog(
              (govErr as Error).message,
            )}`,
          );
        }
      }
      await applyForEntity(undefined, 'model', projectId, updated);
    }
    res.json(updated);
  } catch (err) {
    if (err instanceof ConflictError) {
      return sendErrorResponse(res, err);
    }
    if (isPostgresUniqueViolation(err)) {
      return sendErrorResponse(
        res,
        new ConflictError('Model with this name already exists in this project')
      );
    }
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}:
 *   delete:
 *     summary: Delete a Model by ID
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Model deleted
 *       404:
 *         description: Model not found
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const model = await repo.findOne({ where: { id, projectId } });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    // Built-ins are system-managed; the startup backfill would just re-seed
    // them on the next config-service restart. Reject the deletion so the
    // user gets a clear signal rather than confusion about why the model
    // re-appears.
    if (model.isBuiltin) {
      return res.status(400).json({
        error:
          'Cannot delete a built-in model. Built-in catalog entries are system-managed and will be re-seeded on every service restart.',
        code: 'BUILTIN_MODEL_IMMUTABLE',
      });
    }

    // Pre-check: anything in the edge table pointing here?
    if (await hasDependents('model', projectId, id)) {
      const page = await listDependents('model', projectId, id, { limit: 50 });
      return res.status(409).json({
        error:
          'Cannot delete this model because it is still in use. Update or remove those references, then try again.',
        code: 'HAS_DEPENDENTS',
        dependents: page,
      });
    }

    const llmgateway = getLLMGatewayClient();
    if (llmgateway.isEnabled()) {
      const gatewayMeta = model.rateCardOverride?._gateway as
        | {
            gatewayProvider?: string;
            keyName?: string;
            credentialId?: string;
          }
        | undefined;

      // Resolve the credential's secret so deleteModel can re-send the key
      // value when trimming one model off a shared, multi-model provider key.
      // Bifrost's keys PUT is full-replace and blanks the write-only value
      // unless we provide it, which would otherwise strand the stale binding
      // in the key's models[]/aliases.
      let credentialApiKey: string | undefined;
      const deleteCredentialId = gatewayMeta?.credentialId || model.credentialId;
      if (deleteCredentialId) {
        try {
          const secretData = await getCredentialService().readSecretData(
            projectId,
            deleteCredentialId,
          );
          if (secretData?.api_key) credentialApiKey = secretData.api_key;
        } catch (credErr) {
          logger.warn(
            `[modelRoutes] delete: could not read credential secret for ${deleteCredentialId}: ${(credErr as Error).message}`,
          );
        }
      }

      await llmgateway.deleteModel(id, {
        gatewayProvider: gatewayMeta?.gatewayProvider,
        keyName: gatewayMeta?.keyName,
        providerModelId: model.providerModelId || model.name,
        // Pass the stored binding name when present so deleteModel removes the
        // entry that's actually in Bifrost (new project__cred__model scheme).
        // Falls back to providerModelId inside deleteModel for legacy rows.
        gatewayBindingName: model.gatewayBindingName,
        credentialId: deleteCredentialId,
        currentApiKey: credentialApiKey,
        projectId,
        provider: model.provider,
      });
    }

    await removeForSource(undefined, 'model', projectId, id);
    await repo.delete({ id, projectId });
    res.status(204).send();
  } catch (err) {
    // FK violations remain a defense-in-depth final guard, but the
    // pre-check above should make this branch unreachable for any kind
    // covered by the catalog.
    if (err instanceof QueryFailedError) {
      const code = (err.driverError as { code?: string } | undefined)?.code;
      if (code === '23503') {
        return res.status(409).json({
          error:
            'Cannot delete this model because it is still in use. Update or remove those references, then try again.',
          code: 'HAS_DEPENDENTS',
        });
      }
    }
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}/dependents:
 *   get:
 *     summary: List entities that depend on this model (paginated)
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *       - in: query
 *         name: kind
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Page of dependents
 */
router.get('/:id/dependents', async (req: Request, res: Response) => {
  try {
    const { projectId, id } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const exists = await repo.findOne({ where: { id, projectId }, select: { id: true } as any });
    if (!exists) return res.status(404).json({ error: 'Model not found' });

    await ensureKbEmbeddingModelReferenceEdgesIfMissing(projectId);

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = (req.query.cursor as string | undefined) || undefined;
    const kind = (req.query.kind as string | undefined) || undefined;
    const page = await listDependents('model', projectId, id, { limit, cursor, kind });
    res.json(page);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}/stats:
 *   get:
 *     summary: Usage statistics (cost / requests / latency / success rate) for a Model
 *     description: >
 *       Aggregates this model's traffic from Bifrost's logs store. Returns an
 *       `available: false` payload with zeroed metrics when the gateway logs
 *       store is disabled or unreachable, so callers can render gracefully.
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: days
 *         required: false
 *         description: Rolling window in days. Omit for all retained logs (<=90d).
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Usage statistics
 *       404:
 *         description: Model not found
 */
router.get('/:id/stats', async (req: Request, res: Response) => {
  const emptyStats = (available: boolean) => ({
    requests: 0,
    totalTokens: 0,
    totalCost: 0,
    averageLatencyMs: 0,
    successRate: null as number | null,
    available,
  });
  try {
    const { projectId, id } = req.params;
    const repo = AppDataSource.getRepository(Model);
    const model = await repo.findOne({ where: { id, projectId } });
    if (!model) return res.status(404).json({ error: 'Model not found' });

    // Optional rolling window; omit for all retained logs (Bifrost keeps 90d).
    const days = req.query.days ? Number(req.query.days) : undefined;
    const startTime =
      days && Number.isFinite(days) && days > 0
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    // Bifrost logs each request keyed by `provider` (the bifrost provider name,
    // e.g. `azure`) and `model` (the BARE upstream model id, e.g. `gpt-5.4`) —
    // NOT the project-scoped binding name (that lives in a separate `alias`
    // field the stats filter can't query). Since a bare provider/model pair is
    // shared across projects, we also scope by the project's virtual-key id so
    // one project's page doesn't include another's traffic for the same model.
    const bifrostProvider = mapLlmProviderToBifrost(model.provider, model.credentialId);
    const providerModelId = model.providerModelId;
    if (!providerModelId) {
      // No upstream model id to filter on (legacy/incomplete row) — nothing
      // reliable to aggregate.
      return res.json(emptyStats(false));
    }

    let virtualKeyIds: string | undefined;
    try {
      virtualKeyIds = await resolveProjectVirtualKeyId(projectId);
    } catch (err: any) {
      // VK lookup is best-effort; without it we fall back to provider+model
      // scoping (may over-count if the same model is registered in another
      // project). Log and continue rather than failing the whole read.
      logger.warn(
        `[modelRoutes] GET /:id/stats: could not resolve project VK for ${safeLog(projectId)}: ${safeLog(err?.message || err)}`,
      );
    }

    try {
      const stats = await getLogStats({
        providers: bifrostProvider,
        models: providerModelId,
        virtualKeyIds,
        startTime,
      });
      const successRate =
        stats.user_facing_success_rate != null
          ? stats.user_facing_success_rate
          : stats.success_rate;

      // Cost: Bifrost logs a per-request cost from its own built-in pricing
      // table, which is keyed by canonical model names. Custom deployment ids
      // (e.g. an Azure deployment named "gpt-4.1-mini-model") have no entry, so
      // Bifrost records a zero cost and can't recompute it after the fact. When
      // the model carries operator-configured per-1M rates, price the traffic
      // from those instead so the "Cost" metric agrees with the per-1M rates
      // shown on the page. Only kicks in when Bifrost's own figure is zero, so
      // models it prices correctly are left untouched.
      let totalCost = stats.total_cost;
      const inRate = model.inputCostPer1M;
      const outRate = model.outputCostPer1M;
      const hasConfiguredRate =
        (inRate != null && inRate >= 0) || (outRate != null && outRate >= 0);
      if (
        totalCost <= 0 &&
        hasConfiguredRate &&
        stats.total_requests > 0 &&
        stats.total_tokens > 0
      ) {
        try {
          const split = await getLogTokenSplit({
            providers: bifrostProvider,
            models: providerModelId,
            virtualKeyIds,
            startTime,
          });
          // Split the authoritative aggregate token total into input/output
          // using the sampled ratio (default to all-input if the sample lacks
          // token usage), then price each side at its configured rate.
          const sampled = split.promptTokens + split.completionTokens;
          const inputFraction = sampled > 0 ? split.promptTokens / sampled : 1;
          const inputTokens = stats.total_tokens * inputFraction;
          const outputTokens = stats.total_tokens - inputTokens;
          const effIn = inRate ?? outRate ?? 0;
          const effOut = outRate ?? inRate ?? 0;
          totalCost = (inputTokens * effIn + outputTokens * effOut) / 1_000_000;
        } catch (err: any) {
          // Sampling failed — keep Bifrost's own (zero) cost rather than fail.
          logger.warn(
            `[modelRoutes] GET /:id/stats: token-split sampling failed for model ${safeLog(id)}: ${safeLog(err?.message || err)}`,
          );
        }
      }

      res.json({
        requests: stats.total_requests,
        totalTokens: stats.total_tokens,
        totalCost,
        averageLatencyMs: stats.average_latency,
        // Only report a success rate when there is traffic to base it on;
        // otherwise a synthetic 0%/100% would be misleading.
        successRate: stats.total_requests > 0 ? successRate : null,
        available: true,
      });
    } catch (err: any) {
      // Logs store disabled / gateway unreachable — return a zeroed, explicitly
      // "unavailable" payload instead of a 5xx so the detail page still renders.
      logger.warn(
        `[modelRoutes] GET /:id/stats: bifrost log stats unavailable for model ${safeLog(id)}: ${safeLog(err?.message || err)}`,
      );
      res.json(emptyStats(false));
    }
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}/history:
 *   get:
 *     summary: Get history of a Model
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Model history
 */
router.get('/:id/history', async (req: Request, res: Response) => {
  try {
    const repo = AppDataSource.getRepository(ModelHistory);
    const history = await repo.find({
      where: { entityId: req.params.id },
      order: { version: 'DESC' },
    });
    res.json(history);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/v1/projects/{projectId}/models/{id}/restore-version:
 *   post:
 *     summary: Restore a Model to a previous version
 *     tags: [Model]
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: number
 *     responses:
 *       200:
 *         description: Model restored
 *       404:
 *         description: Model or version not found
 */
router.post('/:id/restore-version', async (req: Request, res: Response) => {
  const { version } = req.body;
  if (!version || typeof version !== 'number') {
    return res.status(400).json({ error: 'version (number) is required in body' });
  }
  try {
    const { projectId, id } = req.params;
    const historyRepo = AppDataSource.getRepository(ModelHistory);
    const modelRepo = AppDataSource.getRepository(Model);
    const history = await historyRepo.findOne({
      where: { entityId: id, version },
    });
    if (!history) return res.status(404).json({ error: 'Version not found in history' });
    
    const { data } = history;
    const { id: _id, createdAt, updatedAt, ...restoreData } = data;
    
    await modelRepo.update({ id, projectId }, restoreData);
    const updated = await modelRepo.findOne({ where: { id, projectId } });
    if (!updated) return res.status(404).json({ error: 'Model not found' });
    res.json({ restored: true, data: updated });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
