import { Router, Request, Response } from 'express';
import { getAllProviders, getProvider } from '../services/ProviderCatalogService';

const router = Router();

router.get('/providers', async (_req: Request, res: Response) => {
  try {
    const providers = getAllProviders();
    res.json({ providers });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load provider catalog' });
  }
});

router.get('/providers/:providerId', async (req: Request, res: Response) => {
  try {
    const provider = getProvider(req.params.providerId);
    if (!provider) {
      return res.status(404).json({ error: `Provider '${req.params.providerId}' not found` });
    }
    res.json(provider);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load provider' });
  }
});

export default router;
