import { Repository, DataSource } from 'typeorm';
import { ProjectMember as ProjectMemberEntity, ProjectRole } from '../models/ProjectMember';

export interface ProjectMember {
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by?: string;
  invited_at?: string;
  created_at: string;
}

export interface CreateProjectMemberRequest {
  project_id: string;
  user_id: string;
  role: ProjectRole;
  invited_by?: string;
}

export class ProjectMemberRepository {
  private repo: Repository<ProjectMemberEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(ProjectMemberEntity);
  }

  async create(request: CreateProjectMemberRequest): Promise<ProjectMember> {
    const member = this.repo.create({
      project_id: request.project_id,
      user_id: request.user_id,
      role: request.role,
      invited_by: request.invited_by,
      invited_at: request.invited_by ? new Date() : undefined,
    });
    const saved = await this.repo.save(member);
    return this.mapEntityToModel(saved);
  }

  async getByProjectAndUser(projectId: string, userId: string): Promise<ProjectMember | null> {
    const member = await this.repo.findOne({
      where: { project_id: projectId, user_id: userId }
    });
    if (!member) {
      return null;
    }
    return this.mapEntityToModel(member);
  }

  async getByProject(projectId: string): Promise<ProjectMember[]> {
    const members = await this.repo.find({
      where: { project_id: projectId },
      order: { created_at: 'ASC' }
    });
    return members.map(m => this.mapEntityToModel(m));
  }

  async getByUser(userId: string): Promise<ProjectMember[]> {
    const members = await this.repo.find({
      where: { user_id: userId },
      order: { created_at: 'ASC' }
    });
    return members.map(m => this.mapEntityToModel(m));
  }

  async updateRole(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    const member = await this.repo.findOne({
      where: { project_id: projectId, user_id: userId }
    });
    if (!member) {
      throw new Error('Project member not found');
    }

    member.role = role;
    const updated = await this.repo.save(member);
    return this.mapEntityToModel(updated);
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
    const result = await this.repo.delete({
      project_id: projectId,
      user_id: userId
    });
    return (result.affected || 0) > 0;
  }

  async deleteByProject(projectId: string): Promise<number> {
    const result = await this.repo.delete({ project_id: projectId });
    return result.affected || 0;
  }

  async exists(projectId: string, userId: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { project_id: projectId, user_id: userId }
    });
    return count > 0;
  }

  async isAdmin(projectId: string, userId: string): Promise<boolean> {
    const member = await this.repo.findOne({
      where: { project_id: projectId, user_id: userId }
    });
    return member?.role === 'admin';
  }

  private mapEntityToModel(entity: ProjectMemberEntity): ProjectMember {
    return {
      project_id: entity.project_id,
      user_id: entity.user_id,
      role: entity.role,
      invited_by: entity.invited_by,
      invited_at: entity.invited_at?.toISOString(),
      created_at: entity.created_at.toISOString(),
    };
  }
}
