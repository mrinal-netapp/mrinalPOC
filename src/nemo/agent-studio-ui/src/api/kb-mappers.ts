import type {
    KBAssignedDataset,
    KBAssignedDatasetResponse,
    KBChunkingConfig,
    KBChunkingStrategy,
    KBChunkOptions,
    KBCreateRequest,
    KBDetail,
    KBEmbeddingConfig,
    KBIndexingConfig,
    KBIndexType,
    KBListItem,
    KBMutationResult,
    KBStatus,
    KBSynchronizationConfig,
    KBSynchronizationSummary,
    KBSynchronizationStatus,
    KBUpdateRequest,
    KBVectorQuantization,
    KBWorkflowOutcome,
    KBWorkflowSkippedReason,
} from './kb.types';

// -- Backend (config-service) shapes ------------------------------------

export interface BackendKBProgress {
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
}

export interface BackendKBStats {
    fileCount?: number;
    storageBytes?: number;
    documentCount?: number;
    chunkCount?: number;
    vectorCount?: number;
    storageMB?: number;
    lastProcessedAt?: string;
}

// Mirrors `KnowledgeBaseStatus` in config-service/models/KnowledgeBase.ts.
// The backend's column is an enum with exactly these four values; the
// default on insert is `'in_progress'`. There is no `'pending'` state.
export type BackendKBStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

export interface BackendKBFacet {
    id: string;
    facetType: string;
    state: string;
    createdAt: string;
    lastUpdated?: string;
    summary?: Record<string, unknown>;
}

/** Backend create/update response — KB entity plus optional workflow fields. */
export type BackendKBMutationResponse = BackendKB & {
    workflowId?: string;
    workflowStatus?: string;
    warning?: string;
    workflowError?: string;
    workflowSkippedReason?: KBWorkflowSkippedReason;
};

export interface BackendKB {
    id: string;
    name: string;
    description?: string | null;
    projectId: string;
    sourceDataset: string;
    embeddingModel: string;
    chunkSize: number;
    vectorSize: number;
    dataType?: string;
    status: BackendKBStatus;
    jobId?: string;
    namespace?: string;
    bucketName?: string;
    progress?: BackendKBProgress;
    stats?: BackendKBStats;
    errorMessage?: string | null;
    chunkStrategy?: string;
    chunkOverlap?: number;
    chunkOptions?: KBChunkOptions | null;
    indexingMode?: string;
    quantizationType?: string;
    quantizationOptions?: unknown;
    textColumns?: string;
    labels?: string[];
    createdAt: string;
    updatedAt?: string;
    facets?: BackendKBFacet[];
    dependentsSummary?: { total: number; byKind: Record<string, number> };
    synchronizationConfig?: KBSynchronizationConfig | null;
    synchronizationSummary?: KBSynchronizationSummary | null;
}

// -- Mappers ------------------------------------------------------------

export function mapKBStatus(s: BackendKBStatus | string | undefined): KBStatus {
    switch (s) {
        case 'in_progress':
            return 'in_progress';
        case 'ready':
            return 'ready';
        case 'errored':
            return 'errored';
        case 'deprecated':
            return 'deprecated';
        default:
            return 'in_progress';
    }
}

export function toKBListItem(b: BackendKB): KBListItem {
    return {
        kb_id: b.id,
        name: b.name,
        status: mapKBStatus(b.status),
        deprecated: b.status === 'deprecated',
        labels: Array.isArray(b.labels) ? b.labels : [],
        created_at: b.createdAt,
        assigned_dataset: b.sourceDataset
            ? { dset_id: b.sourceDataset }
            : undefined,
        snapshot: b.stats
            ? {
                files_indexed: b.stats.documentCount,
                vectors: b.stats.vectorCount,
                last_sync: b.stats.lastProcessedAt ?? null,
            }
            : null,
    };
}

function mapSyncStatus(s: BackendKBStatus | string | undefined): KBSynchronizationStatus | undefined {
    switch (s) {
        case 'ready':
            return 'Completed';
        case 'in_progress':
            return 'Synchronizing';
        case 'errored':
            return 'Failed';
        default:
            return undefined;
    }
}

function mapIndexType(mode: string | undefined): KBIndexType | undefined {
    switch (mode) {
        case 'hybrid':
            return 'hybrid_search';
        case 'semantic':
            return 'vector_only';
        case 'fts':
            return 'keyword_only';
        default:
            return undefined;
    }
}

