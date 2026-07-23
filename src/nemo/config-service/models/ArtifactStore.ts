import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  BeforeInsert,
} from 'typeorm';
import { ArtifactStoreIdGenerator } from '../services/ArtifactStoreIdGenerator';

export type ArtifactStoreState = 'active' | 'archived' | 'deleting';

@Entity('artifact_stores')
@Index(['projectId', 'name'], { unique: true })
@Index(['projectId', 'state'])
export class ArtifactStore {
  @PrimaryColumn('varchar', { length: 10 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = ArtifactStoreIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column({ length: 128 })
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column()
  ownerUserId!: string;

  @Column('varchar', { length: 64, default: 'main' })
  defaultBranch!: string;

  @Column('int', { default: 102400 })
  lfsThresholdBytes!: number;

  @Column('bigint', { nullable: true })
  quotaBytes?: number;

  @Column({
    type: 'enum',
    enum: ['active', 'archived', 'deleting'],
    default: 'active',
  })
  state!: ArtifactStoreState;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
