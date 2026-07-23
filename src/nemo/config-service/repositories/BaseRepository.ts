import { Repository, DataSource, FindOptionsWhere, FindManyOptions, ObjectLiteral, EntityTarget } from 'typeorm';

/**
 * Base repository class providing common CRUD operations
 * Extend this class to create domain-specific repositories
 */
export abstract class BaseRepository<TEntity extends ObjectLiteral, TModel> {
  protected repo: Repository<TEntity>;

  constructor(dataSource: DataSource, entityClass: EntityTarget<TEntity>) {
    this.repo = dataSource.getRepository(entityClass);
  }

  /**
   * Create a new entity
   */
  async create(data: Partial<TModel>): Promise<TModel> {
    const entityData = this.mapModelToEntity(data);
    const entity = this.repo.create(entityData as any);
    const saved = await this.repo.save(entity);
    // Handle case where save() returns an array (shouldn't happen for single entity, but TypeORM types allow it)
    const savedEntity = Array.isArray(saved) ? saved[0] : saved;
    return this.mapEntityToModel(savedEntity);
  }

  /**
   * Get entity by ID
   */
  async getById(id: string): Promise<TModel | null> {
    const entity = await this.repo.findOne({ where: { id } as any });
    if (!entity) {
      return null;
    }
    return this.mapEntityToModel(entity);
  }

  /**
   * Update an entity
   */
  async update(id: string, data: Partial<TModel>): Promise<TModel> {
    const entity = await this.repo.findOne({ where: { id } as any });
    if (!entity) {
      throw new Error(`${this.getEntityName()} not found`);
    }

    this.updateEntityFromModel(entity, data);
    const updated = await this.repo.save(entity);
    return this.mapEntityToModel(updated);
  }

  /**
   * Delete an entity
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    return (result.affected || 0) > 0;
  }

  /**
   * List all entities
   */
  async list(options?: FindManyOptions<TEntity>): Promise<TModel[]> {
    const entities = await this.repo.find(options || {});
    return entities.map(e => this.mapEntityToModel(e));
  }

  /**
   * Check if entity exists
   */
  async exists(id: string): Promise<boolean> {
    const count = await this.repo.count({ where: { id } as any });
    return count > 0;
  }

  /**
   * Get repository instance for advanced queries
   */
  protected getRepository(): Repository<TEntity> {
    return this.repo;
  }

  /**
   * Map entity to model - must be implemented by subclasses
   */
  protected abstract mapEntityToModel(entity: TEntity): TModel;

  /**
   * Map model to entity - must be implemented by subclasses
   */
  protected abstract mapModelToEntity(model: Partial<TModel>): Partial<TEntity>;

  /**
   * Update entity from model - can be overridden for custom update logic
   */
  protected updateEntityFromModel(entity: TEntity, model: Partial<TModel>): void {
    const entityData = this.mapModelToEntity(model);
    Object.assign(entity as any, entityData);
  }

  /**
   * Get entity name for error messages
   */
  protected abstract getEntityName(): string;
}

