import { Repository, DataSource } from 'typeorm';
import { BucketHealth as BucketHealthEntity } from '../models/BucketHealth';
import { BucketHealth as BucketHealthModel } from '../types/deployment';

export class BucketHealthRepository {
  private repo: Repository<BucketHealthEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(BucketHealthEntity);
  }

  async createOrUpdate(bucketHealth: BucketHealthModel): Promise<void> {
    const entity = this.repo.create({
      project_id: bucketHealth.project_id,
      data_source_name: bucketHealth.bucket_name,
      deployment_id: bucketHealth.deployment_id,
      timestamp: new Date(bucketHealth.timestamp),
      healthy: bucketHealth.healthy,
      status_message: bucketHealth.status_message,
      volume_mount_status: bucketHealth.volume_mount_status
    });
    await this.repo.save(entity);
  }

  async getByBucket(projectId: string, bucketName: string): Promise<BucketHealthModel[]> {
    const healthReports = await this.repo.find({
      where: {
        project_id: projectId,
        data_source_name: bucketName
      },
      order: { timestamp: 'DESC' }
    });
    return healthReports.map(h => this.mapEntityToModel(h));
  }

  async getByBucketAndDeployment(
    projectId: string,
    bucketName: string,
    deploymentId: string
  ): Promise<BucketHealthModel | null> {
    const healthReport = await this.repo.findOne({
      where: {
        project_id: projectId,
        data_source_name: bucketName,
        deployment_id: deploymentId
      },
      order: { timestamp: 'DESC' }
    });
    if (!healthReport) {
      return null;
    }
    return this.mapEntityToModel(healthReport);
  }

  async deleteByBucket(projectId: string, bucketName: string): Promise<void> {
    await this.repo.delete({
      project_id: projectId,
      data_source_name: bucketName
    });
  }

  async deleteByDeployment(deploymentId: string): Promise<void> {
    await this.repo.delete({ deployment_id: deploymentId });
  }

  private mapEntityToModel(entity: BucketHealthEntity): BucketHealthModel {
    return {
      project_id: entity.project_id,
      bucket_name: entity.data_source_name,
      deployment_id: entity.deployment_id,
      timestamp: entity.timestamp.toISOString(),
      healthy: entity.healthy,
      status_message: entity.status_message || undefined,
      volume_mount_status: entity.volume_mount_status || undefined
    };
  }
}
