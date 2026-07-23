import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import { Workspace } from '../models/Workspace';
import { WorkspaceTemplate } from '../models/WorkspaceTemplate';
import { BaseService } from './BaseService';
import { NotFoundError, ValidationError, ConflictError, BusinessLogicError } from '../utils/errors';
import { WorkspaceTemplateService } from './WorkspaceTemplateService';
import { FindOptionsWhere, Not } from 'typeorm';
import { ensureBucketExists } from '../utils/s3Utils';
import { isDefaultBucket } from '../utils/defaultBucket';
import { WorkspaceOrchestratorClient } from '../clients/WorkspaceOrchestratorClient';

const workspaceRepo = () => AppDataSource.getRepository(Workspace);

export interface CreateWorkspaceRequest {
  templateId: string;
  name: string;
  description?: string;
  bucketName?: string;
  resources?: {
    cpu?: string; // e.g., "2"
    memory?: string; // e.g., "4Gi"
    storage?: string; // e.g., "10Gi"
  };
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  bucketName?: string;
  resources?: {
    cpu?: string; // e.g., "2"
    memory?: string; // e.g., "4Gi"
    storage?: string; // e.g., "10Gi"
  };
}

export class WorkspaceService extends BaseService {
  /**
   * Create a new workspace
   */
  static async createWorkspace(
    projectId: string,
    data: CreateWorkspaceRequest
  ): Promise<Workspace> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    // Verify template exists and is active
    const template = await WorkspaceTemplateService.getTemplateOrThrow(data.templateId);
    if (template.projectId !== projectId) {
      throw new ValidationError('Template does not belong to this project');
    }
    if (!template.isActive) {
      throw new ValidationError('Template is not active');
    }

    // Check for duplicate name
    const repo = workspaceRepo();
    const exists = await repo.findOne({ where: { projectId, name: data.name } });
    if (exists) {
      throw new ConflictError('Workspace with this name already exists in this project');
    }

    // Determine bucket name (use provided or generate default from project home_dir)
    const bucketName = data.bucketName || await this.getBucketForWorkspace(projectId);

    // Ensure bucket exists only for non-default buckets. The default bucket (e.g. default-nemo)
    // is provisioned at app/install time by Helm/s3gateway and shared by all projects.
    if (bucketName && !isDefaultBucket(bucketName)) {
      await ensureBucketExists(bucketName);
    }

    // Get deployment ID from environment (defaults to 'nemo')
    // This assigns the workspace to the current deployment at creation time
    const deploymentId = process.env.DEPLOYMENT_ID || 'nemo';

    // Create workspace
    const workspace = repo.create({
      projectId,
      templateId: data.templateId,
      name: data.name,
      description: data.description,
      status: 'new',
      bucketName: bucketName || undefined,
      deploymentId,  // Pre-assign to this deployment
      lastAccessedAt: new Date(),
      metadata: data.resources ? {
        resources: data.resources,
      } : undefined,
    });

