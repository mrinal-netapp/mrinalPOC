/**
 * Per-project model provider routes.
 *
 *   GET  /api/v1/projects/:projectId/providers               — pure DB read.
 *   POST /api/v1/projects/:projectId/providers/refresh       — pull live state
 *                                                              from Bifrost,
 *                                                              update connection
 *                                                              status only.
 *   PUT  /api/v1/projects/:projectId/providers/:providerId   — edit the
 *                                                              provider's proxy
 *                                                              tuning
 *                                                              (concurrency +
 *                                                              bufferSize).
 *
 * Connection status is derived from Bifrost by the refresh route; concurrency
 * and bufferSize are owned by the model-registration write path and the proxy
 * edit route below (both persist to the `model_providers` cache and best-effort
 * sync the Bifrost provider config).
 */
import { Router, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import {
  listProjectProviders,
  refreshProjectProvidersFromBifrost,
  updateProviderProxyConfig,
} from '../services/ModelProviderService';
import { updateProviderProxyValidator } from '../validators/providerValidator';
import { safeConsoleError } from '../utils/safeStrings';

const router = Router();

router.get('/api/v1/projects/:projectId/providers', async (req: Request, res: Response) => {
  try {
    const providers = await listProjectProviders(req.params.projectId);
    res.json({ success: true, providers, total: providers.length });
  } catch (err: any) {
    safeConsoleError(
      '[modelProviderRoutes] List failed for project',
      req.params.projectId,
      err?.message || err,
    );
    res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

router.post(
  '/api/v1/projects/:projectId/providers/refresh',
  async (req: Request, res: Response) => {
    try {
      const providers = await refreshProjectProvidersFromBifrost(req.params.projectId);
      res.json({ success: true, providers, total: providers.length });
    } catch (err: any) {
      const upstream = err?.response?.status;
      const status =
        typeof upstream === 'number' && upstream >= 400 && upstream < 600 ? upstream : 502;
      const message =
        err?.response?.data?.error?.message ||
        err?.response?.data?.detail ||
        err?.message ||
        String(err);
      safeConsoleError(
        '[modelProviderRoutes] Refresh failed for project',
        req.params.projectId,
        message,
      );
      res.status(status).json({ success: false, message });
    }
  },
);

router.put(
  '/api/v1/projects/:projectId/providers/:providerId',
  updateProviderProxyValidator,
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }
    try {
      const { projectId, providerId } = req.params;
      const { concurrentRequests, bufferSize } = req.body as {
        concurrentRequests: number;
        bufferSize: number;
      };
      const provider = await updateProviderProxyConfig(
        projectId,
        providerId,
        Number(concurrentRequests),
        Number(bufferSize),
      );
      res.json({ success: true, provider });
    } catch (err: any) {
      safeConsoleError(
        '[modelProviderRoutes] Proxy-config update failed for project',
        req.params.projectId,
        req.params.providerId,
        err?.message || err,
      );
      res.status(500).json({ success: false, message: err?.message || String(err) });
    }
  },
);

export default router;
