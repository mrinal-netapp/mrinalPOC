import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { DataSetManifest } from './DataSetManifest';

@Entity('data_set_manifest_files')
export class DataSetManifestFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column('uuid')
  manifestId!: string;

  @ManyToOne(() => DataSetManifest, (manifest) => manifest.files, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'manifestId' })
  manifest!: DataSetManifest;

  @Column('text')
  fileName!: string;

  @Column('text', { nullable: true })
  uri?: string;

  @CreateDateColumn()
  createdAt!: Date;
}

