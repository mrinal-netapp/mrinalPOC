/**
 * Bifrost governance proxy routes (virtual keys, budgets, model rate limits).
 */
import { Router, Request, Response } from 'express';
import {
  createModelConfig,
  createVirtualKey,
  deleteModelConfig,
  deleteVirtualKey,
  listBudgets,
  listModelConfigs,
  listRateLimits,
  listVirtualKeys,
  updateModelConfig,
  updateVirtualKey,
} from '../services/bifrost/bifrostOps';
const router = Router();

function gatewayError(res: Response, err: any): void {
  const status = err.response?.status || 502;
  const msg =
    err.response?.data?.error?.message ||
    err.response?.data?.detail ||
    err.message ||
    'Gateway request failed';
  res.status(status >= 400 && status < 600 ? status : 502).json({ success: false, message: msg });
}

router.get('/virtual-keys', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listVirtualKeys() });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.post('/virtual-keys', async (req: Request, res: Response) => {
  try {
    res.status(201).json({ success: true, data: await createVirtualKey(req.body) });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.put('/virtual-keys/:vkId', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await updateVirtualKey(req.params.vkId, req.body) });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.delete('/virtual-keys/:vkId', async (req: Request, res: Response) => {
  try {
    await deleteVirtualKey(req.params.vkId);
    res.status(204).send();
  } catch (err) {
    gatewayError(res, err);
  }
});

router.get('/budgets', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listBudgets() });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.get('/rate-limits', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listRateLimits() });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.get('/model-configs', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listModelConfigs() });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.post('/model-configs', async (req: Request, res: Response) => {
  try {
    res.status(201).json({ success: true, data: await createModelConfig(req.body) });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.put('/model-configs/:configId', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      data: await updateModelConfig(req.params.configId, req.body),
    });
  } catch (err) {
    gatewayError(res, err);
  }
});

router.delete('/model-configs/:configId', async (req: Request, res: Response) => {
  try {
    await deleteModelConfig(req.params.configId);
    res.status(204).send();
  } catch (err) {
    gatewayError(res, err);
  }
});

export default router;