function mapQuantization(q: string | undefined): KBVectorQuantization | undefined {
    switch (q) {
        case 'auto':
            return 'auto';
        case 'none':
            return 'none';
        case 'ivf_pq':
            return 'ivf_pq';
        case 'scalar':
            return 'scalar';
        case 'ivf_rq':
            return 'ivf_rq';
        default:
            return undefined;
    }
}

function mapChunkingStrategy(s: string | undefined): KBChunkingStrategy | undefined {
    switch (s) {
        case 'fixed':
            return 'chunk_by_character';
        case 'sentence':
            return 'sentence';
        case 'recursive':
            return 'recursive';
        case 'token':
            return 'chunk_by_token';
        case 'markdown':
            return 'hierarchical';
        default:
            return undefined;
    }
}

function buildEmbeddingConfig(b: BackendKB): KBEmbeddingConfig | undefined {
    if (!b.embeddingModel) return undefined;
    return {
        model: b.embeddingModel,
        dimensions: b.vectorSize,
    };
}

function parseChunkOptions(raw: unknown): KBChunkOptions | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const o = raw as Record<string, unknown>;
    const out: KBChunkOptions = {};
    if (typeof o.maxSentences === 'number') out.maxSentences = o.maxSentences;
    if (typeof o.overlapSentences === 'number') out.overlapSentences = o.overlapSentences;
    if (typeof o.maxTokens === 'number') out.maxTokens = o.maxTokens;
    if (typeof o.tokenOverlap === 'number') out.tokenOverlap = o.tokenOverlap;
    if (typeof o.splitOnHeaders === 'boolean') out.splitOnHeaders = o.splitOnHeaders;
    return Object.keys(out).length > 0 ? out : undefined;
}

function buildChunkingConfig(b: BackendKB): KBChunkingConfig | undefined {
    const options = parseChunkOptions(b.chunkOptions);
    if (b.chunkSize == null && b.chunkOverlap == null && !b.chunkStrategy && !options) {
        return undefined;
    }
    return {
        strategy: mapChunkingStrategy(b.chunkStrategy),
        chunk_size: b.chunkSize,
        overlap: b.chunkOverlap,
        options,
    };
}

function buildIndexingConfig(b: BackendKB): KBIndexingConfig | undefined {
    if (!b.indexingMode && !b.quantizationType) return undefined;
    return {
        index_type: mapIndexType(b.indexingMode),
        vector_quantization: mapQuantization(b.quantizationType),
    };
}

export function extractKBWorkflowOutcome(
    raw: BackendKBMutationResponse | KBWorkflowOutcome,
): KBWorkflowOutcome {
    return {
        workflowId: raw.workflowId,
        workflowStatus: raw.workflowStatus,
        warning: raw.warning,
        workflowError: raw.workflowError,
        workflowSkippedReason: raw.workflowSkippedReason,
    };
}

export function toKBMutationResult(raw: BackendKBMutationResponse): KBMutationResult {
    return {
        ...toKBDetail(raw),
        ...extractKBWorkflowOutcome(raw),
    };
}

export function toKBDetail(b: BackendKB): KBDetail {
    return {
        ...toKBListItem(b),
        description: b.description ?? null,
        stats: b.stats
            ? {
                fileCount: b.stats.fileCount,
                storageMB: b.stats.storageMB,
                chunkCount: b.stats.chunkCount,
                vectorCount: b.stats.vectorCount,
                storageBytes: b.stats.storageBytes,
                documentCount: b.stats.documentCount,
                lastProcessedAt: b.stats.lastProcessedAt,
            }
            : undefined,
        synchronization_status: mapSyncStatus(b.status),
        synchronization_config: b.synchronizationConfig ?? undefined,
        synchronization_summary: b.synchronizationSummary ?? null,
        last_synchronized_at: b.stats?.lastProcessedAt ?? null,
        files_indexed: b.stats?.documentCount,
        embedding_config: buildEmbeddingConfig(b),
        chunking_config: buildChunkingConfig(b),
        indexing_config: buildIndexingConfig(b),
        text_columns: b.textColumns ?? undefined,
        updated_at: b.updatedAt,
        activity: (b.facets ?? []).map((f) => ({
            event: f.facetType,
            status: f.state,
            timestamp: f.createdAt,
        })),
    };
}

