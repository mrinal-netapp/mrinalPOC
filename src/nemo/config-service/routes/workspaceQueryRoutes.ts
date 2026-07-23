import 'reflect-metadata';
import { Router, Request } from 'express';
import { WorkspaceService } from '../services/WorkspaceService';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';

const router = Router();

/**
 * Query endpoint for the workspace orchestrator to poll for workspaces to manage
 * GET /api/v1/workspaces?status=new,creating,stopping&deploymentId=nemo&deploymentType=nemo
 */
router.get('/', asyncHandler(async (req, res) => {
  const { status, deploymentId, deploymentType } = req.query;

  // Parse status - can be comma-separated string or array
  let statusArray: string[] | undefined;
  if (status) {
    if (typeof status === 'string') {
      statusArray = status.split(',').map(s => s.trim()).filter(s => s);
    } else if (Array.isArray(status)) {
      statusArray = status.map(s => String(s).trim()).filter(s => s);
    }
  }

  // Validate deploymentType
  if (deploymentType && deploymentType !== 'nemo') {
    return sendError(res, new Error('Invalid deploymentType. Must be "nemo"'), 400);
  }

  const workspaces = await WorkspaceService.queryWorkspacesForManagement({
    status: statusArray,
    deploymentId: deploymentId ? String(deploymentId) : undefined,
    deploymentType: deploymentType ? (deploymentType as 'nemo') : undefined,
  });

  // Transform workspaces to include template and s3Config for the workspace orchestrator
  const transformedWorkspaces = workspaces.map(ws => ({
    id: ws.id,
    projectId: ws.projectId,
    templateId: ws.templateId,
    name: ws.name,
    status: ws.status,
    bucketName: ws.bucketName,
    podName: ws.podName,
    pvcName: ws.pvcName,
    deploymentId: ws.deploymentId,
    deploymentType: 'nemo',
    template: ws.template ? {
      id: ws.template.id,
      projectId: ws.template.projectId,
      name: ws.template.name,
      type: ws.template.type,
      environment: ws.template.environment,
      resources: ws.template.resources,
    } : undefined,
    s3Config: ws.bucketName ? {
      bucketName: ws.bucketName,
      // Note: S3 credentials should be retrieved from environment or secrets
      // For now, the workspace orchestrator will need to get these separately
      accessKey: process.env.S3_ACCESS_KEY || '',
      secretKey: process.env.S3_SECRET_KEY || '',
      endpoint: process.env.S3_ENDPOINT,
    } : undefined,
  }));

  sendSuccess(res, transformedWorkspaces);
}));

export default router;

