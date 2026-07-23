import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
  BeforeInsert,
} from 'typeorm';
import { DataSetHistory } from './history/DataSetHistory';
import { DataSetIdGenerator } from '../services/DataSetIdGenerator';

export type DataSetKind = 'unstructured' | 'structured';
export type DataSetType = 'acquired' | 'manual';
export type DataSetStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

/**
 * Rich, user-facing schedule shape persisted as the `refresh_config` JSONB
 * column on `data_sets`. Coexists with `scheduleConfig`: the service derives
 * a cron expression from this object and writes it (plus the resulting
 * `temporalScheduleId`) into the legacy `scheduleConfig` field so the
 * workflow-engine reader keeps working unchanged.
 */
export type DatasetRefreshScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface DatasetRefreshConfig {
  auto_refresh_enabled: boolean;
  schedule_type: DatasetRefreshScheduleType;
  interval_minutes?: number;
  time_of_day?: string;
  day_of_week?: number[];
  day_of_month?: number;
  timezone?: string;
  cron_expression?: string;
  paused: boolean;
}

@Entity('data_sets')
@Index(['projectId', 'name'], { unique: true })
@Index(['projectId', 'createdAt'])
@Index(['projectId', 'status'])
export class DataSet {
  @PrimaryColumn('varchar', { length: 12 })
  id!: string;

  /**
   * Generate short dataset ID before insert if not provided
   * Format: dset<8 alphanumeric lowercase characters>
   */
  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = DataSetIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text')
  description!: string;

  @Column({
    type: 'enum',
    enum: ['acquired', 'manual'],
    default: 'acquired',
  })
  type!: DataSetType;

  @Column('varchar', { length: 12, nullable: true })
  originConnector?: string;

  /** When set, acquisition reads from a mounted volume data source (ONTAP/NFS) instead of originConnector. */
  @Column('varchar', { length: 12, nullable: true })
  originVolume?: string;

  /** For acquired DB datasets: override connector database when connector has none (e.g. chosen from explorer). */
  @Column('varchar', { length: 255, nullable: true })
  sourceDatabase?: string;

  /** For acquired DB datasets: override connector default schema when needed. */
  @Column('varchar', { length: 255, nullable: true })
  sourceSchema?: string;

  @Column({
    type: 'enum',
    enum: ['unstructured', 'structured'],
  })
  kind!: DataSetKind;

  @Column('jsonb', { nullable: true })
  filterSpec?: Record<string, any>;

  @Column('text', { array: true, nullable: true })
  fileProcessors?: string[];

  /**
   * Optional user-supplied labels (free-form tags) for organization, search,
   * and bulk operations. Stored as a Postgres TEXT[] column; absent / empty
   * array means "no labels".
   */
  @Column('text', { array: true, nullable: true })
  labels?: string[];

  @Column('text', { nullable: true })
  sqlQuery?: string;

  @Column('varchar', { length: 255, nullable: true })
  bucketName?: string;

  // Catalog integration fields
  @Column('varchar', { length: 255, nullable: true })
  warehouseName?: string; // Maps to bucketName for catalog warehouse

  @Column('text', { nullable: true })
  namespace?: string; // Catalog namespace (usually projectId)

  @Column('varchar', { length: 255, nullable: true })
  catalogTableName?: string; // Table name in catalog

  @Column('text', { nullable: true })
  catalogTableRef?: string; // Full reference: namespace.table

  // Processing status fields
  @Column({
    type: 'enum',
    enum: ['in_progress', 'ready', 'errored', 'deprecated'],
    default: 'in_progress',
    nullable: true,
  })
  status?: DataSetStatus; // Processing status: in_progress -> ready/errored

  @Column('varchar', { length: 255, nullable: true })
  jobId?: string; // Temporal workflow execution ID

  @Column('text', { nullable: true })
  errorMessage?: string; // Error details if processing fails

  /** Subject (sub) of the user who last created/updated this dataset. */
  @Column({ name: 'modified_by', type: 'varchar', nullable: true })
  modifiedBy?: string;

  /**
   * Aggregate counts captured at import completion (status -> ready). Read by
   * the list/detail endpoints so files_count is available without a catalog call.
   */
  @Column('jsonb', { nullable: true })
  stats?: {
    sourceFileCount?: number;
    rowCount?: number;
    columnCount?: number;
  };

  /**
   * Summary of the latest catalog snapshot, captured at import completion.
   * Lets the list/detail endpoints surface latest_snapshot without reading the
   * Iceberg catalog on every request.
   */
  @Column('jsonb', { name: 'latest_snapshot', nullable: true })
  latestSnapshot?: {
    snapshotId: number;
    version: number;
    timestampMs: number;
    totalFiles?: number;
    filesAdded?: number;
    filesRemoved?: number;
  };

  // PII analysis flags (set at dataset creation, used by import workflow)
  @Column('boolean', { default: false, nullable: true })
  enablePiiAnalysis?: boolean;

  @Column('boolean', { default: false, nullable: true })
  piiAnalysisImageOnly?: boolean;

  // PII analysis summary (populated by the processor for unstructured datasets)
  @Column('jsonb', { nullable: true })
  piiSummary?: {
    filesWithPii: number;
    totalFiles: number;
    piiAnalysisEnabled: boolean;
  };

  @Column('jsonb', { nullable: true })
  resourceSelector?: Array<Record<string, any>>;

  @Column('jsonb', { nullable: true })
  acquisitionConfig?: {
    fileGlob?: string;
    fileIncludePattern?: string;
    fileExcludePattern?: string;
    maxFileSize?: number;
    modifiedAfter?: string;
    writeMode: 'append' | 'overwrite' | 'incremental';
    watermarkColumn?: string;
    lastWatermarkValue?: string;
    maxRows?: number;
    queryTimeoutSeconds?: number;
  };

  @Column('jsonb', { nullable: true })
  scheduleConfig?: {
    cronExpression: string;
    timezone: string;
    temporalScheduleId?: string;
    enabled: boolean;
  };

  /**
   * User-facing schedule (DatasetRefreshConfig). When set, the service derives
   * a cron expression and writes it into `scheduleConfig` so the workflow-engine
   * reader keeps working without change.
   */
  @Column('jsonb', { nullable: true, name: 'refresh_config' })
  refreshConfig?: DatasetRefreshConfig;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => DataSetHistory, (history) => history.entity)
  history!: DataSetHistory[];
}