// -- Dataset (assigned to a KB) ----------------------------------------

export type BackendDataSetStatus = 'in_progress' | 'ready' | 'errored' | 'deprecated';

export interface BackendDataSet {
    id: string;
    projectId: string;
    name: string;
    description?: string;
    kind?: 'unstructured' | 'structured';
    status?: BackendDataSetStatus;
    createdAt?: string;
    updatedAt?: string;
}

function mapDataSetStatus(s: BackendDataSetStatus | string | undefined): string | undefined {
    switch (s) {
        case 'ready':
            return 'Healthy';
        case 'in_progress':
            return 'Synchronizing';
        case 'errored':
            return 'Failed';
        case 'deprecated':
            return 'Deprecated';
        default:
            return undefined;
    }
}

function mapDataSetSyncStatus(s: BackendDataSetStatus | string | undefined): string | undefined {
    switch (s) {
        case 'ready':
            return 'Completed';
        case 'in_progress':
            return 'Synchronizing';
        case 'errored':
            return 'Failed';
        default:
            return undefined;
    }
}

export function toKBAssignedDatasetResponse(
    kbId: string,
    d: BackendDataSet | undefined,
): KBAssignedDatasetResponse {
    if (!d) {
        return { kb_id: kbId, dataset: {} as KBAssignedDataset };
    }
    return {
        kb_id: kbId,
        dataset: {
            dset_id: d.id,
            name: d.name,
            kind: d.kind,
            status: mapDataSetStatus(d.status),
            synchronization_status: mapDataSetSyncStatus(d.status),
        },
    };
}

// -- Outgoing request bodies -------------------------------------------

function mapChunkingStrategyToBackend(s: KBChunkingStrategy | undefined): string | undefined {
    switch (s) {
        case 'chunk_by_character':
            return 'fixed';
        case 'sentence':
            return 'sentence';
        case 'recursive':
            return 'recursive';
        case 'chunk_by_token':
            return 'token';
        case 'hierarchical':
            return 'markdown';
        default:
            return undefined;
    }
}

function mapIndexTypeToBackend(t: KBIndexType | undefined): string | undefined {
    switch (t) {
        case 'hybrid_search':
            return 'hybrid';
        case 'vector_only':
            return 'semantic';
        case 'keyword_only':
            return 'fts';
        default:
            return undefined;
    }
}

function mapQuantizationToBackend(q: KBVectorQuantization | undefined): string | undefined {
    switch (q) {
        case 'auto':
            return 'auto';
        case 'none':
            return 'none';
        case 'ivf_pq':
            return 'ivf_pq';
        case 'scalar':
            return 'scalar';
        case 'ivf_rq':
            return 'ivf_rq';
        default:
            return undefined;
    }
}

function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
}

function flattenKBBody(body: KBCreateRequest | KBUpdateRequest): Record<string, unknown> {
    const quantOpts = body.indexing_config?.quantization_options;
    const hasQuantOpts = quantOpts && Object.keys(quantOpts).some((k) => quantOpts[k as keyof typeof quantOpts] != null);
    
    return compact({
        name: body.name,
        description: body.description,
        labels: body.labels,
        sourceDataset: body.dataset_id,
        embeddingModel: body.embedding_config?.model,
        vectorSize: body.embedding_config?.dimensions,
        chunkSize: body.chunking_config?.chunk_size,
        chunkOverlap: body.chunking_config?.overlap,
        chunkStrategy: mapChunkingStrategyToBackend(body.chunking_config?.strategy),
        chunkOptions: body.chunking_config?.options,
        indexingMode: mapIndexTypeToBackend(body.indexing_config?.index_type),
        quantizationType: mapQuantizationToBackend(body.indexing_config?.vector_quantization),
        quantizationOptions: hasQuantOpts ? quantOpts : undefined,
        textColumns: body.text_columns,
        synchronizationConfig: body.synchronization_config,
    });
}

export function toBackendUpdateBody(body: KBUpdateRequest): Record<string, unknown> {
    return flattenKBBody(body);
}

export function toBackendCreateBody(body: KBCreateRequest): Record<string, unknown> {
    return flattenKBBody(body);
}
