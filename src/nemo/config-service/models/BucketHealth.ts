import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, Index } from 'typeorm';
import { DataSource } from './DataSource';
import { Deployment } from './Deployment';

@Entity('bucket_health')
@Index(['project_id', 'data_source_name'])
@Index(['deployment_id'])
export class BucketHealth {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'project_id' })
  project_id!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'data_source_name' })
  data_source_name!: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'deployment_id' })
  deployment_id!: string;

  @Column({ type: 'varchar', length: 12, name: 'data_source_id', nullable: true })
  data_source_id?: string;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp!: Date;

  @Column({ type: 'boolean' })
  healthy!: boolean;

  @Column({ type: 'text', name: 'status_message', nullable: true })
  status_message?: string;

  @Column({ type: 'jsonb', name: 'volume_mount_status', nullable: true })
  volume_mount_status?: {
    mounted: boolean;
    status: string;
  };

  @ManyToOne(() => DataSource, ds => ds.healthRecords, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'project_id', referencedColumnName: 'projectId' },
    { name: 'data_source_name', referencedColumnName: 'name' }
  ])
  dataSource!: DataSource;

  @ManyToOne(() => Deployment, deployment => deployment.bucketHealth, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deployment_id' })
  deployment!: Deployment;
}
