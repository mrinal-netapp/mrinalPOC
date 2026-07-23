import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  Index,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { WorkspaceTemplate } from './WorkspaceTemplate';
import { WorkspaceIdGenerator } from '../services/WorkspaceIdGenerator';

export type WorkspaceStatus = 'new' | 'creating' | 'running' | 'stopping' | 'stopped' | 'error';

@Entity('workspaces')
@Index(['projectId', 'name'], { unique: true })
export class Workspace {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  /**
   * Generate short workspace ID before insert if not provided
   * Format: Base36 (0-9, a-z), 10 characters
   */
  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = WorkspaceIdGenerator.generate(10);
    }
  }

  @Column()
  projectId!: string;

  @Column('uuid')
  templateId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: ['new', 'creating', 'running', 'stopping', 'stopped', 'error'],
    default: 'new',
  })
  status!: WorkspaceStatus;

  @Column('text', { nullable: true })
  endpoint?: string; // JupyterLab URL

  @Column('text', { nullable: true })
  podName?: string; // Kubernetes pod name

  @Column('text', { nullable: true })
  deploymentId?: string; // Which deployment/region this workspace is running in

  @Column('text', { nullable: true })
  bucketName?: string; // S3 bucket for user code storage

  @Column('text', { nullable: true })
  pvcName?: string; // Kubernetes PVC name for ephemeral storage

  @Column('jsonb', { nullable: true })
  metadata?: {
    lastSyncAt?: string;
    imageTag?: string;
    libraryInstallStatus?: 'pending' | 'installing' | 'completed' | 'failed';
    errorMessage?: string;
    jupyterToken?: string;
    tokenGeneratedAt?: string;
    tokenExpiry?: string;
    resources?: {
      cpu?: string; // e.g., "2"
      memory?: string; // e.g., "4Gi"
      storage?: string; // e.g., "10Gi"
    };
  };

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @Column('timestamp', { nullable: true })
  lastAccessedAt?: Date;

  @ManyToOne(() => WorkspaceTemplate, (template) => template.workspaces)
  @JoinColumn({ name: 'templateId' })
  template!: WorkspaceTemplate;
}

