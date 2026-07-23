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
import { KnowledgeBaseHistory } from './history/KnowledgeBaseHistory';
import { KnowledgeBaseIdGenerator } from '../services/KnowledgeBaseIdGenerator';

export type KnowledgeBaseStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

export type ChunkStrategy = 'fixed' | 'sentence' | 'recursive' | 'token' | 'markdown';

export type IndexingMode = 'hybrid' | 'semantic' | 'fts';

export type QuantizationType = 'none' | 'ivf_pq' | 'scalar' | 'ivf_rq';

/**
 * Synchronization (refresh) configuration for a knowledge base. Persisted as
 * the `synchronization_config` JSONB column. Coexists with the server-derived
 * `scheduleConfig` (cron + Temporal schedule id) just like the DataSet
 * `refresh_config` <-> `scheduleConfig` pair does.
 *
 * Snake-case field names match the public spec.
 */
export type KBSyncMode = 'manual' | 'after_dataset_updates' | 'scheduled';
export type KBSyncScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export interface KBSynchronizationConfig {
  sync_mode: KBSyncMode;
  schedule_type?: KBSyncScheduleType;
  interval_minutes?: number;
  time_of_day?: string;
  day_of_week?: number[];
  day_of_month?: number;
  timezone?: string;
  cron_expression?: string;
  data_change_threshold_enabled: boolean;
  data_change_threshold_value?: number;
}

export interface KnowledgeBaseScheduleConfig {
  cronExpression: string;
  timezone: string;
  temporalScheduleId?: string;
  enabled: boolean;
}

export interface ChunkOptions {
  maxSentences?: number;      // sentence strategy: max sentences per chunk
  overlapSentences?: number;  // sentence strategy: overlap sentences between chunks
  maxTokens?: number;         // token strategy: max tokens per chunk
  tokenOverlap?: number;      // token strategy: overlap tokens between chunks
  splitOnHeaders?: boolean;   // markdown strategy: split on headers
}

export interface QuantizationOptions {
  numPartitions?: number;   // IVF_PQ / IVF_HNSW_SQ / IVF_RQ: number of partitions
  numSubVectors?: number;   // IVF_PQ: PQ sub-vectors (default: 96)
  efConstruction?: number;  // IVF_HNSW_SQ: HNSW ef_construction (default: 150)
  m?: number;               // IVF_HNSW_SQ: HNSW connectivity parameter
  numBits?: number;         // IVF_RQ: bits per dimension (default: 1)
}

export interface KnowledgeBaseStats {
  documentCount?: number;      // Number of source documents processed
  chunkCount?: number;         // Total number of chunks created
  vectorCount?: number;        // Total number of vectors (same as chunks)
  storageBytes?: number;       // Total storage size in bytes
  storageMB?: number;          // Total storage size in megabytes
  fileCount?: number;          // Number of LanceDB files
  avgChunkSize?: number;       // Average chunk size in characters
  lastProcessedAt?: string;    // ISO 8601 timestamp of last processing
}

@Entity('knowledge_bases')
@Index(['projectId', 'name'], { unique: true })
export class KnowledgeBase {
  @PrimaryColumn('varchar', { length: 10 })
  id!: string;

