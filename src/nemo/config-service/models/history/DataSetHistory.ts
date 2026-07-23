import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DataSet } from '../DataSet';

@Entity('data_set_history')
@Index(['entityId', 'version'], { unique: true })
export class DataSetHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  entityId!: string;

  @ManyToOne(() => DataSet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: DataSet;

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
