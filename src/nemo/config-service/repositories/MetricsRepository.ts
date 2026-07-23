import { Repository, DataSource } from 'typeorm';
import { Metrics as MetricsEntity } from '../models/Metrics';
import { Metrics } from '../types/deployment';

export class MetricsRepository {
  private repo: Repository<MetricsEntity>;

  constructor(dataSource: DataSource) {
    this.repo = dataSource.getRepository(MetricsEntity);
  }

  async create(metrics: Metrics): Promise<void> {
    const entity = this.repo.create({
      deployment_id: metrics.deployment_id,
      timestamp: new Date(metrics.timestamp),
      metrics_data: metrics.metrics,
      bucket_metrics: metrics.bucket_metrics
    });
    await this.repo.save(entity);

    // Keep only last 100 metrics per deployment
    const allMetrics = await this.repo.find({
      where: { deployment_id: metrics.deployment_id },
      order: { timestamp: 'DESC' },
      take: 101 // Get one extra to know if we need to delete
    });

    if (allMetrics.length > 100) {
      const toDelete = allMetrics.slice(100);
      await this.repo.remove(toDelete);
    }
  }

  async getRecent(deploymentId: string, limit: number = 100): Promise<Metrics[]> {
    const metrics = await this.repo.find({
      where: { deployment_id: deploymentId },
      order: { timestamp: 'DESC' },
      take: limit
    });
    return metrics.map(m => this.mapEntityToModel(m));
  }

  async deleteByDeployment(deploymentId: string): Promise<void> {
    await this.repo.delete({ deployment_id: deploymentId });
  }

  private mapEntityToModel(entity: MetricsEntity): Metrics {
    return {
      deployment_id: entity.deployment_id,
      timestamp: entity.timestamp.toISOString(),
      metrics: entity.metrics_data || undefined,
      bucket_metrics: entity.bucket_metrics || undefined
    };
  }
}

