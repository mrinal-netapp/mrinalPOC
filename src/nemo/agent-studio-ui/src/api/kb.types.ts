import type { DatasetKind } from './dataset.types';
import type { BaseListParams, PaginationParams, ScheduleConfig } from './api.types';

// -- Enums (string literal unions aligned with config-service OpenAPI) --

export type KBStatus =
  | 'in_progress'
  | 'ready'
  | 'errored'
  | 'deprecated';

export type KBSynchronizationStatus =
  | 'Completed'
  | 'Synchronizing'
  | 'Failed'
  | 'Never';

export type KBSnapshotBuildStatus =
  | 'pending'
  | 'in-progress'
  | 'completed'
  | 'errored';

export type KBSyncMode = 'manual' | 'after_dataset_updates' | 'scheduled';

export type KBScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';

export type KBProcessingMode = 'standard' | 'visual';

export type KBChunkingStrategy =
  | 'chunk_by_token'
  | 'chunk_by_character'
  | 'recursive'
  | 'sentence'
  | 'semantic'
  | 'hierarchical'
  | 'none';

export type KBIndexType = 'hybrid_search' | 'vector_only' | 'keyword_only';

export type KBVectorQuantization = 'auto' | 'none' | 'ivf_pq' | 'scalar' | 'ivf_rq';

export type KBVectorIndexConfiguration = 'hnsw' | 'flat' | 'ivf';

/** Options for vector quantization strategies. */
export interface KBQuantizationOptions {
  numPartitions?: number;   // ivf_pq / scalar / ivf_rq: number of IVF partitions
  numSubVectors?: number;   // ivf_pq: PQ sub-vectors (default: 96)
  efConstruction?: number;  // scalar: HNSW ef_construction (default: 150)
  m?: number;               // scalar: HNSW connectivity parameter
  numBits?: number;         // ivf_rq: bits per dimension (default: 1)
}

// -- Config interfaces --

export interface KBSynchronizationConfig extends ScheduleConfig {
  sync_mode?: KBSyncMode;
  schedule_type?: KBScheduleType | null;
  timezone?: string | null;
  data_change_threshold_enabled?: boolean;
  data_change_threshold_value?: number | null;
}

export interface KBProcessingConfig {
  mode?: KBProcessingMode;
  max_file_size_mb?: number | null;
  error_handling?: 'skip' | 'stop';
  duplicate_file_handling?: 'skip_duplicates' | 'keep_all';
}

export interface KBEmbeddingConfig {
  model: string;
  dimensions?: number;
}

/** Strategy-specific chunking knobs, sent to/received from the backend as `chunkOptions`. */
export interface KBChunkOptions {
  maxSentences?: number;
  overlapSentences?: number;
  maxTokens?: number;
  tokenOverlap?: number;
  splitOnHeaders?: boolean;
}

export interface KBChunkingConfig {
  strategy?: KBChunkingStrategy;
  chunk_size?: number;
  overlap?: number;
  options?: KBChunkOptions;
}

export interface KBIndexingConfig {
  index_type?: KBIndexType;
  vector_quantization?: KBVectorQuantization;
  quantization_options?: KBQuantizationOptions;
  vector_index_configuration?: KBVectorIndexConfiguration;
}

// -- Sub-objects --

export interface KBAssignedDataset {
  dset_id?: string;
  name?: string;
  kind?: DatasetKind;
  status?: string;
  synchronization_status?: string;
  file_scope?: string;
  labels?: string[];
  active_version?: number | null;
}

/** Response body for `GET /knowledge-bases/{kb_id}/dataset` */
export interface KBAssignedDatasetResponse {
  kb_id: string;
  dataset: KBAssignedDataset;
}

export interface KBListItemSnapshot {
  id?: string;
  version?: number;
  files_indexed?: number;
  vectors?: number;
  last_sync?: string | null;
}

export interface KBDetailActivityEntry {
  event?: string;
  status?: string;
  duration?: number;
  timestamp?: string;
}

export interface KBSynchronizationSummary {
  status?: KBSynchronizationStatus;
  schedule?: string | null;
  last_completed_synchronization?: string | null;
  next_scheduled_synchronization?: string | null;
}

// -- Snapshot nested types --

export interface KBSnapshotProgressStatus {
  chunking?: number;
  embedding?: number;
  indexing?: number;
  files_successfully_processed?: number;
  files_failed_processed?: number;
}

export interface KBSnapshotMetadata {
  embedding_config?: {
    model: string;
    dimensions?: number;
  };
}

export interface KBSnapshotFailedDocument {
  file_path?: string;
  error?: string;
}

export interface KBStats {
  fileCount?: number;
  storageMB?: number;
  chunkCount?: number;
  vectorCount?: number;
  storageBytes?: number;
  documentCount?: number;
  lastProcessedAt?: string;
}

// -- Response interfaces --

export interface KBListItem {
  kb_id: string;
  name: string;
  status: KBStatus;
  assigned_dataset?: KBAssignedDataset;
  snapshot?: KBListItemSnapshot | null;
  deprecated: boolean;
  labels: string[];
  created_at: string;
}

