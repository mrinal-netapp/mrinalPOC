import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Deployment } from './Deployment';

@Entity('health_reports')
export class HealthReport {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'deployment_id' })
  deployment_id!: string;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp!: Date;

  @Column({ type: 'boolean' })
  healthy!: boolean;

  @Column({ type: 'text', name: 'status_message', nullable: true })
  status_message?: string;

  @Column({ type: 'jsonb', name: 'volume_mount_status', nullable: true })
  volume_mount_status?: Record<string, {
    mounted: boolean;
    status: string;
  }>;

  @ManyToOne(() => Deployment, deployment => deployment.healthReports, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deployment_id' })
  deployment!: Deployment;
}

