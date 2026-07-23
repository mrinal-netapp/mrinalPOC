import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { getRepositoryFactory } from '../repositories/RepositoryFactory';
import { BaseService } from './BaseService';
import { DeploymentService } from './DeploymentService';
import { RoutingDeploymentInfo } from '../types/deployment';
import { isDefaultBucket, getDefaultBucketDeploymentId } from '../utils/defaultBucket';
import { deploymentEndpointToS3GatewayUrl } from '../utils/s3Utils';

/**
 * Service for resolving deployment endpoints for buckets.
 *
 * With the unified bucket routing model, the default (global) bucket is
 * resolved via env (DEFAULT_BUCKET_DEPLOYMENT_ID) or the first healthy
 * deployment, without requiring a per-project assignment.
 */
export class DeploymentEndpointService extends BaseService {
  /**
   * Get primary deployment endpoint for a bucket.
   *
   * For the *default bucket* (global, provisioned by Helm):
   *   - Uses DEFAULT_BUCKET_DEPLOYMENT_ID env, or the first registered deployment.
   *   - Ignores projectId (the default bucket is not project-scoped).
   *
   * For project-scoped buckets:
   *   - Uses the existing assignment-based routing.
   */
  static async getPrimaryDeploymentEndpoint(
    projectId: string,
    bucketName: string,
    protocol: 'http' | 'https' = 'https'
  ): Promise<string | null> {
    // ---- Global / default bucket fast path ----
    if (isDefaultBucket(bucketName)) {
      const endpoint = await this.resolveDefaultBucketEndpoint(protocol);
      if (endpoint) {
        return endpoint;
      }
      // Fall through to assignment-based routing if no global config
    }

    // ---- Assignment-based routing (project-scoped buckets) ----
    const factory = getRepositoryFactory();
    const assignmentRepo = factory.assignmentRepo;
    const deploymentRepo = factory.deploymentRepo;
    const healthReportRepo = factory.healthReportRepo;

    const assignments = await assignmentRepo.listByBucket(projectId, bucketName, 'active');

    if (assignments.length === 0) {
      // If this is the default bucket, try resolving globally
      if (isDefaultBucket(bucketName)) {
        return this.resolveDefaultBucketEndpoint(protocol);
      }
      return null;
    }

    // Build routing deployments list
    const routingDeployments: RoutingDeploymentInfo[] = [];
    for (const assignment of assignments) {
      const deployment = await deploymentRepo.getById(assignment.deployment_id);
      if (!deployment) {
        continue;
      }

      const healthReport = await healthReportRepo.getByDeploymentId(assignment.deployment_id);
      const healthStatus = DeploymentService.evaluateDeploymentHealthStatus(
        healthReport ? { healthy: healthReport.healthy, timestamp: healthReport.timestamp } : null,
        deployment
      );

      if (healthStatus === 'unhealthy' && deployment.status !== 'unhealthy') {
        deploymentRepo.updateStatus(assignment.deployment_id, 'unhealthy').catch((error) => {
          logger.warn(`[Health Timeout] Failed to update deployment ${assignment.deployment_id} status: ${error.message}`);
        });
      }

      routingDeployments.push({
        deployment_id: assignment.deployment_id,
        role: assignment.role,
        priority: assignment.priority,
        endpoint: deployment.endpoint,
        http_endpoint: deployment.http_endpoint,
        health_status: healthStatus,
        load_balance_weight: assignment.load_balance_weight || 100,
        last_health_check: healthReport?.timestamp || deployment.last_health_check || new Date().toISOString()
      });
    }

    return this.selectBestEndpoint(routingDeployments, protocol);
  }

  // ---- Private helpers ----

  /**
   * Resolve the deployment endpoint for the global default bucket.
   *
   * Strategy:
   *   1. If DEFAULT_BUCKET_DEPLOYMENT_ID env is set, use that deployment.
   *   2. Otherwise fall back to the first healthy registered deployment.
   */
  private static async resolveDefaultBucketEndpoint(
    protocol: 'http' | 'https'
  ): Promise<string | null> {
    const factory = getRepositoryFactory();
    const deploymentRepo = factory.deploymentRepo;

    // Try explicit deployment ID from env
    const deploymentId = getDefaultBucketDeploymentId();
    if (deploymentId) {
      const deployment = await deploymentRepo.getById(deploymentId);
      if (deployment) {
        return this.pickEndpoint(deployment, protocol);
      }
      logger.warn(`[DeploymentEndpointService] DEFAULT_BUCKET_DEPLOYMENT_ID=${deploymentId} not found`);
    }

    // Fallback: first registered deployment
    const allDeployments = await deploymentRepo.list();
    if (allDeployments.length > 0) {
      // Prefer healthy deployments
      const healthy = allDeployments.filter((d: any) => d.status !== 'unhealthy');
      const chosen = healthy.length > 0 ? healthy[0] : allDeployments[0];
      return this.pickEndpoint(chosen, protocol);
    }

    return null;
  }

  /**
   * Pick http or https endpoint from a deployment.
   */
  private static pickEndpoint(
    deployment: { endpoint: string; http_endpoint?: string },
    protocol: 'http' | 'https'
  ): string {
    if (protocol === 'http' && deployment.http_endpoint) {
      return deployment.http_endpoint;
    }
    return deployment.endpoint;
  }

  /**
   * From a list of routing deployments, select the best endpoint.
   */
  private static async selectBestEndpoint(
    routingDeployments: RoutingDeploymentInfo[],
    protocol: 'http' | 'https'
  ): Promise<string | null> {
    if (routingDeployments.length === 0) {
      return null;
    }

    const factory = getRepositoryFactory();
    const deploymentRepo = factory.deploymentRepo;

    // Healthy primary first
    const primaryHealthy = routingDeployments
      .filter(d => d.role === 'primary' && d.health_status === 'healthy')
      .sort((a, b) => b.priority - a.priority);

    if (primaryHealthy.length > 0) {
      const deployment = await deploymentRepo.getById(primaryHealthy[0].deployment_id);
      if (deployment) return this.pickEndpoint(deployment, protocol);
    }

    // Any primary
    const anyPrimary = routingDeployments
      .filter(d => d.role === 'primary')
      .sort((a, b) => b.priority - a.priority);

    if (anyPrimary.length > 0) {
      const deployment = await deploymentRepo.getById(anyPrimary[0].deployment_id);
      if (deployment) return this.pickEndpoint(deployment, protocol);
    }

    // Any deployment
    const deployment = await deploymentRepo.getById(routingDeployments[0].deployment_id);
    if (deployment) return this.pickEndpoint(deployment, protocol);

    return null;
  }

  /**
   * Format S3 endpoint from deployment endpoint (e.g. app.{apex} → s3.{apex}).
   */
  static formatS3Endpoint(deploymentEndpoint: string): string {
    return deploymentEndpointToS3GatewayUrl(deploymentEndpoint);
  }
}
