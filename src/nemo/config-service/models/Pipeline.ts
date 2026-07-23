import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { PipelineHistory } from './history/PipelineHistory';
import { PipelineIdGenerator } from '../services/PipelineIdGenerator';

export type NodeType = string; // Allow any string type

export interface PipelineNode {
  id: string;
  type: NodeType;
  config?: Record<string, any>;
  metadata?: Record<string, any>;
}

export interface PipelineEdge {
  from: string; // node id
  to: string; // node id
  config?: Record<string, any>;
}

export interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
}

@Entity('pipelines')
@Index(['projectId', 'name'], { unique: true })
export class Pipeline {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  /**
   * Generate short pipeline ID before insert if not provided
   * Format: pl-<8 alphanumeric lowercase characters>
   */
  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = PipelineIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column({ type: 'enum', enum: ['Data', 'API'], default: 'Data' })
  type!: 'Data' | 'API';

  @Column('jsonb')
  graph!: PipelineGraph;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => PipelineHistory, (history) => history.entity)
  history!: PipelineHistory[];
}

