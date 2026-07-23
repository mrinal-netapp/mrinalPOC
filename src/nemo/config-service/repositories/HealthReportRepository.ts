import { Repository, DataSource } from 'typeorm';
import { HealthReport as HealthReportEntity } from '../models/HealthReport';
import { HealthReport } from '../types/deployment';

export class HealthReportRepository {
  private repo: Repository<HealthReportEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(HealthReportEntity);
  }

  async createOrUpdate(healthReport: HealthReport): Promise<void> {
    const entity = this.repo.create({
      deployment_id: healthReport.deployment_id,
      timestamp: new Date(healthReport.timestamp),
      healthy: healthReport.healthy,
      status_message: healthReport.status_message,
      volume_mount_status: healthReport.volume_mount_status
    });
    await this.repo.save(entity);
  }

  async getByDeploymentId(deploymentId: string): Promise<HealthReport | null> {
    const healthReport = await this.repo.findOne({
      where: { deployment_id: deploymentId }
    });
    if (!healthReport) {
      return null;
    }
    return this.mapEntityToModel(healthReport);
  }

  async deleteByDeployment(deploymentId: string): Promise<void> {
    await this.repo.delete({ deployment_id: deploymentId });
  }

  private mapEntityToModel(entity: HealthReportEntity): HealthReport {
    return {
      deployment_id: entity.deployment_id,
      timestamp: entity.timestamp.toISOString(),
      healthy: entity.healthy,
      status_message: entity.status_message || undefined,
      volume_mount_status: entity.volume_mount_status || undefined
    };
  }
}

