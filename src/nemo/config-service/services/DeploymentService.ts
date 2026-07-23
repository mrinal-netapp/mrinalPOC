import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { getRepositoryFactory } from '../repositories/RepositoryFactory';
import { BaseService } from './BaseService';
import { NotFoundError, ValidationError, BusinessLogicError } from '../utils/errors';
import {
  Deployment,
  CreateDeploymentRequest,
  UpdateDeploymentRequest,
  BucketRoutingResponse,
  RoutingDeploymentInfo,
  DeploymentConfigResponse,
  BucketConfig,
} from '../types/deployment';
import { DistributedLockManager } from '../db/DistributedLockManager';

export class DeploymentService extends BaseService {
  // Health report timeout: 90 seconds (3 missed reports at 30s interval)
  // If a deployment hasn't reported health within this time, it's considered unhealthy
  private static readonly HEALTH_REPORT_TIMEOUT_MS = 90 * 1000; // 90 seconds
  /**
   * Register or re-register a deployment
   */
  static async registerDeployment(request: CreateDeploymentRequest): Promise<Deployment> {
    if (!request.id) {
      throw new ValidationError('Deployment ID is required');
    }
    if (!request.region) {
      throw new ValidationError('Region is required');
    }
    if (!request.endpoint) {
      throw new ValidationError('Endpoint is required');
    }

    const factory = getRepositoryFactory();
    const { deploymentRepo } = factory;

    // Check if deployment already exists (re-registration)
    if (await deploymentRepo.exists(request.id)) {
      logger.info(`[Deployment Re-registration] ID: ${request.id} - updating and triggering reassignment`);
      
      const deployment = await deploymentRepo.update(request.id, {
        region: request.region,
        endpoint: request.endpoint,
        http_endpoint: request.http_endpoint,
        capacity: request.capacity,
        capabilities: request.capabilities,
        storage_classes: request.storage_classes,
      });

      // Trigger reassignment on re-registration (non-blocking)
      this.reassignBucketsForDeployment(deployment.id, deployment.region).catch((error) => {
        logger.error(`[Deployment Re-registration] Failed to reassign buckets:`, error.message);
      });

      return deployment;
    }

    // Create new deployment
    const deployment = await deploymentRepo.create(request);

    logger.info(
      `[Deployment Created] ID: ${deployment.id} | ` +
      `Region: ${deployment.region} | ` +
      `Endpoint: ${deployment.endpoint}`
    );

    // Try to assign unassigned buckets in the same region (non-blocking)
    this.reassignBucketsForDeployment(deployment.id, deployment.region).catch((error) => {
      logger.error(`[Deployment Created] Failed to reassign buckets:`, error.message);
    });

    return deployment;
  }

  /**
   * Get deployment by ID
   */
  static async getDeployment(deploymentId: string): Promise<Deployment> {
    const factory = getRepositoryFactory();
    const deployment = await factory.deploymentRepo.getById(deploymentId);
    
    if (!deployment) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    return deployment;
  }

  /**
   * Update deployment
   */
  static async updateDeployment(
    deploymentId: string,
    request: UpdateDeploymentRequest
  ): Promise<Deployment> {
    const factory = getRepositoryFactory();
    const { deploymentRepo } = factory;

    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    const deployment = await deploymentRepo.update(deploymentId, request);

    // Always trigger reassignment on deployment update (non-blocking)
    logger.info(`[Deployment Updated] Deployment ${deploymentId} - triggering reassignment`);
    this.reassignBucketsForDeployment(deploymentId, deployment.region).catch((error) => {
      logger.error(`[Deployment Updated] Failed to reassign buckets:`, error.message);
    });

    return deployment;
  }

  /**
   * Delete deployment and all associated data
   */
  static async deleteDeployment(deploymentId: string): Promise<void> {
    const factory = getRepositoryFactory();
    const { deploymentRepo, assignmentRepo, metricsRepo, healthReportRepo } = factory;

    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    // Remove all assignments, metrics, and health reports
    await assignmentRepo.deleteByDeployment(deploymentId);
    await metricsRepo.deleteByDeployment(deploymentId);
    await healthReportRepo.deleteByDeployment(deploymentId);
    await deploymentRepo.delete(deploymentId);
  }