/** Reasons the backend saved the KB but did not start a reprocessing workflow. */
export type KBWorkflowSkippedReason =
  | 'already_in_progress'
  | 'dataset_not_found'
  | 'dataset_not_ready'
  | 'project_not_found';

/** Workflow fields returned on create/update when reprocessing may be triggered. */
export interface KBWorkflowOutcome {
  workflowId?: string;
  workflowStatus?: string;
  warning?: string;
  workflowError?: string;
  workflowSkippedReason?: KBWorkflowSkippedReason;
}

/** Create/update mutation result — KB detail plus optional workflow outcome. */
export type KBMutationResult = KBDetail & KBWorkflowOutcome;

export interface KBDetail extends KBListItem {
  description?: string | null;
  stats?: KBStats;
  synchronization_status?: KBSynchronizationStatus;
  current_version?: number | null;
  current_snapshot_id?: string | null;
  last_synchronized_at?: string | null;
  files_indexed?: number;
  use_pipeline?: boolean;
  synchronization_config?: KBSynchronizationConfig;
  processing_config?: KBProcessingConfig;
  embedding_config?: KBEmbeddingConfig;
  chunking_config?: KBChunkingConfig;
  indexing_config?: KBIndexingConfig;
  synchronization_summary?: KBSynchronizationSummary | null;
  activity?: KBDetailActivityEntry[];
  updated_at?: string;
  modified_by?: string;
  /** Comma-separated list of column names for text extraction. Only relevant for structured-dataset KBs. */
  text_columns?: string;
}

export interface KBSnapshot {
  id: string;
  version: number;
  status: KBSnapshotBuildStatus;
  progress_status?: KBSnapshotProgressStatus | null;
  documents_total?: number | null;
  documents_indexed?: number | null;
  documents_failed?: number | null;
  chunks_generated?: number | null;
  vectors_generated?: number | null;
  index_size_bytes?: number | null;
  duration_ms?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  metadata?: KBSnapshotMetadata | null;
  expired: boolean;
  is_current: boolean;
  created_at: string;
}

export interface KBSnapshotDetail extends KBSnapshot {
  kb_id?: string;
  workflow_id?: string;
  failed_documents?: KBSnapshotFailedDocument[] | null;
  started_at?: string | null;
  completed_at?: string | null;
}

// -- Request interfaces --

/** OpenAPI schema `KnowledgeBaseCreateRequest` */
export interface KBCreateRequest {
  name: string;
  dataset_id: string;
  embedding_config: KBEmbeddingConfig;
  description?: string;
  labels?: string[];
  use_pipeline?: boolean;
  synchronization_config?: KBSynchronizationConfig;
  processing_config?: KBProcessingConfig;
  chunking_config?: KBChunkingConfig;
  indexing_config?: KBIndexingConfig;
  /** Comma-separated list of column names for text extraction. Required when the source dataset is `kind=structured`. */
  text_columns?: string;
}

export interface KBUpdateRequest {
  name?: string;
  description?: string;
  labels?: string[];
  deprecated?: boolean;
  use_pipeline?: boolean;
  dataset_id?: string;
  synchronization_config?: KBSynchronizationConfig;
  processing_config?: KBProcessingConfig;
  embedding_config?: KBEmbeddingConfig;
  chunking_config?: KBChunkingConfig;
  indexing_config?: KBIndexingConfig;
  /** Comma-separated list of column names for text extraction. Required when the source dataset is `kind=structured`. */
  text_columns?: string;
}

/** Response from `POST /projects/{projectId}/knowledgebases/{id}/create` (manual re-sync). */
export interface KBManualSyncResponse extends KBWorkflowOutcome {
  workflowId?: string;
  status?: string;
  knowledgeBaseId: string;
  projectId: string;
}

export interface KBSnapshotCreateRequest {
  workflow_id?: string;
  metadata?: KBSnapshotMetadata;
}

export interface KBSnapshotUpdateRequest {
  status?: KBSnapshotBuildStatus;
  is_current?: boolean;
  expired?: boolean;
  progress_status?: KBSnapshotProgressStatus;
  documents_total?: number;
  documents_indexed?: number;
  documents_failed?: number;
  chunks_generated?: number;
  vectors_generated?: number;
  index_size_bytes?: number;
  duration_ms?: number;
  error_code?: string | null;
  error_message?: string | null;
  failed_documents?: KBSnapshotFailedDocument[] | null;
  metadata?: KBSnapshotMetadata;
  started_at?: string;
  completed_at?: string;
}

// -- List query params --

export interface KBListParams extends BaseListParams {
  status?: KBStatus;
  synchronization_status?: KBSynchronizationStatus;
  /** Comma-separated label values (OpenAPI `labels` query on list KB) */
  labels?: string;
  deprecated?: boolean;
}

/** Query args for `GET /knowledge-bases/{kb_id}/snapshots` */
export interface KBListSnapshotsParams extends PaginationParams {
  kbId: string;
  status?: KBSnapshotBuildStatus;
  includeExpired?: boolean;
}
