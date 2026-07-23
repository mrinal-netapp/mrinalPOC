import { DataSource } from 'typeorm';
import { DeploymentRepository } from './DeploymentRepository';
import { DeploymentAssignmentRepository } from './DeploymentAssignmentRepository';
import { ConfigVersionRepository } from './ConfigVersionRepository';
import { DataSourceRepository } from './DataSourceRepository';
import { ProjectRepository } from './ProjectRepository';
import { ProjectMemberRepository } from './ProjectMemberRepository';
import { HealthReportRepository } from './HealthReportRepository';
import { MetricsRepository } from './MetricsRepository';
import { BucketHealthRepository } from './BucketHealthRepository';

/**
 * Factory for creating repository instances
 * Provides centralized repository management and dependency injection
 */
export class RepositoryFactory {
  private dataSource: DataSource;
  
  private _deploymentRepo?: DeploymentRepository;
  private _assignmentRepo?: DeploymentAssignmentRepository;
  private _configVersionRepo?: ConfigVersionRepository;
  private _dataSourceRepo?: DataSourceRepository;
  private _projectRepo?: ProjectRepository;
  private _projectMemberRepo?: ProjectMemberRepository;
  private _healthReportRepo?: HealthReportRepository;
  private _metricsRepo?: MetricsRepository;
  private _bucketHealthRepo?: BucketHealthRepository;

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
  }

  get deploymentRepo(): DeploymentRepository {
    if (!this._deploymentRepo) {
      this._deploymentRepo = new DeploymentRepository(this.dataSource);
    }
    return this._deploymentRepo;
  }

  get assignmentRepo(): DeploymentAssignmentRepository {
    if (!this._assignmentRepo) {
      this._assignmentRepo = new DeploymentAssignmentRepository(this.dataSource);
    }
    return this._assignmentRepo;
  }

  get configVersionRepo(): ConfigVersionRepository {
    if (!this._configVersionRepo) {
      this._configVersionRepo = new ConfigVersionRepository(this.dataSource);
    }
    return this._configVersionRepo;
  }

  get dataSourceRepo(): DataSourceRepository {
    if (!this._dataSourceRepo) {
      this._dataSourceRepo = new DataSourceRepository(this.dataSource);
    }
    return this._dataSourceRepo;
  }

  get projectRepo(): ProjectRepository {
    if (!this._projectRepo) {
      this._projectRepo = new ProjectRepository(this.dataSource);
    }
    return this._projectRepo;
  }

  get projectMemberRepo(): ProjectMemberRepository {
    if (!this._projectMemberRepo) {
      this._projectMemberRepo = new ProjectMemberRepository(this.dataSource);
    }
    return this._projectMemberRepo;
  }

  get healthReportRepo(): HealthReportRepository {
    if (!this._healthReportRepo) {
      this._healthReportRepo = new HealthReportRepository(this.dataSource);
    }
    return this._healthReportRepo;
  }

  get metricsRepo(): MetricsRepository {
    if (!this._metricsRepo) {
      this._metricsRepo = new MetricsRepository(this.dataSource);
    }
    return this._metricsRepo;
  }

  get bucketHealthRepo(): BucketHealthRepository {
    if (!this._bucketHealthRepo) {
      this._bucketHealthRepo = new BucketHealthRepository(this.dataSource);
    }
    return this._bucketHealthRepo;
  }
}

let repositoryFactory: RepositoryFactory | null = null;

export function initializeRepositoryFactory(dataSource: DataSource): void {
  repositoryFactory = new RepositoryFactory(dataSource);
}

export function getRepositoryFactory(): RepositoryFactory {
  if (!repositoryFactory) {
    throw new Error('RepositoryFactory not initialized. Call initializeRepositoryFactory() first.');
  }
  return repositoryFactory;
}
