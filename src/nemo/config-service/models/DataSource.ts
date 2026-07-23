import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { Project } from './Project';
import { DeploymentAssignment } from './DeploymentAssignment';
import { BucketHealth } from './BucketHealth';
import { DataSourceHistory } from './history/DataSourceHistory';
import { ConnectorIdGenerator } from '../services/ConnectorIdGenerator';
import { VolumeIdGenerator } from '../services/VolumeIdGenerator';

export type DataSourceType = 'volume' | 'connector';
// The legacy `metrics` connector type was merged into the primary connectors
// (ONTAP, GCP). Metric acquisition is now driven by metric_category resourceSelector
// entries on those primary connectors instead of a dedicated connector type.
export type ConnectorSubType = 'objectstore' | 'database' | 'cloud' | 'storage' | 'api';
export type ConnectorScope = 'account' | 'resource';
export type ProtocolType = 'NFS' | 'SMB';

@Entity('data_sources')
@Index(['projectId', 'name'], { unique: true })
export class DataSource {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = this.type === 'connector'
        ? ConnectorIdGenerator.generate()
        : VolumeIdGenerator.generate();
    }
  }

  @Column({ name: 'project_id' })
  projectId!: string;

  @Column()
  name!: string;

  @Column({
    type: 'enum',
    enum: ['volume', 'connector'],
  })
  type!: DataSourceType;

  @Column('text', { nullable: true })
  description?: string | null;

  @Column('jsonb', { name: 'volume_config', nullable: true })
  volumeConfig?: {
    region: string;
    volume_info: {
      type: string;
      endpoint?: string;
      mount_options?: string[];
      provisioning_mode?: 'static' | 'dynamic';
      storage_class_name?: string;
      storage_size?: string;
      parameters?: Record<string, string>;
      access_modes?: string[];
    };
    auth_info: {
      type: string;
      username?: string;
      password_encrypted?: string;
      [key: string]: any;
    };
    protocol: string;
    deployment_config?: Record<string, any>;
  };

  @Column('jsonb', { name: 'connector_config', nullable: true })
  connectorConfig?: {
    connector_type: ConnectorSubType;
    scope: ConnectorScope;
    provider: string;
    database_type?: 'postgresql' | 'mysql';
    host?: string;
    port?: number;
    database?: string;
    schema?: string;
    ssl_mode?: string;
    endpoint?: string;
    bucket?: string;
    prefix?: string;
    region?: string;
    project_id?: string;
    default_region?: string;
    // Storage system (NetApp ONTAP) fields — connector_type === 'storage'
    cluster_url?: string;
    verify_tls?: boolean;
    default_svm?: string;
    // API connector fields — connector_type === 'api'
    base_url?: string;
    include_query_results?: boolean;
    include_dashboards?: boolean;
    include_data_sources?: boolean;
    max_result_rows?: number;
  };

  @Column('varchar', { length: 36, nullable: true })
  credentialId?: string;

  @Column('jsonb', { default: {} })
  metadata!: Record<string, any>;

  /**
   * Optional user-supplied labels (free-form tags) for organization, search,
   * and bulk operations. Stored as a Postgres TEXT[] column; absent / empty
   * array means "no labels". Labels are validated as a string array at the
   * API layer.
   */
  @Column('text', { array: true, nullable: true })
  labels?: string[] | null;

  /**
   * Soft-retire flag. When true the data source is marked "Deprecated" in the
   * UI and excluded from new dataset/KB pickers, but existing references keep
   * working. Toggled via the data source update API.
   */
  @Column({ type: 'boolean', default: false })
  deprecated!: boolean;

  /** Last ONTAP NFS preflight / mount readiness snapshot (volumes). */
  @Column('jsonb', { name: 'mount_health', nullable: true })
  mountHealth?: {
    status: 'healthy' | 'unhealthy' | 'unknown';
    last_checked_at?: string;
    blocking?: string[];
    warnings?: string[];
    probed_lif?: string;
    repair_pending_pod_restart?: boolean;
    [key: string]: unknown;
  };

  /** Volume-only scan configuration captured at create/update time. */
  @Column('jsonb', { name: 'scan_config', nullable: true })
  scanConfig?: {
    scan_depth: 'none' | 'all_levels' | 'top_5_levels' | 'top_2_levels' | 'custom';
    custom_depth?: number | null;
  };

  /** Lifecycle state of the volume scan (drives the API `scan_status` field). */
  @Column('jsonb', { name: 'scan_status', nullable: true })
  scanStatus?: {
    state: 'pending' | 'scanning' | 'completed' | 'failed' | 'skipped';
    started_at?: string;
    completed_at?: string;
    workflow_id?: string;
    last_error?: string;
  };

  /** Result of the most recent successful volume scan. */
  @Column('jsonb', { name: 'scan_result', nullable: true })
  scanResult?: {
    completed_at: string;
    error_message?: string;
    total_files: number;
    total_folders: number;
    total_size_bytes: number;
    file_type_stats: Array<{ file_type: string; count: number }>;
  };

  /** Subject (sub) of the user who last created/updated this data source. */
  @Column({ name: 'modified_by', type: 'varchar', nullable: true })
  modifiedBy?: string;

  @Column({ name: 'last_connection_test_at', type: 'timestamptz', nullable: true })
  lastConnectionTestAt?: Date;

  @Column({ name: 'last_connection_test_status', type: 'varchar', length: 20, nullable: true })
  lastConnectionTestStatus?: 'success' | 'failed';

  @Column('text', { name: 'last_connection_test_message', nullable: true })
  lastConnectionTestMessage?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @ManyToOne(() => Project, (project) => project.dataSources, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project!: Project;

  @OneToMany(() => DeploymentAssignment, (assignment) => assignment.dataSource)
  assignments!: DeploymentAssignment[];

  @OneToMany(() => BucketHealth, (health) => health.dataSource)
  healthRecords!: BucketHealth[];

  @OneToMany(() => DataSourceHistory, (history) => history.entity)
  history!: DataSourceHistory[];
}
