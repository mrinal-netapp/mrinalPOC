import { get_logger } from '@agentstudio/observability-client-runtime';
const logger = get_logger();
import { Repository, DataSource } from 'typeorm';
import { DeploymentAssignment as DeploymentAssignmentEntity } from '../models/DeploymentAssignment';
import { DeploymentAssignment } from '../types/deployment';

export class DeploymentAssignmentRepository {
  private repo: Repository<DeploymentAssignmentEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(DeploymentAssignmentEntity);
  }

  async create(assignment: Omit<DeploymentAssignment, 'assigned_at'>): Promise<DeploymentAssignment> {
    const entity = this.repo.create({
      project_id: assignment.project_id,
      data_source_name: assignment.bucket_name,
      deployment_id: assignment.deployment_id,
      role: assignment.role,
      priority: assignment.priority,
      assignment_reason: assignment.assignment_reason,
      status: assignment.status,
      load_balance_weight: assignment.load_balance_weight || 100
    });
    const saved = await this.repo.save(entity);
    
    logger.info(
      `[Assignment Created] DataSource: ${assignment.project_id}/${assignment.bucket_name} | ` +
      `Deployment: ${assignment.deployment_id} | ` +
      `Role: ${assignment.role} | ` +
      `Priority: ${assignment.priority} | ` +
      `Status: ${assignment.status} | ` +
      `Reason: ${assignment.assignment_reason || 'none'}`
    );
    
    return this.mapEntityToModel(saved);
  }

  async get(projectId: string, bucketName: string, deploymentId: string): Promise<DeploymentAssignment | null> {
    const assignment = await this.repo.findOne({
      where: {
        project_id: projectId,
        data_source_name: bucketName,
        deployment_id: deploymentId
      }
    });
    if (!assignment) {
      return null;
    }
    return this.mapEntityToModel(assignment);
  }

  async listByDeployment(deploymentId: string, status?: string): Promise<DeploymentAssignment[]> {
    const where: any = { deployment_id: deploymentId };
    if (status) {
      where.status = status;
    }
    const assignments = await this.repo.find({
      where,
      order: { priority: 'ASC' }
    });
    return assignments.map(a => this.mapEntityToModel(a));
  }

  async listByBucket(projectId: string, bucketName: string, status?: string): Promise<DeploymentAssignment[]> {
    const where: any = {
      project_id: projectId,
      data_source_name: bucketName
    };
    if (status) {
      where.status = status;
    }
    const assignments = await this.repo.find({
      where,
      order: { priority: 'ASC' }
    });
    return assignments.map(a => this.mapEntityToModel(a));
  }

  async delete(projectId: string, bucketName: string, deploymentId: string): Promise<boolean> {
    const result = await this.repo.delete({
      project_id: projectId,
      data_source_name: bucketName,
      deployment_id: deploymentId
    });
    const deleted = (result.affected || 0) > 0;
    
    if (deleted) {
      logger.info(
        `[Assignment Deleted] DataSource: ${projectId}/${bucketName} | ` +
        `Deployment: ${deploymentId}`
      );
    }
    
    return deleted;
  }

  async deleteByBucket(projectId: string, bucketName: string): Promise<void> {
    const assignments = await this.listByBucket(projectId, bucketName);
    
    await this.repo.delete({
      project_id: projectId,
      data_source_name: bucketName
    });
    
    if (assignments.length > 0) {
      const deploymentIds = assignments.map(a => `${a.deployment_id}(${a.role})`).join(', ');
      logger.info(
        `[Assignments Deleted] DataSource: ${projectId}/${bucketName} | ` +
        `Count: ${assignments.length} | ` +
        `Deployments: ${deploymentIds}`
      );
    }
  }

  async deleteByProject(projectId: string): Promise<void> {
    await this.repo.delete({
      project_id: projectId
    });
  }

  async deleteByDeployment(deploymentId: string): Promise<void> {
    const assignments = await this.listByDeployment(deploymentId);
    
    await this.repo.delete({
      deployment_id: deploymentId
    });
    
    if (assignments.length > 0) {
      const items = assignments.map(a => `${a.project_id}/${a.bucket_name}(${a.role})`).join(', ');
      logger.info(
        `[Assignments Deleted] Deployment: ${deploymentId} | ` +
        `Count: ${assignments.length} | ` +
        `DataSources: ${items}`
      );
    }
  }

  private mapEntityToModel(entity: DeploymentAssignmentEntity): DeploymentAssignment {
    return {
      project_id: entity.project_id,
      bucket_name: entity.data_source_name,
      deployment_id: entity.deployment_id,
      role: entity.role,
      priority: entity.priority,
      assigned_at: entity.assigned_at.toISOString(),
      assignment_reason: entity.assignment_reason || undefined,
      status: entity.status,
      load_balance_weight: entity.load_balance_weight || 100
    };
  }
}
