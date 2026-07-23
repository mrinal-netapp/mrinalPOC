import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { ProjectInitStatus } from '../types/project';
import { DataSource } from './DataSource';

@Entity('projects')
export class Project {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @CreateDateColumn({ type: 'timestamp', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamp', name: 'updated_at' })
  updated_at!: Date;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, any>;

  @Column({ type: 'text', nullable: false })
  home_dir!: string;

  // Project initialization lifecycle. The row is created as 'provisioning'; the
  // async ProjectInitWorkflow reports 'ready' on success or 'failed' on error.
  @Column({
    type: 'varchar',
    length: 20,
    name: 'init_status',
    default: ProjectInitStatus.Provisioning,
  })
  init_status!: ProjectInitStatus;

  @Column({ type: 'text', name: 'init_error', nullable: true })
  init_error?: string | null;

  @OneToMany(() => DataSource, ds => ds.project)
  dataSources!: DataSource[];
}