    const savedWorkspace = await repo.save(workspace);
    return savedWorkspace;
  }

  /**
   * Get workspace by ID
   */
  static async getWorkspace(workspaceId: string, includeTemplate: boolean = true): Promise<Workspace | null> {
    const relations = includeTemplate ? ['template'] : [];
    return await workspaceRepo().findOne({
      where: { id: workspaceId },
      relations,
    });
  }

  /**
   * Get workspace by ID or throw
   */
  static async getWorkspaceOrThrow(workspaceId: string, projectId?: string): Promise<Workspace> {
    const where: FindOptionsWhere<Workspace> = { id: workspaceId };
    if (projectId) {
      where.projectId = projectId;
    }

    const workspace = await workspaceRepo().findOne({
      where,
      relations: ['template'],
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    return workspace;
  }

  /**
   * List workspaces for a project
   */
  static async listWorkspaces(
    projectId: string,
    status?: 'new' | 'creating' | 'running' | 'stopping' | 'stopped' | 'error'
  ): Promise<Workspace[]> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    const where: FindOptionsWhere<Workspace> = { projectId };
    if (status) {
      where.status = status;
    }

    return await workspaceRepo().find({
      where,
      relations: ['template'],
      order: { lastAccessedAt: 'DESC' },
    });
  }

  /**
   * Query workspaces for workspace orchestrator polling
   * Supports filtering by status, deploymentId, and deploymentType
   */
  static async queryWorkspacesForManagement(params: {
    status?: string[]; // Comma-separated or array of statuses
    deploymentId?: string;
    deploymentType?: 'nemo';
  }): Promise<Workspace[]> {
    const repo = workspaceRepo();
    const queryBuilder = repo.createQueryBuilder('workspace')
      .leftJoinAndSelect('workspace.template', 'template');

    // Filter by status
    if (params.status && params.status.length > 0) {
      const statuses = Array.isArray(params.status) ? params.status : params.status;
      queryBuilder.andWhere('workspace.status IN (:...statuses)', { statuses });
    }

    // Filter by deploymentId
    // Workspaces are pre-assigned to a deployment at creation time
    if (params.deploymentId) {
      queryBuilder.andWhere('workspace.deploymentId = :deploymentId', { 
        deploymentId: params.deploymentId 
      });
    }

    // Filter by deploymentType (for backwards compatibility)
    if (params.deploymentType && !params.deploymentId) {
      if (params.deploymentType === 'nemo') {
        queryBuilder.andWhere('workspace.deploymentId = :nemoId', {
          nemoId: 'nemo'
        });
      }
    }

    return await queryBuilder
      .orderBy('workspace.lastAccessedAt', 'DESC')
      .getMany();
  }

  /**
   * Update workspace
   */
  static async updateWorkspace(
    workspaceId: string,
    projectId: string,
    updates: UpdateWorkspaceRequest
  ): Promise<Workspace> {
    const repo = workspaceRepo();
    const workspace = await repo.findOne({
      where: { id: workspaceId, projectId },
      relations: ['template'],
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    // Prevent updates to running workspaces (except description)
    if (workspace.status === 'running' && updates.name) {
      throw new BusinessLogicError('Cannot change workspace name while workspace is running');
    }

    // Check for duplicate name if name is being changed
    if (updates.name && updates.name !== workspace.name) {
      const exists = await repo.findOne({
        where: { projectId, name: updates.name, id: Not(workspaceId) } as FindOptionsWhere<Workspace>,
      });
      if (exists) {
        throw new ConflictError('Workspace with this name already exists in this project');
      }
    }

    // Handle resources separately (stored in metadata)
    const { resources, ...otherUpdates } = updates;
    Object.assign(workspace, otherUpdates);
    
    // Update resources in metadata
    if (resources !== undefined) {
      if (!workspace.metadata) {
        workspace.metadata = {};
      }
      if (resources) {
        workspace.metadata.resources = resources;
      } else {
        // Remove resources if explicitly set to null/undefined
        delete (workspace.metadata as any).resources;
      }
    }
    
    workspace.lastAccessedAt = new Date();
    return await repo.save(workspace);
  }

  /**
   * Delete workspace
   */
  static async deleteWorkspace(workspaceId: string, projectId: string): Promise<void> {
    const repo = workspaceRepo();
    const workspace = await repo.findOne({ where: { id: workspaceId, projectId } });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    // Prevent deletion of running workspaces
    if (workspace.status === 'running') {
      throw new BusinessLogicError('Cannot delete workspace while it is running. Please stop it first.');
    }

    // Clean up Kubernetes resources including PVC
    try {
      const orchestratorClient = new WorkspaceOrchestratorClient();
      await orchestratorClient.deleteWorkspace({
        workspaceId: workspace.id,
        projectId,
        podName: workspace.podName,
        pvcName: workspace.pvcName,
        serviceName: workspace.deploymentId,
        secretName: undefined, // TODO: track secret name if needed
      });
    } catch (error: any) {
      // Log error but don't fail deletion - workspace will be removed from DB
      // Resources may be cleaned up later or manually
      logger.error(`[WorkspaceService] Failed to cleanup resources for workspace ${workspaceId}:`, error.message);
    }

    // Remove workspace from database
    await repo.remove(workspace);
  }

  /**
   * Launch workspace (call orchestrator service to create Kubernetes resources)
   */
  static async launchWorkspace(
    workspaceId: string,
    projectId: string
  ): Promise<Workspace> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId, projectId);

    // Validate status - can only launch from 'new' or 'stopped' states
    if (workspace.status === 'running') {
      throw new BusinessLogicError('Workspace is already running');
    }

    if (workspace.status === 'creating') {
      throw new BusinessLogicError('Workspace is currently being created. Please wait.');
    }

    if (workspace.status === 'stopping') {
      throw new BusinessLogicError('Workspace is currently stopping. Please wait.');
    }

    // Allow launching from 'new', 'stopped', or 'error' states
    // Error state workspaces can be retried by launching again
    if (workspace.status !== 'new' && workspace.status !== 'stopped' && workspace.status !== 'error') {
      throw new BusinessLogicError(`Cannot launch workspace from status: ${workspace.status}`);
    }

    // Get template
    const template = await WorkspaceTemplateService.getTemplateOrThrow(workspace.templateId);
    if (template.projectId !== projectId) {
      throw new ValidationError('Template does not belong to this project');
    }

    // Merge workspace resources with template resources (workspace resources override template)
    const workspaceResources = (workspace.metadata as any)?.resources;
    const finalResources = workspaceResources 
      ? { ...template.resources, ...workspaceResources }
      : template.resources;

    // Update status to creating and clear any previous error message
    workspace.status = 'creating';
    workspace.lastAccessedAt = new Date();
    // Clear previous error message when starting a new launch attempt
    if (workspace.metadata) {
      workspace.metadata.errorMessage = undefined;
    }
    await workspaceRepo().save(workspace);

    try {
      // Call orchestrator service (infrastructure concern)
      const orchestratorClient = new WorkspaceOrchestratorClient();
      await orchestratorClient.launchWorkspace({
        workspaceId: workspace.id,
        projectId,
        template: {
          type: template.type,
          environment: template.environment,
          resources: finalResources,
        },
        s3Config: workspace.bucketName ? {
          bucketName: workspace.bucketName,
          accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
          secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
          endpoint: process.env.S3_ENDPOINT,
        } : undefined,
      });

      // Status will be updated via callback from orchestrator
      // For now, return workspace with creating status
      return workspace;
    } catch (error: any) {
      // Mark workspace as error
      workspace.status = 'error';
      if (workspace.metadata) {
        workspace.metadata.errorMessage = error.message;
      } else {
        workspace.metadata = {
          errorMessage: error.message,
        };
      }
      await workspaceRepo().save(workspace);
      throw error;
    }
  }

  /**
   * Stop workspace (call orchestrator service to cleanup Kubernetes resources)
   */
  static async stopWorkspace(
    workspaceId: string,
    projectId: string
  ): Promise<Workspace> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId, projectId);

    // Can only stop workspaces that are running
    if (workspace.status === 'stopped') {
      return workspace;
    }

    if (workspace.status === 'stopping') {
      throw new BusinessLogicError('Workspace is already stopping');
    }

    if (workspace.status !== 'running') {
      throw new BusinessLogicError(`Cannot stop workspace from status: ${workspace.status}. Only running workspaces can be stopped.`);
    }

    // Update status to stopping
    workspace.status = 'stopping';
    if (workspace.metadata) {
      workspace.metadata.lastSyncAt = new Date().toISOString();
    }
    await workspaceRepo().save(workspace);

    try {
      // Call orchestrator service
      const orchestratorClient = new WorkspaceOrchestratorClient();
      await orchestratorClient.stopWorkspace({
        workspaceId: workspace.id,
        projectId,
        podName: workspace.podName,
        pvcName: workspace.pvcName,
        serviceName: workspace.deploymentId,
        bucketName: workspace.bucketName,
      });

      // Status will be updated via callback from orchestrator
      // For now, return workspace with stopping status
      return workspace;
    } catch (error: any) {
      // Mark workspace as error
      workspace.status = 'error';
      if (workspace.metadata) {
        workspace.metadata.errorMessage = error.message;
      } else {
        workspace.metadata = {
          errorMessage: error.message,
        };
      }
      await workspaceRepo().save(workspace);
      throw error;
    }
  }

  /**
   * Update workspace token
   */
  static async updateWorkspaceToken(
    workspaceId: string,
    projectId: string,
    token: string
  ): Promise<Workspace> {
    const repo = workspaceRepo();
    const workspace = await repo.findOne({
      where: { id: workspaceId, projectId },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }

    workspace.metadata = {
      ...workspace.metadata,
      jupyterToken: token,
      tokenGeneratedAt: new Date().toISOString(),
    };

    return await repo.save(workspace);
  }

  /**
   * Update workspace status (called by orchestrator service via callback)
   * Validates status transitions to ensure consistency
   */
  static async updateWorkspaceStatus(
    workspaceId: string,
    projectId: string,
    status: 'running' | 'stopped' | 'error' | 'creating',
    resources?: {
      podName?: string;
      pvcName?: string;
      endpoint?: string;
      errorMessage?: string;
    }
  ): Promise<Workspace> {
    const workspace = await this.getWorkspaceOrThrow(workspaceId, projectId);

    // Validate status transitions
    const validTransitions: Record<string, string[]> = {
      'new': ['creating', 'error'], // From new, can go to creating or error
      'creating': ['creating', 'running', 'error'], // From creating, can go to running or error (or stay creating)
      'stopping': ['stopped', 'error'], // From stopping, can go to stopped or error
      'running': ['running', 'stopped', 'error'], // Can update running status, or transition to stopped/error if pod completes
      'stopped': ['stopped'], // Can update stopped status
      'error': ['error'], // Can update error status
    };

    const allowedStatuses = validTransitions[workspace.status];
    if (!allowedStatuses || !allowedStatuses.includes(status)) {
      logger.warn(`[WorkspaceService] Invalid status transition: ${workspace.status} -> ${status} for workspace ${workspaceId}`);
      // Don't throw - allow the transition but log warning for debugging
    }

    workspace.status = status;
    workspace.lastAccessedAt = new Date();

    if (resources) {
      if (resources.podName) workspace.podName = resources.podName;
      if (resources.pvcName) workspace.pvcName = resources.pvcName;
      if (resources.endpoint) workspace.endpoint = resources.endpoint;
      if (resources.errorMessage) {
        workspace.metadata = {
          ...workspace.metadata,
          errorMessage: resources.errorMessage,
        };
      }
    }

    if (status === 'stopped') {
      workspace.endpoint = undefined;
      workspace.podName = undefined;
      workspace.pvcName = undefined;
      workspace.deploymentId = undefined;
      // Clear error message and Jupyter token when stopped
      if (workspace.metadata) {
        workspace.metadata.errorMessage = undefined;
        workspace.metadata.jupyterToken = undefined;
        workspace.metadata.tokenGeneratedAt = undefined;
        workspace.metadata.tokenExpiry = undefined;
      }
    }

    if (status === 'running' && resources?.endpoint) {
      // Set deploymentId to service name for reference
      if (resources.podName) {
        // Workspace IDs are now 10-character Base36 strings
        workspace.deploymentId = `workspace-svc-${workspaceId}`;
      }
      // Clear error message when successfully running
      if (workspace.metadata) {
        workspace.metadata.libraryInstallStatus = 'completed';
        workspace.metadata.errorMessage = undefined;
      } else {
        workspace.metadata = {
          libraryInstallStatus: 'completed',
        };
      }
    }

    if (status === 'error') {
      // Ensure error message is set if provided
      if (resources?.errorMessage) {
        if (workspace.metadata) {
          workspace.metadata.errorMessage = resources.errorMessage;
        } else {
          workspace.metadata = {
            errorMessage: resources.errorMessage,
          };
        }
      }
    }

    return await workspaceRepo().save(workspace);
  }


  /**
   * Get bucket name for workspace by loading the project and parsing home_dir.
   */
  private static async getBucketForWorkspace(projectId: string): Promise<string> {
    const { Project } = await import('../models/Project');
    const projectEntity = await AppDataSource.getRepository(Project).findOne({ where: { id: projectId } });
    if (!projectEntity) {
      throw new Error(`Project ${projectId} not found`);
    }
    const { getProjectStorageRoot } = await import('../utils/defaultBucket');
    const { bucketName } = getProjectStorageRoot(projectEntity);
    return bucketName;
  }
}