  /**
   * Generate short knowledge base ID before insert if not provided
   * Format: kb<8 alphanumeric lowercase characters>
   */
  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = KnowledgeBaseIdGenerator.generate();
    }
  }

  @Column()
  projectId!: string;

  @Column()
  name!: string;

  @Column('text', { nullable: true })
  description?: string;

  @Column()
  sourceDataset!: string; // dataset id or name

  @Column()
  embeddingModel!: string;

  /**
   * FK to `models.id` for the embedding model used by this KB. Nullable for
   * back-compat with legacy KBs created before the unified embedding catalog
   * (those rows are linked to the seeded built-in row via a startup backfill
   * keyed on `embeddingModel` -> `Model.name`). New KBs must carry both:
   * the workflow input uses this FK to look up provider/providerModelId/
   * dimensions when dispatching the indexing activity.
   */
  @Column({ type: 'uuid', nullable: true })
  embeddingModelId?: string;

  @Column('int')
  chunkSize!: number;

  @Column('varchar', { length: 20, default: 'fixed' })
  chunkStrategy!: ChunkStrategy; // 'fixed' | 'sentence' | 'recursive' | 'token' | 'markdown'

  @Column('int', { nullable: true })
  chunkOverlap?: number; // Overlap between chunks (for fixed/token strategies)

  @Column('jsonb', { nullable: true })
  chunkOptions?: ChunkOptions; // Strategy-specific options

  @Column('varchar', { length: 20, default: 'hybrid' })
  indexingMode!: IndexingMode; // 'hybrid' | 'semantic' | 'fts' - controls FTS index creation and search behavior

  @Column('varchar', { length: 20, default: 'auto' })
  quantizationType!: QuantizationType; // 'auto' | 'none' | 'ivf_pq' | 'scalar' | 'ivf_rq' - vector index strategy

  @Column('jsonb', { nullable: true })
  quantizationOptions?: QuantizationOptions; // Options for IVF_PQ quantization (numPartitions, numSubVectors)

  @Column('int')
  vectorSize!: number;

  @Column({ nullable: true })
  dataType?: string; // Deprecated: no longer used in UI

  // Structured dataset support
  @Column('text', { nullable: true })
  textColumns?: string; // Comma-separated list of column names for text extraction (required for structured datasets)

  // Storage location
  @Column('varchar', { length: 255, nullable: true })
  bucketName?: string;

  @Column('text', { nullable: true })
  namespace?: string; // Set to projectId for KB namespace isolation

  @Column('text', { nullable: true })
  lanceTablePath?: string; // S3 path: s3://bucket/knowledgebases/{kbId}/lancedb

  // Processing status fields (following DataSet pattern)
  @Column({
    type: 'enum',
    enum: ['in_progress', 'ready', 'errored', 'deprecated'],
    default: 'in_progress',
    nullable: true,
  })
  status?: KnowledgeBaseStatus; // Processing status: in_progress -> ready/errored

  @Column('varchar', { length: 255, nullable: true })
  jobId?: string; // Temporal workflow execution ID

  @Column('text', { nullable: true })
  errorMessage?: string; // Error details if processing fails

  /**
   * Optional user-supplied labels (free-form tags) for organization, search,
   * and bulk operations. Stored as a Postgres TEXT[] column; absent / empty
   * array means "no labels".
   */
  @Column('text', { array: true, nullable: true })
  labels?: string[];

  @Column('jsonb', { nullable: true })
  progress?: {
    phase?: string;
    percentage?: number;
    totalFiles?: number;
    processedFiles?: number;
    totalDocuments?: number;
    chunksCreated?: number;
    vectorsCreated?: number;
    currentFile?: string;
    estimatedRemainingFormatted?: string;
    elapsedFormatted?: string;
    lastUpdated?: string;
    totalUnits?: number;
    units?: Array<{ unitId?: string; status?: string; metrics?: Record<string, unknown> }>;
  };

  @Column('jsonb', { nullable: true })
  stats?: KnowledgeBaseStats; // Detailed statistics from KB processing

  /**
   * User-facing synchronization config persisted as JSONB. The service derives
   * a cron expression from this object (when sync_mode='scheduled') and writes
   * the result plus the resulting Temporal schedule id into `scheduleConfig`.
   */
  @Column('jsonb', { nullable: true, name: 'synchronization_config' })
  synchronizationConfig?: KBSynchronizationConfig;

  /**
   * Server-derived schedule state (cron expression + Temporal schedule id).
   * Mirrors DataSet.scheduleConfig — read-only from the public API surface.
   */
  @Column('jsonb', { nullable: true })
  scheduleConfig?: KnowledgeBaseScheduleConfig;

  /**
   * ISO 8601 timestamp of the last successful KB sync. Used by the
   * after_dataset_updates trigger as the basis for the file-change diff
   * threshold check.
   */
  @Column('text', { nullable: true })
  lastSyncedAt?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @OneToMany(() => KnowledgeBaseHistory, (history) => history.entity)
  history!: KnowledgeBaseHistory[];
}
