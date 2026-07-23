import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('credentials')
@Index(['projectId', 'name'], { unique: true })
export class Credential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  /** Provider/vendor identifier: aws, openai, azure, google, etc. */
  @Column()
  provider!: string;

  /** K8s Secret name in the shared application namespace — no raw secrets stored in DB */
  @Column()
  secretName!: string;

  /** Provider-specific config (region, endpoint, api_version, etc.) */
  @Column('jsonb', { nullable: true })
  metadata?: Record<string, any>;

  /** User-managed tags for filtering (e.g. ["model_provider", "bedrock"]) */
  @Column('simple-array', { nullable: true })
  labels?: string[];

  @Column('timestamp', { nullable: true })
  expiresAt?: Date;

  @Column('timestamp', { nullable: true })
  lastRotatedAt?: Date;

  @Column('int', { default: 1 })
  rotationVersion!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
