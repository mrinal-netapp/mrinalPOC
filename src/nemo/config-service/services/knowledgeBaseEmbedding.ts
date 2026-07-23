import { get_logger } from '@agentstudio/observability-client-runtime';
import { AppDataSource } from '../db/postgres';
import { Model } from '../models/Model';
import { getKnownEmbeddingModelInfo } from '../providers/embeddingDimensions';
import { safeLog } from '../utils/safeStrings';

const logger = get_logger();

/** Treat empty/whitespace-only string overrides as not provided. */
export function resolveEmbeddingModelName(override: unknown, persisted: string): string {
  if (typeof override !== 'string') return persisted;
  const trimmed = override.trim();
  return trimmed || persisted;
}

export type ResolvedEmbeddingFields = {
  embeddingModelId: string;
  embeddingModel: string;
  embeddingProvider: string;
  embeddingProviderModelId: string;
  embeddingEndpoint: string;
  embeddingDimensions: number;
  embeddingGatewayModelId: string;
};

/**
 * Resolve the embedding-model identity to forward into the KB-creation workflow.
 */
export async function resolveEmbeddingFields(
  projectId: string,
  body: Record<string, unknown>,
  kbEmbeddingModel: string,
): Promise<ResolvedEmbeddingFields | null> {
  const modelRepo = AppDataSource.getRepository(Model);

  const requestedId =
    typeof body.embeddingModelId === 'string' ? body.embeddingModelId.trim() : '';
  let model = requestedId
    ? await modelRepo.findOne({ where: { id: requestedId, projectId } })
    : null;

  if (!model && kbEmbeddingModel) {
    model = await modelRepo.findOne({ where: { projectId, name: kbEmbeddingModel } });
  }
  if (!model || model.modelType !== 'embedding') {
    return null;
  }

  const info = (model.model_info as Record<string, unknown> | undefined) || {};
  let dimensions: number | undefined =
    typeof info.dimensions === 'number' && info.dimensions > 0 ? info.dimensions : undefined;
  if (dimensions === undefined) {
    dimensions = getKnownEmbeddingModelInfo(model.provider, model.providerModelId)?.dimensions;
  }
  if (dimensions === undefined) {
    logger.error(
      `[knowledgeBaseEmbedding] Refusing KB workflow: model ${safeLog(model.id)} ` +
        `(${safeLog(model.provider)}/${safeLog(model.providerModelId)}) has no ` +
        `model_info.dimensions and no static catalog match.`,
    );
    return null;
  }

  return {
    embeddingModelId: model.id,
    embeddingModel: model.name,
    embeddingProvider: model.provider || 'openai_compatible',
    embeddingProviderModelId: model.providerModelId || model.name,
    embeddingEndpoint: model.endpoint || (info.endpoint as string | undefined) || '',
    embeddingDimensions: dimensions,
    embeddingGatewayModelId: model.gatewayModelId || '',
  };
}
