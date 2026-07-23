import { Repository, In, DataSource } from 'typeorm';
import { Project as ProjectEntity } from '../models/Project';
import { Project, ProjectInitStatus, CreateProjectRequest, UpdateProjectRequest } from '../types/project';
import { sanitizeInitError } from '../utils/safeStrings';

export class ProjectRepository {
  private repo: Repository<ProjectEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(ProjectEntity);
  }

  async create(request: CreateProjectRequest, id: string, homeDir: string): Promise<Project> {
    const project = this.repo.create({
      id,
      name: request.name,
      metadata: request.metadata || {},
      home_dir: homeDir,
      // New rows start as 'provisioning'; the async init workflow flips this
      // to 'ready' / 'failed'.
      init_status: ProjectInitStatus.Provisioning,
      init_error: null,
    });
    const saved = await this.repo.save(project);
    return this.mapEntityToModel(saved);
  }

  /**
   * Set the project init lifecycle status. Written by the internal init-status
   * endpoint that the ProjectInitWorkflow calls on completion.
   * Clears init_error unless a message is provided. Returns false if the row
   * does not exist.
   */
  async setInitStatus(id: string, status: ProjectInitStatus, error?: string | null): Promise<boolean> {
    const result = await this.repo.update(id, {
      init_status: status,
      init_error: sanitizeInitError(error ?? null),
    });
    return (result.affected || 0) > 0;
  }

  async getById(id: string): Promise<Project | null> {
    const project = await this.repo.findOne({ where: { id } });
    if (!project) {
      return null;
    }
    return this.mapEntityToModel(project);
  }

  async update(id: string, request: UpdateProjectRequest): Promise<Project> {
    const project = await this.repo.findOne({ where: { id } });
    if (!project) {
      throw new Error('Project not found');
    }

    if (request.name !== undefined) {
      project.name = request.name;
    }
    if (request.metadata !== undefined) {
      project.metadata = { ...project.metadata, ...request.metadata };
    }

    const updated = await this.repo.save(project);
    return this.mapEntityToModel(updated);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    return (result.affected || 0) > 0;
  }

  async list(): Promise<Project[]> {
    const projects = await this.repo.find({
      order: { created_at: 'DESC' }
    });
    return projects.map((p: ProjectEntity) => this.mapEntityToModel(p));
  }

  /**
   * Returns metadata for the given project ids (order: created_at DESC).
   * Ids with no matching row are silently dropped, so a stale Keycloak policy
   * referencing a deleted project will not surface here. Returns [] for an
   * empty id list without hitting the database.
   */
  async listByIds(ids: string[]): Promise<Project[]> {
    if (ids.length === 0) {
      return [];
    }
    const projects = await this.repo.find({
      where: { id: In(ids) },
      order: { created_at: 'DESC' },
    });
    return projects.map((p: ProjectEntity) => this.mapEntityToModel(p));
  }

  async exists(id: string): Promise<boolean> {
    const count = await this.repo.count({ where: { id } });
    return count > 0;
  }

  private mapEntityToModel(entity: ProjectEntity): Project {
    return {
      id: entity.id,
      name: entity.name,
      created_at: entity.created_at.toISOString(),
      updated_at: entity.updated_at.toISOString(),
      metadata: entity.metadata || {},
      home_dir: entity.home_dir,
      init_status: (entity.init_status as ProjectInitStatus) || ProjectInitStatus.Ready,
      init_error: entity.init_error ?? null,
    };
  }
}

