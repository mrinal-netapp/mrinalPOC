package types

// KnowledgeBaseCreationWorkflowInput represents input for KB creation workflow
type KnowledgeBaseCreationWorkflowInput struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	KBName          string `json:"kbName"`
	SourceDatasetId string `json:"sourceDatasetId"`
	BucketName      string `json:"bucketName"`
	EmbeddingModel  string `json:"embeddingModel"`
	ChunkSize       int    `json:"chunkSize"`
	VectorSize      int    `json:"vectorSize"`
	DataType        string `json:"dataType"`
	Namespace       string `json:"namespace"` // Typically projectId

	// Chunking strategy configuration
	ChunkStrategy string `json:"chunkStrategy,omitempty"` // "fixed", "sentence", "recursive", "token", "markdown"
	ChunkOverlap  int    `json:"chunkOverlap,omitempty"`  // Overlap between chunks (for fixed/token strategies)
	ChunkOptions  string `json:"chunkOptions,omitempty"`  // JSON string with strategy-specific options

	// Indexing mode for FTS/hybrid search support
	IndexingMode string `json:"indexingMode,omitempty"` // "hybrid", "semantic", "fts" - controls FTS index creation

	// Quantization for vector index compression
	QuantizationType    string `json:"quantizationType,omitempty"`    // "auto", "none", "ivf_pq", "scalar", "ivf_rq" - vector index strategy
	QuantizationOptions string `json:"quantizationOptions,omitempty"` // JSON string with quantization options (numPartitions, numSubVectors, efConstruction, m, numBits)

	// Embedding batch size for the processor (default 64 in processor if 0/unset)
	EmbeddingBatchSize int `json:"embeddingBatchSize,omitempty"`

	// Processing mode: "full" (overwrite) or "incremental" (append new/modified)
	ProcessingMode string `json:"processingMode,omitempty"` // Defaults to "full"

	// Structured dataset support
	DatasetKind     string `json:"datasetKind,omitempty"`     // "structured" or "unstructured"
	CatalogTableRef string `json:"catalogTableRef,omitempty"` // e.g., "namespace.table_name" (for structured)
	TextColumns     string `json:"textColumns,omitempty"`     // Comma-separated list of columns (for structured)
	WarehouseId     string `json:"warehouseId,omitempty"`     // Lakekeeper warehouse name (e.g. "nemo"), not project ID

	// Path prefix for project home_dir convention (e.g., "projects/<projectId>")
	PathPrefix string `json:"pathPrefix,omitempty"`

	// --- Unified-embedding fields (Phase 5 of the unified-embedding port) ---
	// Populated by config-service.knowledgeBaseRoutes when dispatching the
	// workflow; forwarded into the kb-processor activity input so the
	// Python embedder can call Bifrost with the right model + project VK.
	// Legacy `EmbeddingModel` is kept for back-compat with pre-port workflows.
	EmbeddingModelId         string `json:"embeddingModelId,omitempty"`
	EmbeddingProvider        string `json:"embeddingProvider,omitempty"`
	EmbeddingProviderModelId string `json:"embeddingProviderModelId,omitempty"`
	// Bifrost wire identifier (`<provider>/<gatewayBindingName>`). kb-processor
	// sends this as the `model` field on /v1/embeddings so the project VK's
	// allowed_models[] match succeeds. Empty for built-ins / legacy rows that
	// pre-date the gatewayModelId column — kb-processor falls back to
	// providerModelId in that case.
	EmbeddingGatewayModelId string `json:"embeddingGatewayModelId,omitempty"`
	EmbeddingEndpoint       string `json:"embeddingEndpoint,omitempty"`
	EmbeddingDimensions     int    `json:"embeddingDimensions,omitempty"`
	// Per-project Bifrost virtual-key bearer. Resolved by config-service from
	// K8s Secret `as-proj-{projectId}-vk` at workflow-dispatch time. Sensitive
	// — do not log. Forwarded into the kb-processor activity input verbatim.
	ProjectVirtualKeyToken string `json:"projectVirtualKeyToken,omitempty"`
	// Bifrost base URL (no trailing slash). Defaults to in-cluster
	// http://bifrost-proxy:8080 when empty; operators can override per env.
	LLMGatewayURL string `json:"llmGatewayUrl,omitempty"`
}

// KnowledgeBaseCreationWorkflowResult represents result of KB creation workflow
type KnowledgeBaseCreationWorkflowResult struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	Status          string `json:"status"` // "completed", "failed"
	ErrorMessage    string `json:"errorMessage,omitempty"`
	LanceTablePath  string `json:"lanceTablePath,omitempty"` // S3 path to LanceDB
}

// KBStats carries storage/file info ONLY. Document / chunk / vector counts
// live on KBMetadata at the top level so the JSON never duplicates them.
// (Pre-unification, KBStats also held counts; that duplication caused
// drift between the workflow-result file and the metadata file when one
// path updated stats but not the other. Now there is one place per fact.)
type KBStats struct {
	StorageBytes    int64   `json:"storageBytes,omitempty"`    // Total storage size in bytes
	StorageMB       float64 `json:"storageMB,omitempty"`       // Total storage size in MB
	FileCount       int     `json:"fileCount,omitempty"`       // Number of LanceDB files
	LastProcessedAt string  `json:"lastProcessedAt,omitempty"` // ISO 8601 timestamp
}

