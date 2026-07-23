import { Entity, PrimaryColumn, Column, CreateDateColumn, OneToMany } from 'typeorm';
import { DeploymentAssignment } from './DeploymentAssignment';
import { Metrics } from './Metrics';
import { HealthReport } from './HealthReport';
import { BucketHealth } from './BucketHealth';

@Entity('deployments')
export class Deployment {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  region!: string;

  @Column({ type: 'varchar', length: 255 })
  endpoint!: string; // HTTPS endpoint (default, used for most operations)

  @Column({ type: 'varchar', length: 255, name: 'http_endpoint', nullable: true })
  http_endpoint?: string; // HTTP endpoint (used for internal operations like Lakekeeper)

  @Column({ type: 'jsonb', nullable: true })
  capacity?: {
    max_buckets?: number;
    max_storage_tb?: number;
  };

  @Column({ type: 'jsonb', nullable: true })
  capabilities?: string[];

  @Column({ type: 'jsonb', nullable: true, name: 'storage_classes' })
  storage_classes?: string[];

  @CreateDateColumn({ type: 'timestamp', name: 'registered_at' })
  registered_at!: Date;

  @Column({ type: 'timestamp', name: 'last_health_check', nullable: true })
  last_health_check?: Date;

  @Column({ type: 'varchar', length: 50, default: 'unknown' })
  status!: 'healthy' | 'unhealthy' | 'unknown';

  @OneToMany(() => DeploymentAssignment, assignment => assignment.deployment)
  assignments!: DeploymentAssignment[];

  @OneToMany(() => Metrics, metrics => metrics.deployment)
  metrics!: Metrics[];

  @OneToMany(() => HealthReport, healthReport => healthReport.deployment)
  healthReports!: HealthReport[];

  @OneToMany(() => BucketHealth, bucketHealth => bucketHealth.deployment)
  bucketHealth!: BucketHealth[];
}

