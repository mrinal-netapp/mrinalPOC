import 'reflect-metadata';
import { Router, Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { AppDataSource } from '../db/postgres';
import { DataSourceRepository } from '../repositories/DataSourceRepository';
import { scanCallbackValidator } from '../validators/dataSourceValidator';
import { ErrorResponse, ScanResult, ScanStatus } from '../types/dataSource';
import { safeLog } from '../utils/safeStrings';

/**
 * Internal admin endpoints for the workflow-engine to push DataSource state
 * back into config-service. Mounted at `/api/v1/internal/datasources` and
 * intended for service-account callers only (auth is enforced by the
 * shared auth middleware at the app level).
 */
const router = Router();

function getRepo(): DataSourceRepository {
  return new DataSourceRepository(AppDataSource);
}

/**
 * PATCH /api/v1/internal/datasources/:projectId/:id/scan-result
 *
 * Called by the workflow-engine when a VolumeScanWorkflow completes (or
 * fails). The body carries the final `scan_status` and, on success, the
 * computed `scan_result`. Persisted via `DataSourceRepository.updateScanState`.
 */
router.patch(
  '/:projectId/:id/scan-result',
  scanCallbackValidator,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        const details = errors.array().map((e: any) => e.path ? `${e.path}: ${e.msg}` : e.msg).join(', ');
        return res.status(400).json({ error: details, code: 'VALIDATION_ERROR' } as ErrorResponse);
      }

      const { projectId, id } = req.params as { projectId: string; id: string };
      const repo = getRepo();

      const current = await repo.get(projectId, id);
      if (!current) {
        return res.status(404).json({ error: 'Data source not found', code: 'NOT_FOUND' } as ErrorResponse);
      }
      if (current.type !== 'volume') {
        return res.status(400).json({
          error: 'scan-result callback applies only to volume data sources',
          code: 'INVALID_REQUEST',
        } as ErrorResponse);
      }

      const scan_status = req.body.scan_status as ScanStatus;
      const scan_result = req.body.scan_result as ScanResult | undefined;

      const updated = await repo.updateScanState(projectId, id, {
        scan_status,
        scan_result,
      });

      console.log(
        `[Scan Callback] ${safeLog(projectId)}/${safeLog(id)} state=${safeLog(scan_status.state)}` +
          (scan_result ? ` files=${scan_result.total_files} folders=${scan_result.total_folders}` : '')
      );

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({
        error: error.message || 'Failed to persist scan result',
        code: 'INTERNAL_ERROR',
      } as ErrorResponse);
    }
  }
);

export default router;
