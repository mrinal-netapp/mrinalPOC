import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DataSource } from '../DataSource';

@Entity('data_source_history')
@Index(['entityId', 'version'], { unique: true })
export class DataSourceHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  entityId!: string;

  @ManyToOne(() => DataSource, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'entityId' })
  entity!: DataSource;

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
