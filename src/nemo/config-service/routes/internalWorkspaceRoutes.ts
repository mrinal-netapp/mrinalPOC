import 'reflect-metadata';
import { Router, Request } from 'express';
import { WorkspaceService } from '../services/WorkspaceService';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';

const router = Router();

/**
 * Internal endpoint for orchestrator to update workspace status
 * PUT /api/v1/internal/workspaces/:id/status
 */
router.put('/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const projectId = req.query.projectId as string;
  
  if (!projectId || !id) {
    return sendError(res, new Error('projectId and id are required'), 400);
  }

  const { status, podName, pvcName, endpoint, errorMessage } = req.body;
  if (!status || !['running', 'stopped', 'error', 'creating'].includes(status)) {
    return sendError(res, new Error('Invalid status'), 400);
  }

  const workspace = await WorkspaceService.updateWorkspaceStatus(id, projectId, status, {
    podName,
    pvcName,
    endpoint,
    errorMessage,
  });

  sendSuccess(res, workspace);
}));

export default router;

