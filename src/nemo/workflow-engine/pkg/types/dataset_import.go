package types

// DatasetImportWorkflowInput represents input for dataset import workflow
type DatasetImportWorkflowInput struct {
	ProjectId            string `json:"projectId"`
	DataSetId            string `json:"dataSetId"`
	DatasetName          string `json:"datasetName"`
	DatasetKind          string `json:"datasetKind"`           // "structured" or "unstructured"
	DatasetType          string `json:"datasetType,omitempty"` // "manual" or "acquired"
	BucketName           string `json:"bucketName"`
	Namespace            string `json:"namespace"` // Catalog namespace (e.g., projectId)
	WarehouseId          string `json:"warehouseId,omitempty"`
	PathPrefix           string `json:"pathPrefix,omitempty"`           // S3 path prefix (e.g., projects/<projectId>)
	FileListKey          string `json:"fileListKey,omitempty"`          // S3 key of acquisition filelist.json (optional)
	EnablePiiAnalysis    bool   `json:"enablePiiAnalysis,omitempty"`    // Run PII detection on unstructured files
	PiiAnalysisImageOnly bool   `json:"piiAnalysisImageOnly,omitempty"` // Only analyze images (skip text files)
	ReprocessPiiOnly     bool   `json:"reprocessPiiOnly,omitempty"`     // Only re-run PII analysis on existing data (no full reimport)
}

// DatasetImportWorkflowResult represents result of dataset import workflow
type DatasetImportWorkflowResult struct {
	ProjectId    string `json:"projectId"`
	DataSetId    string `json:"dataSetId"`
	DatasetName  string `json:"datasetName"`
	Status       string `json:"status"` // "completed", "failed"
	ErrorMessage string `json:"errorMessage,omitempty"`
	ParquetPath  string `json:"parquetPath,omitempty"`  // S3 path to parquet files
	CatalogTable string `json:"catalogTable,omitempty"` // Catalog table reference
}

// PiiSummary contains aggregate PII analysis results from the processor
type PiiSummary struct {
	FilesWithPii       int  `json:"filesWithPii"`
	TotalFiles         int  `json:"totalFiles"`
	PiiAnalysisEnabled bool `json:"piiAnalysisEnabled"`
}

// ProcessingResult represents the result from the Python processor
// This is written to S3 by the processor and read by the workflow
type ProcessingResult struct {
	Status            string                   `json:"status"` // "success" or "error"
	DatasetId         string                   `json:"datasetId"`
	DatasetName       string                   `json:"datasetName"`
	DatasetKind       string                   `json:"datasetKind"`
	ProjectId         string                   `json:"projectId"`
	Namespace         string                   `json:"namespace"`
	ParquetLocation   string                   `json:"parquetLocation"`
	IcebergSchema     map[string]interface{}   `json:"icebergSchema"`
	RowCount          int                      `json:"rowCount"`
	ColumnCount       int                      `json:"columnCount"`
	Columns           []map[string]interface{} `json:"columns"`
	SourceFileCount   int                      `json:"sourceFileCount"`
	Error             string                   `json:"error,omitempty"`
	CatalogRegistered bool                     `json:"catalogRegistered"`    // True if processor registered with catalog
	CatalogTableRef   string                   `json:"catalogTableRef"`      // Catalog table reference if registered
	PiiSummary        *PiiSummary              `json:"piiSummary,omitempty"` // PII analysis summary (unstructured only)
}

// DatasetProgressInfo represents progress data read from the Python processor's progress.json
type DatasetProgressInfo struct {
	Phase                       string             `json:"phase"`
	Status                      string             `json:"status"`
	Current                     int                `json:"current,omitempty"`
	Total                       int                `json:"total,omitempty"`
	Percentage                  float64            `json:"percentage,omitempty"`
	TotalFiles                  int                `json:"totalFiles,omitempty"`
	ProcessedFiles              int                `json:"processedFiles,omitempty"`
	CurrentFile                 string             `json:"currentFile,omitempty"`
	RowCount                    int                `json:"rowCount,omitempty"`
	ColumnCount                 int                `json:"columnCount,omitempty"`
	ElapsedSeconds              float64            `json:"elapsedSeconds,omitempty"`
	ElapsedFormatted            string             `json:"elapsedFormatted,omitempty"`
	PhaseElapsedSeconds         float64            `json:"phaseElapsedSeconds,omitempty"`
	PhaseElapsedFormatted       string             `json:"phaseElapsedFormatted,omitempty"`
	EstimatedRemainingSeconds   float64            `json:"estimatedRemainingSeconds,omitempty"`
	EstimatedRemainingFormatted string             `json:"estimatedRemainingFormatted,omitempty"`
	RatePerSecond               float64            `json:"ratePerSecond,omitempty"`
	Timestamp                   string             `json:"timestamp,omitempty"`
	CompletedPhases             map[string]float64 `json:"completedPhases,omitempty"`
	SourceFileCount             int                `json:"sourceFileCount,omitempty"`
	Error                       string             `json:"error,omitempty"`
}

// RegisterTableRequest represents request to register a table with Lakekeeper
type RegisterTableRequest struct {
	ProjectId       string                 `json:"projectId"`
	DatasetId       string                 `json:"datasetId"`
	DatasetName     string                 `json:"datasetName"`
	DatasetKind     string                 `json:"datasetKind"`
	Namespace       string                 `json:"namespace"`
	ParquetLocation string                 `json:"parquetLocation"`
	IcebergSchema   map[string]interface{} `json:"icebergSchema"`
}

// RegisterTableResult represents result of table registration
type RegisterTableResult struct {
	CatalogTableRef string `json:"catalogTableRef"`
	WarehouseId     string `json:"warehouseId"`
}

// ResourceStatusResult represents the result of checking any resource's status
// Generic result type for workflow-level polling pattern
type ResourceStatusResult struct {
	Ready   bool   `json:"ready"`   // True if resource is ready
	Status  string `json:"status"`  // Current status description
	Message string `json:"message"` // Additional info or error message
	Exists  bool   `json:"exists"`  // True if resource exists
}

// BucketStatusResult represents the result of checking a bucket's status
type BucketStatusResult struct {
	Ready   bool   `json:"ready"`   // True if bucket is accessible
	Exists  bool   `json:"exists"`  // True if bucket exists
	Message string `json:"message"` // Additional info
}

// PodStatusResult represents the result of checking a pod's status
type PodStatusResult struct {
	Ready       bool   `json:"ready"`       // True if pod is ready
	Phase       string `json:"phase"`       // Pod phase (Pending, Running, Succeeded, Failed)
	IsCompleted bool   `json:"isCompleted"` // True if pod is in terminal state
	Message     string `json:"message"`     // Additional info
}

// ServiceStatusResult represents the result of checking a service's status
type ServiceStatusResult struct {
	Ready         bool `json:"ready"`         // True if service has endpoints
	EndpointCount int  `json:"endpointCount"` // Number of endpoints
}
