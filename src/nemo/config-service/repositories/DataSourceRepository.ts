import { Repository, DataSource as TypeORMDataSource } from 'typeorm';
import { DataSource as DataSourceEntity } from '../models/DataSource';
import {
  DataSourceModel,
  CreateDataSourceRequest,
  UpdateDataSourceRequest,
  DataSourceType,
  ScanConfig,
  ScanStatus,
  ScanResult,
} from '../types/dataSource';

export class DataSourceRepository {
  private repo: Repository<DataSourceEntity>;

  constructor(dataSource: TypeORMDataSource) {
    this.repo = dataSource.getRepository(DataSourceEntity);
  }

  async create(projectId: string, request: CreateDataSourceRequest, actor?: string): Promise<DataSourceModel> {
    const entity = this.repo.create({
      projectId,
      name: request.name,
      type: request.type,
      description: request.description || undefined,
      volumeConfig: request.volume_config || undefined,
      connectorConfig: request.connector_config || undefined,
      credentialId: request.credential_id || undefined,
      metadata: request.metadata || {},
      labels: request.labels && request.labels.length > 0 ? request.labels : undefined,
      scanConfig: request.scan_config as DataSourceEntity['scanConfig'] | undefined,
      modifiedBy: actor || undefined,
    });
    const saved = await this.repo.save(entity);
    return this.mapEntityToModel(saved);
  }

  async get(projectId: string, id: string): Promise<DataSourceModel | null> {
    const entity = await this.repo.findOne({
      where: { id, projectId },
    });
    return entity ? this.mapEntityToModel(entity) : null;
  }

  async getByName(projectId: string, name: string): Promise<DataSourceModel | null> {
    const entity = await this.repo.findOne({
      where: { projectId, name },
    });
    return entity ? this.mapEntityToModel(entity) : null;
  }

  async update(projectId: string, id: string, request: UpdateDataSourceRequest, actor?: string): Promise<DataSourceModel> {
    const entity = await this.repo.findOne({
      where: { id, projectId },
    });
    if (!entity) {
      throw new Error('DataSource not found');
    }

    if (actor) {
      entity.modifiedBy = actor;
    }
    if (request.name !== undefined) {
      entity.name = request.name;
    }
    if (request.description !== undefined) {
      const trimmed = request.description.trim();
      entity.description = trimmed === '' ? null : request.description;
    }
    if (request.volume_config !== undefined && entity.type === 'volume') {
      entity.volumeConfig = {
        ...entity.volumeConfig!,
        ...request.volume_config,
        volume_info: request.volume_config.volume_info
          ? { ...entity.volumeConfig?.volume_info, ...request.volume_config.volume_info }
          : entity.volumeConfig?.volume_info!,
        auth_info: request.volume_config.auth_info
          ? { ...entity.volumeConfig?.auth_info, ...request.volume_config.auth_info }
          : entity.volumeConfig?.auth_info!,
      };
    }
    if (request.connector_config !== undefined && entity.type === 'connector') {
      entity.connectorConfig = {
        ...entity.connectorConfig!,
        ...request.connector_config,
      } as typeof entity.connectorConfig;
    }
    if (request.credential_id !== undefined) {
      entity.credentialId = request.credential_id;
    }
    if (request.metadata !== undefined) {
      entity.metadata = { ...entity.metadata, ...request.metadata };
    }
    if (Array.isArray(request.labels)) {
      // Treat an explicit empty array as "clear all labels"; use null so TypeORM
      // persists the column wipe (undefined would be skipped on save).
      // `labels: null` is allowed by the validator (optional({ values: 'null' }))
      // and means "not provided" — skip the update in that case.
      entity.labels = request.labels.length > 0 ? request.labels : null;
    }
    if (request.deprecated !== undefined) {
      entity.deprecated = request.deprecated;
    }
    if (request.mount_health !== undefined) {
      entity.mountHealth = request.mount_health as typeof entity.mountHealth;
    }
    if (request.scan_config !== undefined) {
      entity.scanConfig = request.scan_config as typeof entity.scanConfig;
    }

    const saved = await this.repo.save(entity);
    return this.mapEntityToModel(saved);
  }

