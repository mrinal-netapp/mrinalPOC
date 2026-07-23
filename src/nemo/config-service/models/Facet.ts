import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

export type FacetEntityType = 'dataset' | 'knowledge_base' | 'agent' | 'project';
export type FacetState = 'in_progress' | 'ready' | 'errored';

@Entity('entity_facets')
@Unique(['projectId', 'entityType', 'entityId', 'facetType'])
@Index(['entityType', 'entityId'])
@Index(['projectId', 'entityType', 'facetType'])
export class Facet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 255 })
  projectId!: string;

  @Column('varchar', { length: 50 })
  entityType!: FacetEntityType;

  @Column('varchar', { length: 255 })
  entityId!: string;

  @Column('varchar', { length: 50 })
  facetType!: string; // e.g. 'pii', 'embedding', 'usage'

  @Column({
    type: 'enum',
    enum: ['in_progress', 'ready', 'errored'],
    default: 'in_progress',
  })
  state!: FacetState;

  @Column('varchar', { length: 255, nullable: true })
  jobId?: string; // Workflow execution ID when state is in_progress

  @Column('text', { nullable: true })
  errorMessage?: string;

  @Column('jsonb', { nullable: true })
  summary?: Record<string, any>; // Facet-type-specific final stats

  @UpdateDateColumn()
  lastUpdated!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