  /**
   * List all deployments
   */
  static async listDeployments(): Promise<Deployment[]> {
    const factory = getRepositoryFactory();
    return await factory.deploymentRepo.list();
  }

  /**
   * Evaluate deployment health status considering health reports and timeout
   * Returns 'healthy', 'unhealthy', or 'unknown'
   * 
   * A deployment is considered unhealthy if:
   * - The health report indicates unhealthy, OR
   * - No health report has been received within HEALTH_REPORT_TIMEOUT_MS (90 seconds)
   * 
   * This allows detection of deployments that have stopped reporting (crashed, network issues, etc.)
   */
  static evaluateDeploymentHealthStatus(
    healthReport: { healthy: boolean; timestamp: string } | null,
    deployment: { status?: string; last_health_check?: string | Date } | null
  ): 'healthy' | 'unhealthy' | 'unknown' {
    const now = Date.now();
    
    // Determine the last health check timestamp
    let lastHealthCheckTime: number | null = null;
    if (healthReport?.timestamp) {
      lastHealthCheckTime = new Date(healthReport.timestamp).getTime();
    } else if (deployment?.last_health_check) {
      const lastCheck = deployment.last_health_check instanceof Date 
        ? deployment.last_health_check.getTime() 
        : new Date(deployment.last_health_check).getTime();
      lastHealthCheckTime = lastCheck;
    }

    // If we have a recent health report, use its status
    if (healthReport && lastHealthCheckTime) {
      const timeSinceLastReport = now - lastHealthCheckTime;
      
      // Check if health report is stale (older than timeout)
      if (timeSinceLastReport > this.HEALTH_REPORT_TIMEOUT_MS) {
        // Health report is stale - mark as unhealthy
        return 'unhealthy';
      }
      
      // Health report is recent - use its status
      return healthReport.healthy ? 'healthy' : 'unhealthy';
    }

    // No health report, but we have a last_health_check timestamp
    if (lastHealthCheckTime) {
      const timeSinceLastCheck = now - lastHealthCheckTime;
      
      // If last check is stale, mark as unhealthy
      if (timeSinceLastCheck > this.HEALTH_REPORT_TIMEOUT_MS) {
        return 'unhealthy';
      }
      
      // Last check is recent, use deployment status
      if (deployment?.status === 'healthy') {
        return 'healthy';
      } else if (deployment?.status === 'unhealthy') {
        return 'unhealthy';
      }
    }

    // No health information available
    return deployment?.status as 'healthy' | 'unhealthy' | 'unknown' || 'unknown';
  }

