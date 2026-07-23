import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../db/postgres';
import { DeploymentService } from '../services/DeploymentService';
import { asyncHandler, sendSuccess, sendError } from '../utils/routeHandler';
import {
  CreateDeploymentRequest,
  UpdateDeploymentRequest,
  ErrorResponse,
  BucketConfig,
  DeploymentConfigResponse
} from '../types/deployment';

const router = Router();

// Note: Routes now use DeploymentService for business logic
// Repository access is handled within the service layer

// Deployment registry endpoints
router.post('/api/v1/deployments', asyncHandler(async (req: Request, res: Response) => {
  const requestBody = req.body as CreateDeploymentRequest;
  
  if (!requestBody.id) {
    return sendError(res, new Error('id is required'), 400);
  }

  const deployment = await DeploymentService.registerDeployment(requestBody);
  const statusCode = await DeploymentService.getDeployment(deployment.id) ? 200 : 201;
  sendSuccess(res, deployment, statusCode);
}));

router.get('/api/v1/deployments/:deploymentId', asyncHandler(async (req: Request, res: Response) => {
  const deployment = await DeploymentService.getDeployment(req.params.deploymentId);
  sendSuccess(res, deployment);
}));

router.put('/api/v1/deployments/:deploymentId', asyncHandler(async (req: Request, res: Response) => {
  const requestBody = req.body as UpdateDeploymentRequest;
  const deployment = await DeploymentService.updateDeployment(req.params.deploymentId, requestBody);
  sendSuccess(res, deployment);
}));

router.delete('/api/v1/deployments/:deploymentId', asyncHandler(async (req: Request, res: Response) => {
  await DeploymentService.deleteDeployment(req.params.deploymentId);
  res.status(204).send();
}));

router.get('/api/v1/deployments', asyncHandler(async (req: Request, res: Response) => {
  const deployments = await DeploymentService.listDeployments();
  sendSuccess(res, deployments);
}));

// Configuration distribution endpoints
router.get('/api/v1/deployments/:deploymentId/buckets', asyncHandler(async (req: Request, res: Response) => {
  const deploymentId = req.params.deploymentId;
  const since = req.query.since ? parseInt(req.query.since as string, 10) : 0;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('user-agent') || 'unknown';
  
  logger.info(
    `[Config Sync Request] Deployment: ${deploymentId} | ` +
    `Since version: ${since} | ` +
    `Client IP: ${clientIp} | ` +
    `User-Agent: ${userAgent}`
  );
  
  const config = await DeploymentService.getDeploymentConfig(deploymentId, since);
  
  logger.info(
    `[Config Sync Response] Deployment: ${deploymentId} | ` +
    `Config version: ${config.config_version} | ` +
    `Buckets assigned: ${config.buckets.length} | ` +
    `Requested since: ${since} | ` +
    `Incremental: ${since > 0 ? 'yes' : 'no'}`
  );
  
  sendSuccess(res, config);
}));

router.get('/api/v1/deployments/:deploymentId/config', asyncHandler(async (req: Request, res: Response) => {
  // Same as /buckets endpoint - reuse the handler logic
  const deploymentId = req.params.deploymentId;
  const since = req.query.since ? parseInt(req.query.since as string, 10) : 0;
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.get('user-agent') || 'unknown';
  
  logger.info(
    `[Config Sync Request] Deployment: ${deploymentId} | ` +
    `Since version: ${since} | ` +
    `Client IP: ${clientIp} | ` +
    `User-Agent: ${userAgent}`
  );
  
  const config = await DeploymentService.getDeploymentConfig(deploymentId, since);
  
  logger.info(
    `[Config Sync Response] Deployment: ${deploymentId} | ` +
    `Config version: ${config.config_version} | ` +
    `Buckets assigned: ${config.buckets.length} | ` +
    `Requested since: ${since} | ` +
    `Incremental: ${since > 0 ? 'yes' : 'no'}`
  );
  
  sendSuccess(res, config);
}));

// Routing endpoints
router.get('/api/v1/buckets/:projectId/:bucketName/routing', asyncHandler(async (req: Request, res: Response) => {
  const routing = await DeploymentService.getBucketRouting(
    req.params.projectId,
    req.params.bucketName
  );
  sendSuccess(res, routing);
}));

// Health & Metrics endpoints
router.post('/api/v1/deployments/:deploymentId/metrics', asyncHandler(async (req: Request, res: Response) => {
  await DeploymentService.submitMetrics(req.params.deploymentId, req.body);
  sendSuccess(res, { status: 'accepted' });
}));

router.post('/api/v1/deployments/:deploymentId/health', asyncHandler(async (req: Request, res: Response) => {
  await DeploymentService.submitHealthReport(req.params.deploymentId, req.body);
  sendSuccess(res, { status: 'accepted' });
}));

router.get('/api/v1/projects/:projectId/buckets/:bucketName/health', asyncHandler(async (req: Request, res: Response) => {
  // This endpoint is not yet implemented in DeploymentService
  // For now, return a simple response
  sendSuccess(res, { bucket_health: [] });
}));

// StorageClass endpoints
router.get('/api/v1/storage-classes', asyncHandler(async (req: Request, res: Response) => {
  // Get all active deployments
  const deployments = await DeploymentService.listDeployments();
  
  // Aggregate StorageClasses from all active deployments
  const storageClassSet = new Set<string>();
  
  // Collect StorageClasses from all active deployments
  for (const deployment of deployments) {
    if (deployment.status === 'healthy' || deployment.status === 'unknown') {
      if (deployment.storage_classes && deployment.storage_classes.length > 0) {
        deployment.storage_classes.forEach(sc => storageClassSet.add(sc));
      }
    }
  }
  
  // Convert to array and sort alphabetically
  const storageClasses = Array.from(storageClassSet);
  storageClasses.sort((a, b) => a.localeCompare(b));
  
  // Format as StorageClass objects with name and provisioner
  const storageClassList = storageClasses.map(name => ({
    name,
    provisioner: getProvisionerForStorageClass(name)
  }));
  
  sendSuccess(res, { storage_classes: storageClassList });
}));

function getProvisionerForStorageClass(name: string): string {
  // Map common StorageClass names to their provisioners
  const provisionerMap: Record<string, string> = {
    'local-path': 'rancher.io/local-path',
    'openebs-hostpath': 'openebs.io/local',
    'topolvm-provisioner': 'topolvm.cybozu.com',
    'ebs-gp3': 'ebs.csi.aws.com',
    'ebs-gp2': 'ebs.csi.aws.com',
    'ebs-io1': 'ebs.csi.aws.com',
  };
  
  return provisionerMap[name] || 'unknown';
}

// Helper functions removed - now using DeploymentService methods
// assignBucketToDeployments -> DeploymentService.assignBucketToDeployments()
// reassignBucketsForDeployment -> DeploymentService.reassignBucketsForDeployment()

export default router;

