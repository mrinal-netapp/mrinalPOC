import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Project } from './Project';

export type ProjectRole = 'admin' | 'member';

@Entity('project_members')
export class ProjectMember {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'project_id' })
  project_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'user_id' })
  user_id!: string; // Keycloak user ID (sub claim)

  @Column({ type: 'varchar', length: 50 })
  role!: ProjectRole; // 'admin' or 'member'

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'invited_by' })
  invited_by?: string; // User ID who invited this member

  @Column({ type: 'timestamp', nullable: true, name: 'invited_at' })
  invited_at?: Date;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at!: Date;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;
}
