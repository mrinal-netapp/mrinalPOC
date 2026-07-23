/**
 * Bifrost gateway admin routes (provider keys).
 */
import { Router, Request, Response } from 'express';
import {
  appendProviderKey,
  deleteProviderKeyById,
  listGatewayModels,
  listGatewayProviders,
  mapLlmProviderToBifrost,
} from '../services/bifrost/bifrostProviderOps';
import { getLLMGatewayClient } from '../services/gatewayClient';

const router = Router();

function requireGateway(_req: Request, res: Response): boolean {
  const client = getLLMGatewayClient();
  if (!client.isEnabled()) {
    res.status(502).json({ error: 'LLM gateway is not configured' });
    return false;
  }
  return true;
}

router.get('/providers', async (_req: Request, res: Response) => {
  if (!requireGateway(_req, res)) return;
  try {
    const data = await listGatewayProviders();
    res.json({
      success: true,
      providers: data.providers,
      total: data.total,
    });
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(502).json({ success: false, message: msg });
  }
});

/**
 * List models configured on the Bifrost gateway (flattened from provider keys).
 * Optional query: ?provider=azure
 */
router.get('/models', async (req: Request, res: Response) => {
  if (!requireGateway(req, res)) return;
  try {
    const filterProvider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    const { models, total, providers } = await listGatewayModels();
    const filtered = filterProvider
      ? models.filter(
          (m) =>
            m.provider === filterProvider ||
            mapLlmProviderToBifrost(filterProvider) === m.provider,
        )
      : models;

    res.json({
      success: true,
      models: filtered,
      total: filtered.length,
      providers,
    });
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
    res.status(502).json({ success: false, message: msg });
  }
});

router.post('/providers/:provider/keys', async (req: Request, res: Response) => {
  if (!requireGateway(req, res)) return;
  const llmProvider = String(req.params.provider);
  const {
    modelId,
    providerModelId,
    apiKey,
    apiBase,
    credentialMetadata,
  } = req.body as {
    modelId: string;
    providerModelId: string;
    apiKey?: string;
    apiBase?: string;
    credentialMetadata?: Record<string, unknown>;
  };

  if (!modelId || !providerModelId) {
    return res.status(400).json({ error: 'modelId and providerModelId are required' });
  }

  try {
    const result = await appendProviderKey({
      llmProvider,
      modelId,
      providerModelId,
      apiKey,
      apiBase,
      credentialMetadata,
    });

    res.status(201).json({
      success: true,
      provider: llmProvider,
      gatewayProvider: result.gatewayProvider,
      keyName: result.keyName,
    });
  } catch (err: any) {
    const status = err.response?.status || 502;
    const msg = err.response?.data?.error?.message || err.response?.data?.detail || err.message;
    res.status(status >= 400 && status < 600 ? status : 502).json({ success: false, message: msg });
  }
});

router.delete('/providers/:provider/keys/:keyId', async (req: Request, res: Response) => {
  if (!requireGateway(req, res)) return;
  const bifrostProvider = mapLlmProviderToBifrost(req.params.provider);
  const { keyId } = req.params;
  try {
    await deleteProviderKeyById(bifrostProvider, keyId);
    res.json({ success: true, provider: bifrostProvider, keyId });
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(502).json({ success: false, message: msg });
  }
});

export default router;
