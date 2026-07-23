import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Project } from './Project';

/**
 * Project Service Account
 * Stores Keycloak OIDC client credentials for project-level service accounts.
 * Each project has one service account used for background jobs and workflows.
 */
@Entity('project_service_accounts')
export class ProjectServiceAccount {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'project_id' })
  project_id!: string;

  @Column({ type: 'varchar', length: 255, name: 'client_id' })
  client_id!: string; // Keycloak client ID (e.g., "project-{project_id}-service")

  @Column({ type: 'text', name: 'client_secret_encrypted' })
  client_secret_encrypted!: string; // Encrypted client secret

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