// KBMetadata is the unified payload of metadata.json — the single file
// kb-processor writes at the end of a successful run. It carries both:
//
//   - workflow-result fields read by the Go workflow once at completion
//     (Status / counts / LanceTablePath) via ReadKBMetadataActivity, and
//   - KB-shape fields read by kb-retrieval-service on every search
//     (embedding identity, index capabilities — present in the JSON but
//     not decoded into this struct because the Go workflow doesn't need
//     them; kb-retrieval reads the raw JSON).
//
// Replaces the prior pair of files (kb_processing_results.json +
// metadata.json) and the duplicated count fields with a single source
// of truth. Pre-unification the same numbers lived in two places and
// drifted; now the workflow + retrieval read from one file.
type KBMetadata struct {
	Status          string   `json:"status"` // "success" or "error"
	KnowledgeBaseId string   `json:"knowledgeBaseId"`
	ProjectId       string   `json:"projectId"`
	LanceTablePath  string   `json:"lanceTablePath"` // S3 path
	DocumentCount   int      `json:"documentCount"`
	ChunkCount      int      `json:"chunkCount"`
	VectorCount     int      `json:"vectorCount"`
	SourceType      string   `json:"sourceType,omitempty"` // "structured" or "unstructured"
	Error           string   `json:"error,omitempty"`
	Stats           *KBStats `json:"stats,omitempty"` // Storage-only info; counts are on this struct, not nested
}

// KBProgressInfo represents progress information from the Python KB processor.
// Read from s3://<bucket>/knowledgebases/<kb-id>/progress.json
//
// The Python ProgressTracker writes a rich payload every few seconds.  Fields
// marked "enriched" were added to support adaptive-timeout logic in the
// workflow (stale-progress detection) and richer UI display.
type KBProgressInfo struct {
	Phase          string  `json:"phase"`                    // Current phase: listing_files, processing_documents, etc.
	Status         string  `json:"status"`                   // Status: in_progress, success, error
	TotalFiles     int     `json:"totalFiles,omitempty"`     // Total files to process (for unstructured)
	TotalItems     int     `json:"totalItems,omitempty"`     // Total items to process (generic)
	ChunksCreated  int     `json:"chunksCreated,omitempty"`  // Chunks created so far
	VectorsCreated int     `json:"vectorsCreated,omitempty"` // Vectors created
	DocumentCount  int     `json:"documentCount,omitempty"`  // Documents processed
	ChunkCount     int     `json:"chunkCount,omitempty"`     // Total chunks
	VectorCount    int     `json:"vectorCount,omitempty"`    // Total vectors
	LanceTablePath string  `json:"lanceTablePath,omitempty"` // S3 path (when upload complete)
	SourceType     string  `json:"sourceType,omitempty"`     // "structured" or "unstructured"
	StorageMB      float64 `json:"storageMB,omitempty"`      // Storage size in MB (from processor)
	Error          string  `json:"error,omitempty"`          // Error message if failed
	Timestamp      string  `json:"timestamp,omitempty"`      // ISO 8601 timestamp

	// --- Enriched fields written by ProgressTracker (Python processor) ---

	// Item-level progress within the current phase
	Current int `json:"current,omitempty"` // Items completed in current phase
	Total   int `json:"total,omitempty"`   // Total items in current phase

	// Processor-computed percentage (0-100) for the current phase
	Percentage float64 `json:"percentage,omitempty"`

	// Timing
	ElapsedSeconds              float64 `json:"elapsedSeconds,omitempty"`              // Total wall-clock seconds since job start
	ElapsedFormatted            string  `json:"elapsedFormatted,omitempty"`            // Human-readable elapsed (e.g. "3m 42s")
	PhaseElapsedSeconds         float64 `json:"phaseElapsedSeconds,omitempty"`         // Seconds spent in current phase
	PhaseElapsedFormatted       string  `json:"phaseElapsedFormatted,omitempty"`       // Human-readable phase elapsed
	EstimatedRemainingSeconds   float64 `json:"estimatedRemainingSeconds,omitempty"`   // ETA for current phase
	EstimatedRemainingFormatted string  `json:"estimatedRemainingFormatted,omitempty"` // Human-readable ETA
	RatePerSecond               float64 `json:"ratePerSecond,omitempty"`               // Processing rate (items/sec)

	// Document-level detail
	DocumentsProcessed int    `json:"documentsProcessed,omitempty"` // Documents processed so far
	TotalDocuments     int    `json:"totalDocuments,omitempty"`     // Total documents to process
	CurrentFile        string `json:"currentFile,omitempty"`        // File currently being processed

	// ReplaceProgress when true tells the progress store to replace (not merge) so job-level
	// completed-only stats from the workflow are authoritative.
	ReplaceProgress bool `json:"replaceProgress,omitempty"`

	// Phase timing breakdown: phase name -> seconds
	CompletedPhases map[string]float64 `json:"completedPhases,omitempty"`
}
