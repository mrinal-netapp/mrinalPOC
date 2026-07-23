import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { DataSetManifestFile } from './DataSetManifestFile';

export type ManifestStatus = 'draft' | 'committed' | 'deprecated';

@Entity('data_set_manifests')
@Index(['dataSetId', 'manifestId'], { unique: true })
@Index(['dataSetId', 'status'])
export class DataSetManifest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 12 })
  dataSetId!: string;

  @Column('integer')
  manifestId!: number;

  @Column({
    type: 'enum',
    enum: ['draft', 'committed', 'deprecated'],
    default: 'draft',
  })
  status!: ManifestStatus;

  @Column('jsonb', { nullable: true })
  metadata?: Record<string, any>;

  @Column('jsonb', { nullable: true })
  schema?: Record<string, any>;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => DataSetManifestFile, (file) => file.manifest)
  files!: DataSetManifestFile[];
}

