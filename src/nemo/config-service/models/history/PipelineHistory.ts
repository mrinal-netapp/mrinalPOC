import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Pipeline } from '../Pipeline';

@Entity('pipeline_history')
@Index(['entityId', 'version'], { unique: true })
export class PipelineHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  entityId!: string;

  @ManyToOne(() => Pipeline, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: Pipeline;

  @Column('int')
  version!: number;

  @Column('jsonb')
  data!: any;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  modifiedAt!: Date;

  @Column('text', { nullable: true })
  modifiedBy?: string;

  @Column('text', { nullable: true })
  op?: string;
}

