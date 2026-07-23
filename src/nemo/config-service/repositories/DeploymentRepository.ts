import { Repository, DataSource } from 'typeorm';
import { Deployment as DeploymentEntity } from '../models/Deployment';
import { Deployment, CreateDeploymentRequest, UpdateDeploymentRequest } from '../types/deployment';

export class DeploymentRepository {
  private repo: Repository<DeploymentEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(DeploymentEntity);
  }

  async create(request: CreateDeploymentRequest): Promise<Deployment> {
    const deployment = this.repo.create({
      id: request.id,
      region: request.region,
      endpoint: request.endpoint,
      http_endpoint: request.http_endpoint,
      capacity: request.capacity,
      capabilities: request.capabilities || [],
      storage_classes: request.storage_classes || [],
      status: 'unknown'
    });
    const saved = await this.repo.save(deployment);
    return this.mapEntityToModel(saved);
  }

  async getById(id: string): Promise<Deployment | null> {
    const deployment = await this.repo.findOne({ where: { id } });
    if (!deployment) {
      return null;
    }
    return this.mapEntityToModel(deployment);
  }

  async update(id: string, request: UpdateDeploymentRequest): Promise<Deployment> {
    const deployment = await this.repo.findOne({ where: { id } });
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    if (request.region !== undefined) {
      deployment.region = request.region;
    }
    if (request.endpoint !== undefined) {
      deployment.endpoint = request.endpoint;
    }
    if (request.http_endpoint !== undefined) {
      deployment.http_endpoint = request.http_endpoint;
    }
    if (request.capacity !== undefined) {
      deployment.capacity = { ...deployment.capacity, ...request.capacity };
    }
    if (request.capabilities !== undefined) {
      deployment.capabilities = request.capabilities;
    }
    if (request.storage_classes !== undefined) {
      deployment.storage_classes = request.storage_classes;
    }

    const updated = await this.repo.save(deployment);
    return this.mapEntityToModel(updated);
  }

  async updateStatus(id: string, status: string, lastHealthCheck?: string): Promise<void> {
    const deployment = await this.repo.findOne({ where: { id } });
    if (!deployment) {
      throw new Error('Deployment not found');
    }

    deployment.status = status as 'healthy' | 'unhealthy' | 'unknown';
    if (lastHealthCheck) {
      deployment.last_health_check = new Date(lastHealthCheck);
    }
    await this.repo.save(deployment);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    return (result.affected || 0) > 0;
  }

  async list(): Promise<Deployment[]> {
    const deployments = await this.repo.find({
      order: { registered_at: 'DESC' }
    });
    return deployments.map(d => this.mapEntityToModel(d));
  }

  async exists(id: string): Promise<boolean> {
    const count = await this.repo.count({ where: { id } });
    return count > 0;
  }

  private mapEntityToModel(entity: DeploymentEntity): Deployment {
    return {
      id: entity.id,
      region: entity.region,
      endpoint: entity.endpoint,
      http_endpoint: entity.http_endpoint || undefined,
      capacity: entity.capacity || undefined,
      capabilities: entity.capabilities || undefined,
      storage_classes: entity.storage_classes || undefined,
      registered_at: entity.registered_at.toISOString(),
      last_health_check: entity.last_health_check?.toISOString(),
      status: entity.status || 'unknown'
    };
  }
}