  /**
   * Persist scan lifecycle updates (called by both public routes and the internal
   * workflow-engine callback). At least one of scan_status / scan_result must be set.
   */
  async updateScanState(
    projectId: string,
    id: string,
    patch: { scan_status?: ScanStatus; scan_result?: ScanResult | null }
  ): Promise<DataSourceModel> {
    const entity = await this.repo.findOne({ where: { id, projectId } });
    if (!entity) {
      throw new Error('DataSource not found');
    }
    if (patch.scan_status !== undefined) {
      entity.scanStatus = patch.scan_status as typeof entity.scanStatus;
    }
    // Pass `scan_result: null` to explicitly clear a previous result (e.g.
    // when starting a new scan so the UI doesn't show a stale completed
    // result while state is pending/scanning).
    if (patch.scan_result !== undefined) {
      entity.scanResult = (patch.scan_result ?? null) as typeof entity.scanResult;
    }
    const saved = await this.repo.save(entity);
    return this.mapEntityToModel(saved);
  }

  /**
   * Persist the initial scan_config supplied at create time without changing
   * anything else. Used by the route layer to reset scan_config on a manual
   * /scan trigger that overrides the stored value.
   */
  async updateScanConfig(
    projectId: string,
    id: string,
    scanConfig: ScanConfig
  ): Promise<DataSourceModel> {
    const entity = await this.repo.findOne({ where: { id, projectId } });
    if (!entity) {
      throw new Error('DataSource not found');
    }
    entity.scanConfig = scanConfig as typeof entity.scanConfig;
    const saved = await this.repo.save(entity);
    return this.mapEntityToModel(saved);
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const result = await this.repo.delete({ id, projectId });
    return (result.affected || 0) > 0;
  }

  async list(
    projectId: string,
    options?: { type?: DataSourceType; limit?: number; skip?: number; nameRegex?: string }
  ): Promise<DataSourceModel[]> {
    const qb = this.repo
      .createQueryBuilder('ds')
      .where('ds.projectId = :projectId', { projectId })
      .orderBy('ds.createdAt', 'DESC');

    if (options?.type) {
      qb.andWhere('ds.type = :type', { type: options.type });
    }
    if (options?.nameRegex) {
      qb.andWhere('ds.name ILIKE :nameRegex', { nameRegex: `%${options.nameRegex}%` });
    }
    if (options?.limit) {
      qb.limit(options.limit);
    }
    if (options?.skip) {
      qb.offset(options.skip);
    }

    const entities = await qb.getMany();
    return entities.map((e) => this.mapEntityToModel(e));
  }

  async exists(projectId: string, name: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { projectId, name },
    });
    return count > 0;
  }

  async existsById(projectId: string, id: string): Promise<boolean> {
    const count = await this.repo.count({
      where: { id, projectId },
    });
    return count > 0;
  }

  /**
   * Get the raw TypeORM entity (for internal use by services that need the entity directly)
   */
  async getEntity(projectId: string, id: string): Promise<DataSourceEntity | null> {
    return this.repo.findOne({ where: { id, projectId } });
  }

  async getEntityByName(projectId: string, name: string): Promise<DataSourceEntity | null> {
    return this.repo.findOne({ where: { projectId, name } });
  }

  async updateConnectionTestResult(
    projectId: string,
    id: string,
    result: { success: boolean; message?: string }
  ): Promise<DataSourceModel> {
    const entity = await this.repo.findOne({
      where: { id, projectId },
    });
    if (!entity) {
      throw new Error('DataSource not found');
    }
    entity.lastConnectionTestAt = new Date();
    entity.lastConnectionTestStatus = result.success ? 'success' : 'failed';
    entity.lastConnectionTestMessage = result.message ?? undefined;
    const saved = await this.repo.save(entity);
    return this.mapEntityToModel(saved);
  }

  private mapEntityToModel(entity: DataSourceEntity): DataSourceModel {
    return {
      id: entity.id,
      project_id: entity.projectId,
      name: entity.name,
      type: entity.type,
      description: entity.description || undefined,
      volume_config: entity.volumeConfig || undefined,
      connector_config: entity.connectorConfig || undefined,
      credential_id: entity.credentialId || undefined,
      metadata: entity.metadata || {},
      labels: entity.labels ?? undefined,
      deprecated: entity.deprecated ?? false,
      mount_health: entity.mountHealth || undefined,
      scan_config: entity.scanConfig as ScanConfig | undefined,
      scan_status: entity.scanStatus as ScanStatus | undefined,
      scan_result: entity.scanResult as ScanResult | undefined,
      scanned_data_count: entity.scanResult?.total_files ?? null,
      modified_by: entity.modifiedBy ?? '',
      last_connection_test_at: entity.lastConnectionTestAt?.toISOString(),
      last_connection_test_status: entity.lastConnectionTestStatus ?? undefined,
      last_connection_test_message: entity.lastConnectionTestMessage ?? undefined,
      created_at: entity.createdAt.toISOString(),
      updated_at: entity.updatedAt.toISOString(),
    };
  }
}
