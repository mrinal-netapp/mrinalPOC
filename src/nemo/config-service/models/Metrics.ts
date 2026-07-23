import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { Deployment } from './Deployment';

@Entity('metrics')
export class Metrics {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, name: 'deployment_id' })
  deployment_id!: string;

  @CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  timestamp!: Date;

  @Column({ type: 'jsonb', name: 'metrics_data', nullable: true })
  metrics_data?: {
    request_latency_p50_ms?: number;
    request_latency_p95_ms?: number;
    request_latency_p99_ms?: number;
    requests_per_second?: number;
    error_rate?: number;
    cpu_usage_percent?: number;
    memory_usage_percent?: number;
    disk_io_utilization?: number;
  };

  @Column({ type: 'jsonb', name: 'bucket_metrics', nullable: true })
  bucket_metrics?: Record<string, {
    requests?: number;
    errors?: number;
    storage_bytes?: number;
  }>;

  @ManyToOne(() => Deployment, deployment => deployment.metrics, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'deployment_id' })
  deployment!: Deployment;
}

