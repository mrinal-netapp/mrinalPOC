import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type ArtifactStorePrincipalType = 'user' | 'agent' | 'team' | 'service';
export type ArtifactStoreAclRole = 'owner' | 'writer' | 'reader';

@Entity('artifact_store_acls')
@Index(['storeId', 'principalType', 'principalId'], { unique: true })
@Index(['principalType', 'principalId'])
export class ArtifactStoreAcl {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('varchar', { length: 10 })
  storeId!: string;

  @Column({
    type: 'enum',
    enum: ['user', 'agent', 'team', 'service'],
  })
  principalType!: ArtifactStorePrincipalType;

  @Column()
  principalId!: string;

  @Column({
    type: 'enum',
    enum: ['owner', 'writer', 'reader'],
  })
  role!: ArtifactStoreAclRole;

  @Column({ nullable: true })
  grantedBy?: string;

  @CreateDateColumn()
  grantedAt!: Date;
}
