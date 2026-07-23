import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Model } from '../Model';

@Entity('model_history')
@Index(['entityId', 'version'], { unique: true })
export class ModelHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  entityId!: string;

  @ManyToOne(() => Model, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: Model;

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
