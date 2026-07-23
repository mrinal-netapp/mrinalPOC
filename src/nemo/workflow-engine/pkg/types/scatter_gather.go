package types

import "time"

// FileSet represents a single work unit in a ScatterGather operation.
type FileSet struct {
	SetID         string `json:"setId"`
	ManifestS3Key string `json:"manifestS3Key"`
	TotalFiles    int    `json:"totalFiles"`
	TotalBytes    int64  `json:"totalBytes"`
	OutputPrefix  string `json:"outputPrefix"`
}

// WorkPlan is the output of CreateWorkPlanActivity (Python). It lists non-empty
// file-set manifests (K_eff shards) produced from total_bytes-driven K sizing.
type WorkPlan struct {
	FileSets        []FileSet `json:"fileSets"`
	TotalFiles      int       `json:"totalFiles"`
	TotalBytes      int64     `json:"totalBytes"`
	UseSingleWorker bool      `json:"useSingleWorker"`
	JobOutputPrefix string    `json:"jobOutputPrefix"`
}

// WorkUnitResult is the result returned by a single ProcessDatasetFiles,
// ProcessKBDocuments, or AcquireBatch activity.
//
// Extra is a backward-compatible escape hatch for activity-specific metrics
// (e.g. AcquireBatch reports {bytesCopied, errorCount, durationMs}). New
// activities should prefer Extra over growing the core struct.
type WorkUnitResult struct {
	SetID      string                 `json:"setId"`
	Status     string                 `json:"status"`
	Error      string                 `json:"error,omitempty"`
	OutputPath string                 `json:"outputPath,omitempty"`
	RowCount   int                    `json:"rowCount,omitempty"`
	FileCount  int                    `json:"fileCount,omitempty"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
}

// AcquisitionPipelineConfig holds tuning parameters for the streaming
// acquisition pipeline (workflow-side scatter sizing). Connector-worker reads
// its own ACQ_BATCH_SIZE / ACQ_MAX_BATCHES_PER_ACTIVITY from env vars.
type AcquisitionPipelineConfig struct {
	UsePipeline            bool          `json:"usePipeline"`
	MaxAcquireConsumers    int           `json:"maxAcquireConsumers"`
	BatchSize              int           `json:"batchSize"`
	MaxBatchesPerActivity  int           `json:"maxBatchesPerActivity"`
	UnboundedConsumers     int           `json:"unboundedConsumers"`
	StreamingMode          string        `json:"streamingMode"`
	ScheduleToStartTimeout time.Duration `json:"scheduleToStartTimeout"`
	MaxDiscoverWorkers     int           `json:"maxDiscoverWorkers"`
	MaxRegisterConsumers   int           `json:"maxRegisterConsumers"`
}

// ScatterGatherConfig holds tuning parameters for the ScatterGather pattern.
// Unlike the old ScalingConfig, there is no Enabled field -- ScatterGather
// is always the execution path.
type ScatterGatherConfig struct {
	MaxWorkUnits         int `json:"maxWorkUnits"`
	MinFilesPerUnit      int `json:"minFilesPerUnit"`
	DatasetFileThreshold int `json:"datasetFileThreshold"`
	KBFileThreshold      int `json:"kbFileThreshold"`
	// MaxBytesPerWorkUnit: when >0, Python planner uses it only to size K from total bytes (not a per-shard cap after assignment).
	MaxBytesPerWorkUnit int64 `json:"maxBytesPerWorkUnit"`
}

// IcebergSource carries credentials and identifiers for reading file metadata
// from an Iceberg catalog table.  Used when CreateWorkPlanInput.Source == "iceberg".
type IcebergSource struct {
	Namespace           string `json:"namespace"`
	DatasetName         string `json:"datasetName"`
	LakekeeperURL       string `json:"lakekeeperUrl"`
	WarehouseId         string `json:"warehouseId"`
	ProjectClientId     string `json:"projectClientId"`
	ProjectClientSecret string `json:"projectClientSecret"`
	AwsAccessKeyId      string `json:"awsAccessKeyId"`
	AwsSecretAccessKey  string `json:"awsSecretAccessKey"`
	S3Endpoint          string `json:"s3Endpoint"`
	AwsRegion           string `json:"awsRegion"`
	KeycloakIssuer      string `json:"keycloakInternalIssuer"`
}

// CreateWorkPlanInput carries S3 context for file listing and manifest writes.
type CreateWorkPlanInput struct {
	BucketName   string `json:"bucketName"`
	PathPrefix   string `json:"pathPrefix"`
	DatasetId    string `json:"datasetId"`
	JobId        string `json:"jobId"`
	WorkloadType string `json:"workloadType"` // "dataset" or "kb"
	// FileListKey, when set, is the mount-relative key of the acquisition handoff:
	// filelist.json or parquet-partitioned manifest.json under
	// projects/<pid>/datasets/<id>/_acquisition/. When empty, CreateWorkPlan probes
	// those paths before listing data_files/.
	FileListKey string `json:"fileListKey,omitempty"`
	// Source selects the file listing strategy: "" (default) = probe _acquisition then POSIX data_files/ listing,
	// "iceberg" = read file metadata from the Iceberg catalog table.
	Source  string         `json:"source,omitempty"`
	Iceberg *IcebergSource `json:"iceberg,omitempty"`
}

// ScatterGatherResult is returned by RunScatterGather.
type ScatterGatherResult struct {
	UnitResults []WorkUnitResult `json:"unitResults"`
	Succeeded   int              `json:"succeeded"`
	Failed      int              `json:"failed"`
	MergeOutput interface{}      `json:"mergeOutput,omitempty"`
}

// ProjectCredentials holds credentials fetched by FetchProjectCredentialsActivity.
type ProjectCredentials struct {
	ProjectClientId     string `json:"projectClientId"`
	ProjectClientSecret string `json:"projectClientSecret"`
	S3AccessKey         string `json:"s3AccessKey"`
	S3SecretKey         string `json:"s3SecretKey"`
	S3Endpoint          string `json:"s3Endpoint"`
	S3Region            string `json:"s3Region"`
	ConfigServiceURL    string `json:"configServiceUrl"`
	KeycloakIssuer      string `json:"keycloakIssuer"`
	LakekeeperURL       string `json:"lakekeeperUrl"`
}
