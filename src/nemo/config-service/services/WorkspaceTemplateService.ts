import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { AppDataSource } from '../db/postgres';
import { WorkspaceTemplate } from '../models/WorkspaceTemplate';
import { Workspace } from '../models/Workspace';
import { BaseService } from './BaseService';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors';
import { FindOptionsWhere, Not } from 'typeorm';

const templateRepo = () => AppDataSource.getRepository(WorkspaceTemplate);
const workspaceRepo = () => AppDataSource.getRepository(Workspace);

export interface CreateWorkspaceTemplateRequest {
  name: string;
  description: string;
  type: 'jupyterlab' | 'vscode' | 'custom';
  environment: {
    baseImage?: string;
    pythonVersion?: string;
    nodeVersion?: string;
    libraries?: Array<{
      name: string;
      version: string;
      packageManager?: 'pip' | 'conda' | 'npm';
    }>;
    environmentVariables?: Record<string, string>;
  };
  jupyterConfig?: {
    extensions?: string[];
    settings?: Record<string, any>;
  };
  resources?: {
    cpu?: string;
    memory?: string;
    storage?: string;
    gpu?: boolean;
  };
  startupScript?: string;
  homeUrl?: string; // Default home URL path for the workspace (e.g., "/lab" for JupyterLab)
}

export interface UpdateWorkspaceTemplateRequest {
  name?: string;
  description?: string;
  type?: 'jupyterlab' | 'vscode' | 'custom';
  environment?: {
    baseImage?: string;
    pythonVersion?: string;
    nodeVersion?: string;
    libraries?: Array<{
      name: string;
      version: string;
      packageManager?: 'pip' | 'conda' | 'npm';
    }>;
    environmentVariables?: Record<string, string>;
  };
  jupyterConfig?: {
    extensions?: string[];
    settings?: Record<string, any>;
  };
  resources?: {
    cpu?: string;
    memory?: string;
    storage?: string;
    gpu?: boolean;
  };
  startupScript?: string;
  homeUrl?: string; // Default home URL path for the workspace (e.g., "/lab" for JupyterLab)
  isActive?: boolean;
}

export class WorkspaceTemplateService extends BaseService {

  /**
   * Seed default workspace templates for a newly created project.
   * Idempotent: skips templates that already exist (by name).
   */
  static async seedDefaultTemplates(projectId: string): Promise<void> {
    const repo = templateRepo();

    const defaults: CreateWorkspaceTemplateRequest[] = [
      {
        name: 'JupyterLab',
        description: 'Interactive Python notebook environment with pre-installed data science libraries (polars, pandas, pyarrow, lancedb, scipy).',
        type: 'jupyterlab',
        environment: {
          baseImage: process.env.JUPYTERLAB_DEFAULT_IMAGE || 'jupyter/scipy-notebook:latest',
          pythonVersion: '3.11',
        },
        resources: {
          cpu: '2',
          memory: '4Gi',
          storage: '10Gi',
        },
        homeUrl: '/lab',
      },
    ];

    for (const tmpl of defaults) {
      const exists = await repo.findOne({ where: { projectId, name: tmpl.name } });
      if (exists) continue;

      const entity = repo.create({ projectId, ...tmpl, isActive: true });
      await repo.save(entity);
      logger.info(`[WorkspaceTemplateService] Seeded default template "${tmpl.name}" for project ${projectId}`);
    }
  }

  /**
   * Create a new workspace template
   */
  static async createTemplate(
    projectId: string,
    data: CreateWorkspaceTemplateRequest
  ): Promise<WorkspaceTemplate> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    // Check for duplicate name
    const repo = templateRepo();
    const exists = await repo.findOne({ where: { projectId, name: data.name } });
    if (exists) {
      throw new ConflictError('WorkspaceTemplate with this name already exists in this project');
    }

    // Validate environment
    if (!data.environment) {
      throw new ValidationError('environment is required');
    }

    // Create template
    const template = repo.create({
      projectId,
      ...data,
      isActive: true,
    });

    return await repo.save(template);
  }

  /**
   * Get template by ID
   */
  static async getTemplate(templateId: string): Promise<WorkspaceTemplate | null> {
    return await templateRepo().findOne({
      where: { id: templateId },
      relations: ['workspaces'],
    });
  }

  /**
   * Get template by ID or throw
   */
  static async getTemplateOrThrow(templateId: string): Promise<WorkspaceTemplate> {
    const template = await this.getTemplate(templateId);
    if (!template) {
      throw new NotFoundError('WorkspaceTemplate', templateId);
    }
    return template;
  }

  /**
   * List templates for a project
   */
  static async listTemplates(
    projectId: string,
    activeOnly: boolean = true
  ): Promise<WorkspaceTemplate[]> {
    if (!projectId) {
      throw new ValidationError('projectId is required');
    }

    const where: FindOptionsWhere<WorkspaceTemplate> = { projectId };
    if (activeOnly) {
      where.isActive = true;
    }

    return await templateRepo().find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Update template
   */
  static async updateTemplate(
    templateId: string,
    projectId: string,
    updates: UpdateWorkspaceTemplateRequest
  ): Promise<WorkspaceTemplate> {
    const repo = templateRepo();
    const template = await repo.findOne({ where: { id: templateId, projectId } });
    
    if (!template) {
      throw new NotFoundError('WorkspaceTemplate', templateId);
    }

    // Check for duplicate name if name is being changed
    if (updates.name && updates.name !== template.name) {
      const exists = await repo.findOne({
        where: { projectId, name: updates.name, id: Not(templateId) } as FindOptionsWhere<WorkspaceTemplate>,
      });
      if (exists) {
        throw new ConflictError('WorkspaceTemplate with this name already exists in this project');
      }
    }

    Object.assign(template, updates);
    return await repo.save(template);
  }

  /**
   * Delete template (soft delete by setting isActive = false)
   */
  static async deleteTemplate(templateId: string, projectId: string): Promise<void> {
    const repo = templateRepo();
    const template = await repo.findOne({ where: { id: templateId, projectId } });
    
    if (!template) {
      throw new NotFoundError('WorkspaceTemplate', templateId);
    }

    // Check if template is in use
    const workspaceRepoInstance = AppDataSource.getRepository(Workspace);
    const workspaceCount = await workspaceRepoInstance.count({
      where: { templateId },
    });

    if (workspaceCount > 0) {
      throw new ValidationError(`Cannot delete template: ${workspaceCount} workspace(s) are using this template`);
    }

    template.isActive = false;
    await repo.save(template);
  }
}

