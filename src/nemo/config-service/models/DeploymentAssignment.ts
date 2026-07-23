import { Entity, PrimaryColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { DataSource } from './DataSource';
import { Deployment } from './Deployment';

@Entity('deployment_assignments')
export class DeploymentAssignment {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'project_id' })
  project_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'data_source_name' })
  data_source_name!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'deployment_id' })
  deployment_id!: string;

  @Column({ type: 'varchar', length: 12, name: 'data_source_id', nullable: true })
  data_source_id?: string;

  @Column({ type: 'varchar', length: 50 })
  role!: 'primary' | 'secondary';

  @Column({ type: 'integer', default: 0 })
  priority!: number;

  @CreateDateColumn({ type: 'timestamp', name: 'assigned_at' })
  assigned_at!: Date;

  @Column({ type: 'text', name: 'assignment_reason', nullable: true })
  assignment_reason?: string;

  @Column({ type: 'varchar', length: 50, default: 'active' })
  status!: 'active' | 'inactive';

  @Column({ type: 'integer', name: 'load_balance_weight', default: 100 })
  load_balance_weight!: number;

  @ManyToOne(() => DataSource, ds => ds.assignments, { onDelete: 'CASCADE' })
  @JoinColumn([{ name: 'project_id', referencedColumnName: 'projectId' }, { name: 'data_source_name', referencedColumnName: 'name' }])
  dataSource!: DataSource;

  @ManyToOne(() => Deployment, deployment => deployment.assignments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deployment_id' })
  deployment!: Deployment;
}