  /**
   * Get bucket routing information
   */
  static async getBucketRouting(
    projectId: string,
    bucketName: string
  ): Promise<BucketRoutingResponse> {
    if (!projectId) {
      throw new ValidationError('Project ID is required');
    }
    if (!bucketName) {
      throw new ValidationError('Bucket Name is required');
    }

    const factory = getRepositoryFactory();
    const { assignmentRepo, deploymentRepo, healthReportRepo } = factory;

    // Get all active assignments for this bucket
    const assignments = await assignmentRepo.listByBucket(projectId, bucketName, 'active');

    if (assignments.length === 0) {
      throw new NotFoundError('Bucket routing', `${projectId}/${bucketName}`);
    }

    // Build routing info
    const routingDeployments: RoutingDeploymentInfo[] = [];
    for (const assignment of assignments) {
      const deployment = await deploymentRepo.getById(assignment.deployment_id);
      if (!deployment) {
        continue;
      }

      const healthReport = await healthReportRepo.getByDeploymentId(assignment.deployment_id);
      const healthStatus = this.evaluateDeploymentHealthStatus(
        healthReport ? { healthy: healthReport.healthy, timestamp: healthReport.timestamp } : null,
        deployment
      );

      // Update deployment status in database if it's stale (non-blocking)
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
        last_health_check: healthReport?.timestamp || deployment.last_health_check || new Date().toISOString(),
      });
    }

    return {
      bucket_name: bucketName,
      project_id: projectId,
      deployments: routingDeployments,
      routing_strategy: 'load_balance',
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Get deployment configuration (buckets assigned to deployment)
   */
  static async getDeploymentConfig(
    deploymentId: string,
    since?: number
  ): Promise<DeploymentConfigResponse> {
    const factory = getRepositoryFactory();
    const { assignmentRepo, dataSourceRepo, configVersionRepo } = factory;

    const sinceVersion = since || 0;
    
    // Get all active assignments for this deployment
    const assignments = await assignmentRepo.listByDeployment(deploymentId, 'active');

    // Build bucket configs from DataSource (volume) entries
    const bucketConfigs: BucketConfig[] = [];
    const skippedBuckets: string[] = [];

    for (const assignment of assignments) {
      const ds = await dataSourceRepo.getByName(assignment.project_id, assignment.bucket_name);
      
      if (!ds || ds.type !== 'volume' || !ds.volume_config) {
        skippedBuckets.push(`${assignment.project_id}/${assignment.bucket_name}`);
        continue;
      }

      // Get other deployments serving this data source
      const otherAssignments = await assignmentRepo.listByBucket(
        assignment.project_id,
        assignment.bucket_name,
        'active'
      );
      const otherDeployments = otherAssignments
        .filter(a => a.deployment_id !== deploymentId)
        .map(a => ({
          deployment_id: a.deployment_id,
          role: a.role,
        }));

      bucketConfigs.push({
        project_id: assignment.project_id,
        bucket_name: ds.name,
        region: ds.volume_config.region,
        volume_info: ds.volume_config.volume_info as BucketConfig['volume_info'],
        auth_info: ds.volume_config.auth_info,
        protocol: ds.volume_config.protocol,
        role: assignment.role,
        other_deployments: otherDeployments.length > 0 ? otherDeployments : undefined,
      });
    }

    const configVersion = await configVersionRepo.getVersion();

    return {
      deployment_id: deploymentId,
      buckets: bucketConfigs,
      config_version: configVersion,
    };
  }

  /**
   * Reassign buckets for a deployment
   * Assigns unassigned buckets in the same region to this deployment
   */
  static async reassignBucketsForDeployment(
    deploymentId: string,
    deploymentRegion: string
  ): Promise<void> {
    const factory = getRepositoryFactory();
    const { deploymentRepo, assignmentRepo, dataSourceRepo } = factory;

    // Get deployment to check capacity
    const deployment = await deploymentRepo.getById(deploymentId);
    if (!deployment) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    const maxBuckets = deployment.capacity?.max_buckets;
    const currentAssignments = await assignmentRepo.listByDeployment(deploymentId, 'active');
    const assignmentCount = currentAssignments.length;

    // Check if deployment is at capacity
    if (maxBuckets && assignmentCount >= maxBuckets) {
      logger.info(
        `[Reassignment] Deployment ${deploymentId} is at capacity (${assignmentCount}/${maxBuckets}), skipping reassignment`
      );
      return;
    }

    // Get all volumes without assignments
    const { projectRepo } = factory;
    const projects = await projectRepo.list();
    const bucketsWithoutAssignments: Array<{ project_id: string; name: string; region: string }> = [];

    for (const project of projects) {
      const volumes = await dataSourceRepo.list(project.id, { type: 'volume' });
      for (const vol of volumes) {
        const assignments = await assignmentRepo.listByBucket(vol.project_id, vol.name, 'active');
        if (assignments.length === 0 && vol.volume_config) {
          bucketsWithoutAssignments.push({
            project_id: vol.project_id,
            name: vol.name,
            region: vol.volume_config.region,
          });
        }
      }
    }

    // Filter buckets in the same region
    const matchingBuckets = bucketsWithoutAssignments.filter(
      (b) => b.region === deploymentRegion || b.region === 'Auto'
    );

    logger.info(
      `Found ${matchingBuckets.length} unassigned buckets in same region, ${bucketsWithoutAssignments.length} total unassigned`
    );

    // Assign buckets up to capacity limit
    // Use assignBucketToDeployments which handles the assignment logic properly
    let assignedCount = 0;
    for (const bucket of matchingBuckets) {
      if (maxBuckets && (assignmentCount + assignedCount) >= maxBuckets) {
        break;
      }

      try {
        // Use the existing assignment logic which will assign to this deployment if it's the best match
        await this.assignBucketToDeployments(
          bucket.project_id,
          bucket.name,
          bucket.region
        );
        assignedCount++;
      } catch (error: any) {
        logger.error(
          `Failed to assign bucket ${bucket.project_id}/${bucket.name} to deployment ${deploymentId}:`,
          error.message
        );
      }
    }

    if (assignedCount > 0) {
      logger.info(`Assigned ${assignedCount} buckets to deployment ${deploymentId}`);
      // Increment config version
      const { configVersionRepo } = factory;
      await configVersionRepo.incrementVersion();
    }
  }

  /**
   * Assign a bucket to a deployment
   */
  static async assignBucketToDeployment(
    projectId: string,
    bucketName: string,
    deploymentId: string,
    role: 'primary' | 'secondary' = 'primary',
    priority: number = 100
  ): Promise<void> {
    if (!projectId) {
      throw new ValidationError('Project ID is required');
    }
    if (!bucketName) {
      throw new ValidationError('Bucket Name is required');
    }
    if (!deploymentId) {
      throw new ValidationError('Deployment ID is required');
    }

    const factory = getRepositoryFactory();
    const { assignmentRepo, deploymentRepo, dataSourceRepo, configVersionRepo } = factory;

    // Verify deployment exists
    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    // Verify data source (volume) exists
    const ds = await dataSourceRepo.getByName(projectId, bucketName);
    if (!ds || ds.type !== 'volume') {
      throw new NotFoundError('DataSource (volume)', `${projectId}/${bucketName}`);
    }

    // Check if assignment already exists
    const existingAssignments = await assignmentRepo.listByBucket(projectId, bucketName, 'active');
    const existing = existingAssignments.find(a => a.deployment_id === deploymentId);
    if (existing) {
      // Assignment already exists, skip creation
      return;
    }

    // Create new assignment
    await assignmentRepo.create({
      project_id: projectId,
      bucket_name: bucketName,
      deployment_id: deploymentId,
      role,
      priority,
      status: 'active',
      load_balance_weight: 100,
    });

    // Increment config version
    await configVersionRepo.incrementVersion();
  }

  /**
   * Assign bucket to suitable deployments based on region, capacity, and health
   */
  static async assignBucketToDeployments(
    projectId: string,
    bucketName: string,
    bucketRegion: string
  ): Promise<void> {
    if (!projectId) {
      throw new ValidationError('Project ID is required');
    }
    if (!bucketName) {
      throw new ValidationError('Bucket Name is required');
    }
    if (!bucketRegion) {
      throw new ValidationError('Bucket Region is required');
    }

    const factory = getRepositoryFactory();
    const { assignmentRepo, deploymentRepo } = factory;

    // Check if bucket already has assignments
    const existingAssignments = await assignmentRepo.listByBucket(projectId, bucketName, 'active');
    if (existingAssignments.length > 0) {
      logger.info(
        `[Assignment] Bucket ${projectId}/${bucketName} already has ${existingAssignments.length} active assignment(s), skipping auto-assignment`
      );
      return;
    }

    // Get all deployments
    const allDeployments = await deploymentRepo.list();

    if (allDeployments.length === 0) {
      logger.warn(`[Assignment] No deployments available for bucket ${projectId}/${bucketName}`);
      return;
    }

    // Score deployments: prefer same region and available capacity
    const scoredDeployments = await Promise.all(
      allDeployments.map(async (deployment) => {
        const currentAssignments = await assignmentRepo.listByDeployment(deployment.id, 'active');
        const assignmentCount = currentAssignments.length;
        const maxBuckets = deployment.capacity?.max_buckets;
        const hasCapacity = !maxBuckets || assignmentCount < maxBuckets;

        if (!hasCapacity) {
          return { deployment, score: -1 }; // Skip deployments at capacity
        }

        let score = 0;
        // Prefer same region
        if (deployment.region === bucketRegion || bucketRegion === 'Auto') {
          score += 100;
        }
        // Prefer deployments with more available capacity
        if (maxBuckets) {
          score += (maxBuckets - assignmentCount) * 10;
        }

        return { deployment, score };
      })
    );

    // Filter and sort by score
    const eligibleDeployments = scoredDeployments
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score);

    if (eligibleDeployments.length === 0) {
      logger.warn(
        `[Assignment] No eligible deployments found for bucket ${projectId}/${bucketName}`
      );
      return;
    }

    // Assign to top deployment as primary
    const primaryDeployment = eligibleDeployments[0].deployment;
    await this.assignBucketToDeployment(projectId, bucketName, primaryDeployment.id, 'primary', 100);

    // Optionally assign to second deployment as secondary (if available)
    if (eligibleDeployments.length > 1) {
      const secondaryDeployment = eligibleDeployments[1].deployment;
      await this.assignBucketToDeployment(
        projectId,
        bucketName,
        secondaryDeployment.id,
        'secondary',
        50
      );
    }
  }

  /**
   * Submit metrics from a deployment
   */
  static async submitMetrics(deploymentId: string, metrics: any): Promise<void> {
    const factory = getRepositoryFactory();
    const { metricsRepo, deploymentRepo } = factory;

    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    await metricsRepo.create({
      deployment_id: deploymentId,
      timestamp: new Date().toISOString(),
      metrics: metrics.metrics,
      bucket_metrics: metrics.bucket_metrics,
    });
  }

  /**
   * Submit health report from a deployment
   */
  static async submitHealthReport(deploymentId: string, healthReport: any): Promise<void> {
    const factory = getRepositoryFactory();
    const { healthReportRepo, bucketHealthRepo, deploymentRepo, configVersionRepo, dataSourceRepo } = factory;

    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    // Update deployment status
    await deploymentRepo.updateStatus(
      deploymentId,
      healthReport.healthy ? 'healthy' : 'unhealthy',
      healthReport.timestamp
    );

    // Create or update health report
    await healthReportRepo.createOrUpdate({
      deployment_id: deploymentId,
      timestamp: healthReport.timestamp || new Date().toISOString(),
      healthy: healthReport.healthy,
      status_message: healthReport.status_message,
      volume_mount_status: healthReport.volume_mount_status,
    });

    // Handle bucket health reports if provided
    if (healthReport.bucket_health && Array.isArray(healthReport.bucket_health)) {
      for (const bucketHealth of healthReport.bucket_health) {
        // Verify data source (volume) exists
        const ds = await dataSourceRepo.getByName(bucketHealth.project_id, bucketHealth.bucket_name);
        if (!ds || ds.type !== 'volume') {
          logger.warn(
            `DataSource (volume) ${bucketHealth.project_id}/${bucketHealth.bucket_name} not found, skipping health report`
          );
          continue;
        }

        await bucketHealthRepo.createOrUpdate({
          project_id: bucketHealth.project_id,
          bucket_name: bucketHealth.bucket_name,
          deployment_id: deploymentId,
          timestamp: bucketHealth.timestamp || new Date().toISOString(),
          healthy: bucketHealth.healthy,
          status_message: bucketHealth.status_message,
          volume_mount_status: bucketHealth.volume_mount_status,
        });
      }
    }

    // Increment config version on health status change
    await configVersionRepo.incrementVersion();
  }

  /**
   * Get deployment health status
   */
  static async getDeploymentHealth(deploymentId: string): Promise<any> {
    const factory = getRepositoryFactory();
    const { healthReportRepo, deploymentRepo } = factory;

    if (!await deploymentRepo.exists(deploymentId)) {
      throw new NotFoundError('Deployment', deploymentId);
    }

    const healthReport = await healthReportRepo.getByDeploymentId(deploymentId);
    const deployment = await deploymentRepo.getById(deploymentId);

    const healthStatus = this.evaluateDeploymentHealthStatus(
      healthReport ? { healthy: healthReport.healthy, timestamp: healthReport.timestamp } : null,
      deployment
    );

    // Update deployment status in database if it's stale (non-blocking)
    if (healthStatus === 'unhealthy' && deployment?.status !== 'unhealthy') {
      deploymentRepo.updateStatus(deploymentId, 'unhealthy').catch((error) => {
        logger.warn(`[Health Timeout] Failed to update deployment ${deploymentId} status: ${error.message}`);
      });
    }

    return {
      deployment_id: deploymentId,
      healthy: healthStatus === 'healthy',
      status: healthStatus,
      last_health_check: healthReport?.timestamp || deployment?.last_health_check,
      status_message: healthReport?.status_message,
    };
  }
}

