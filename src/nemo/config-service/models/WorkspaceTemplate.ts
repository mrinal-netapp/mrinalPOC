import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { Workspace } from './Workspace';

export type WorkspaceType = 'jupyterlab' | 'vscode' | 'custom';

@Entity('workspace_templates')
@Index(['projectId', 'name'], { unique: true })
export class WorkspaceTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text')
  description!: string;

  @Column({
    type: 'enum',
    enum: ['jupyterlab', 'vscode', 'custom'],
    default: 'jupyterlab',
  })
  type!: WorkspaceType;

  @Column('jsonb')
  environment!: {
    baseImage?: string; // e.g., "jupyter/scipy-notebook:latest"
    pythonVersion?: string; // e.g., "3.11"
    nodeVersion?: string;
    libraries?: Array<{
      name: string;
      version: string;
      packageManager?: 'pip' | 'conda' | 'npm';
    }>;
    environmentVariables?: Record<string, string>;
  };

  @Column('jsonb', { nullable: true })
  jupyterConfig?: {
    extensions?: string[];
    settings?: Record<string, any>;
  };

  @Column('jsonb', { nullable: true })
  resources?: {
    cpu?: string; // e.g., "2"
    memory?: string; // e.g., "4Gi"
    storage?: string; // e.g., "10Gi"
    gpu?: boolean;
  };

  @Column('text', { nullable: true })
  startupScript?: string; // Base64 encoded script to run on launch

  @Column('text', { nullable: true })
  homeUrl?: string; // Default home URL path for the workspace (e.g., "/lab" for JupyterLab, "/" for VS Code)

  @Column('boolean', { default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => Workspace, (workspace) => workspace.template)
  workspaces!: Workspace[];
}

