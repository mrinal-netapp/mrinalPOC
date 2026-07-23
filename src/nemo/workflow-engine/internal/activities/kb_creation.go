package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.temporal.io/sdk/activity"
)

// ReadKBMetadataActivity reads the unified metadata.json the kb-processor
// writes at the end of a successful run, and decodes it into KBMetadata.
//
// Replaces the prior pair (ReadKBProcessingResultActivity reading
// kb_processing_results.json, ReadMetadataActivity reading metadata.json).
// kb-processor now writes exactly one file carrying both the workflow-result
// fields the Go side needs and the KB-shape fields kb-retrieval reads on
// every search — see types.KBMetadata for the schema and the design doc
// at docs/design/knowledge-base.md for the consolidation rationale.
func ReadKBMetadataActivity(ctx context.Context, bucketName string, kbId string, pathPrefix string) (types.KBMetadata, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ReadKBMetadataActivity] Reading metadata for KB: %s from bucket: %s", kbId, bucketName)
	log.Printf("[ReadKBMetadataActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get S3 credentials from environment
	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Endpoint := clients.ResolveS3Endpoint()
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	// Create S3 client
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		return types.KBMetadata{}, fmt.Errorf("failed to load AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(s3Endpoint)
		o.UsePathStyle = true
	})

	// Construct S3 key for the unified metadata file (with optional path prefix).
	var metadataKey string
	if pathPrefix != "" {
		metadataKey = fmt.Sprintf("%s/knowledgebases/%s/metadata.json", pathPrefix, kbId)
	} else {
		metadataKey = fmt.Sprintf("knowledgebases/%s/metadata.json", kbId)
	}

	// Download metadata file
	result, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(metadataKey),
	})
	if err != nil {
		return types.KBMetadata{}, fmt.Errorf("failed to get metadata file from S3: %w", err)
	}
	defer result.Body.Close()

	// Parse metadata JSON. The struct only decodes the workflow-result fields;
	// embedding identity + index capability fields live in the same JSON but
	// aren't surfaced here — kb-retrieval-service reads them directly.
	var metadata types.KBMetadata
	if err := json.NewDecoder(result.Body).Decode(&metadata); err != nil {
		return types.KBMetadata{}, fmt.Errorf("failed to parse metadata JSON: %w", err)
	}

	log.Printf("[ReadKBMetadataActivity] Metadata read successfully: status=%s, documents=%d, chunks=%d, vectors=%d",
		metadata.Status, metadata.DocumentCount, metadata.ChunkCount, metadata.VectorCount)

	return metadata, nil
}

// UpdateKBStatusInput contains all inputs for UpdateKBStatusActivity.
// Config fields (EmbeddingModel, ChunkSize, etc.) are populated on success
// so that the KB record is updated atomically only when reprocessing succeeds
// (deferred config update pattern).
//
// Counts (DocumentCount / ChunkCount / VectorCount) live here at the top
// level — NOT inside Stats — mirroring types.KBMetadata. Pre-unification
// they were duplicated in both KBStats and KBProcessingResult, which
// allowed the two to drift when one update path missed the other; the
// unified shape gives each fact a single home.
type UpdateKBStatusInput struct {
	ProjectId      string         `json:"projectId"`
	KbId           string         `json:"kbId"`
	Status         string         `json:"status"`
	LanceTablePath string         `json:"lanceTablePath,omitempty"`
	ErrorMessage   string         `json:"errorMessage,omitempty"`
	DocumentCount  int            `json:"documentCount,omitempty"`
	ChunkCount     int            `json:"chunkCount,omitempty"`
	VectorCount    int            `json:"vectorCount,omitempty"`
	Stats          *types.KBStats `json:"stats,omitempty"` // Storage-only info; counts above

	// Deferred config fields — applied to KB record only on successful reprocessing
	EmbeddingModel      string `json:"embeddingModel,omitempty"`
	EmbeddingModelId    string `json:"embeddingModelId,omitempty"`
	SourceDataset       string `json:"sourceDataset,omitempty"`
	DataType            string `json:"dataType,omitempty"`
	TextColumns         string `json:"textColumns,omitempty"`
	ChunkSize           int    `json:"chunkSize,omitempty"`
	ChunkStrategy       string `json:"chunkStrategy,omitempty"`
	ChunkOverlap        int    `json:"chunkOverlap,omitempty"`
	ChunkOptions        string `json:"chunkOptions,omitempty"`
	IndexingMode        string `json:"indexingMode,omitempty"`
	QuantizationType    string `json:"quantizationType,omitempty"`
	QuantizationOptions string `json:"quantizationOptions,omitempty"`
	VectorSize          int    `json:"vectorSize,omitempty"`
}

// UpdateKBStatusActivity updates the KB status in the config service
func UpdateKBStatusActivity(ctx context.Context, projectId string, kbId string, status string, lanceTablePath string, errorMessage string) error {
	return UpdateKBStatusWithStatsActivity(ctx, UpdateKBStatusInput{
		ProjectId:      projectId,
		KbId:           kbId,
		Status:         status,
		LanceTablePath: lanceTablePath,
		ErrorMessage:   errorMessage,
		Stats:          nil,
	})
}

// UpdateKBStatusWithStatsActivity updates the KB status and stats in the config service
func UpdateKBStatusWithStatsActivity(ctx context.Context, input UpdateKBStatusInput) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateKBStatusWithStatsActivity] Updating KB: %s to status: %s", input.KbId, input.Status)
	log.Printf("[UpdateKBStatusWithStatsActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get config service URL
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	// Create config client
	configClient := clients.NewConfigClient(configServiceURL)

	// Update KB status
	updateData := map[string]interface{}{
		"status": input.Status,
	}
	if input.LanceTablePath != "" {
		updateData["lanceTablePath"] = input.LanceTablePath
	}
	if input.ErrorMessage != "" {
		updateData["errorMessage"] = input.ErrorMessage
	}
	// Stamp lastSyncedAt on successful syncs so the after_dataset_updates
	// fan-out can compute file-change diffs since the prior successful run.
	if input.Status == "ready" {
		updateData["lastSyncedAt"] = time.Now().UTC().Format(time.RFC3339)
	}
	if input.Stats != nil {
		// Counts come from input top-level (KBMetadata shape); KBStats holds
		// storage info only now. Both go into the stats blob the GUI displays.
		updateData["stats"] = map[string]interface{}{
			"documentCount":   input.DocumentCount,
			"chunkCount":      input.ChunkCount,
			"vectorCount":     input.VectorCount,
			"storageBytes":    input.Stats.StorageBytes,
			"storageMB":       input.Stats.StorageMB,
			"fileCount":       input.Stats.FileCount,
			"lastProcessedAt": input.Stats.LastProcessedAt,
		}
	}

	// Apply deferred config fields (only populated on successful reprocessing)
	if input.SourceDataset != "" {
		updateData["sourceDataset"] = input.SourceDataset
	}
	if input.EmbeddingModel != "" {
		updateData["embeddingModel"] = input.EmbeddingModel
	}
	if input.EmbeddingModelId != "" {
		updateData["embeddingModelId"] = input.EmbeddingModelId
	}
	if input.DataType != "" {
		updateData["dataType"] = input.DataType
		// Persist empty textColumns when switching away from structured extraction.
		updateData["textColumns"] = input.TextColumns
	}
	if input.ChunkSize > 0 {
		updateData["chunkSize"] = input.ChunkSize
	}
	if input.ChunkStrategy != "" {
		updateData["chunkStrategy"] = input.ChunkStrategy
		// Persist zero overlap for strategies (sentence/token) that do not use
		// character overlap — omitting 0 left stale chunkOverlap on the KB row.
		updateData["chunkOverlap"] = input.ChunkOverlap
	}
	if input.ChunkOptions != "" {
		var chunkOpts map[string]interface{}
		if err := json.Unmarshal([]byte(input.ChunkOptions), &chunkOpts); err == nil {
			updateData["chunkOptions"] = chunkOpts
		}
	}
	if input.IndexingMode != "" {
		updateData["indexingMode"] = input.IndexingMode
	}
	if input.QuantizationType != "" {
		updateData["quantizationType"] = input.QuantizationType
	}
	if input.QuantizationOptions != "" {
		var quantOpts map[string]interface{}
		if err := json.Unmarshal([]byte(input.QuantizationOptions), &quantOpts); err == nil {
			updateData["quantizationOptions"] = quantOpts
		}
	}
	if input.VectorSize > 0 {
		updateData["vectorSize"] = input.VectorSize
	}

	if err := configClient.UpdateKnowledgeBase(input.ProjectId, input.KbId, updateData); err != nil {
		return fmt.Errorf("failed to update KB status: %w", err)
	}

	log.Printf("[UpdateKBStatusWithStatsActivity] KB status updated successfully")

	// Also update the embedding facet
	facetState := "ready"
	if input.Status == "errored" {
		facetState = "errored"
	}
	facetUpdate := map[string]interface{}{
		"state": facetState,
	}
	if input.Stats != nil && facetState == "ready" {
		facetUpdate["summary"] = map[string]interface{}{
			"documentCount":   input.DocumentCount,
			"chunkCount":      input.ChunkCount,
			"vectorCount":     input.VectorCount,
			"storageBytes":    input.Stats.StorageBytes,
			"storageMB":       input.Stats.StorageMB,
			"fileCount":       input.Stats.FileCount,
			"lastProcessedAt": input.Stats.LastProcessedAt,
		}
	}
	if input.ErrorMessage != "" && facetState == "errored" {
		facetUpdate["errorMessage"] = input.ErrorMessage
	}

	if err := configClient.UpdateFacet(input.ProjectId, "knowledgebases", input.KbId, "embedding", facetUpdate); err != nil {
		// Non-fatal: log warning but don't fail the workflow
		log.Printf("[UpdateKBStatusWithStatsActivity] WARNING: Failed to update embedding facet: %v", err)
	} else {
		log.Printf("[UpdateKBStatusWithStatsActivity] Embedding facet updated to '%s'", facetState)
	}

	return nil
}

// UpdateKBProgressActivity updates KB progress in the workflow-engine in-memory progress store.
// Progress is transient — it is only stored in memory for the GUI to poll, never persisted.
func UpdateKBProgressActivity(ctx context.Context, projectId string, kbId string, progressInfo types.KBProgressInfo) error {
	activityInfo := activity.GetInfo(ctx)
	workflowID := activityInfo.WorkflowExecution.ID
	log.Printf("[UpdateKBProgressActivity] Updating progress: workflow=%s, phase=%s", workflowID, progressInfo.Phase)

	// Calculate percentage based on phase (prefers processor-computed value)
	percentage := calculateProgressPercentage(progressInfo)

	// Build extra fields map
	extra := map[string]interface{}{}
	if progressInfo.TotalFiles > 0 {
		extra["totalFiles"] = progressInfo.TotalFiles
	}
	if progressInfo.ChunksCreated > 0 {
		extra["chunksCreated"] = progressInfo.ChunksCreated
	}
	if progressInfo.VectorsCreated > 0 {
		extra["vectorsCreated"] = progressInfo.VectorsCreated
	}
	if progressInfo.CurrentFile != "" {
		extra["currentFile"] = progressInfo.CurrentFile
	}
	if progressInfo.DocumentsProcessed > 0 {
		extra["documentsProcessed"] = progressInfo.DocumentsProcessed
	}
	if progressInfo.TotalDocuments > 0 {
		extra["totalDocuments"] = progressInfo.TotalDocuments
	}
	if progressInfo.ElapsedFormatted != "" {
		extra["elapsedFormatted"] = progressInfo.ElapsedFormatted
	}
	if progressInfo.EstimatedRemainingFormatted != "" {
		extra["estimatedRemainingFormatted"] = progressInfo.EstimatedRemainingFormatted
	}
	if progressInfo.RatePerSecond > 0 {
		extra["ratePerSecond"] = progressInfo.RatePerSecond
	}
	if progressInfo.DocumentCount > 0 {
		extra["documentCount"] = progressInfo.DocumentCount
	}
	if progressInfo.ChunkCount > 0 {
		extra["chunkCount"] = progressInfo.ChunkCount
	}
	if progressInfo.VectorCount > 0 {
		extra["vectorCount"] = progressInfo.VectorCount
	}
	if progressInfo.StorageMB > 0 {
		extra["storageMB"] = progressInfo.StorageMB
	}

	// POST to the workflow-engine's own progress store (in-process HTTP)
	progressURL := fmt.Sprintf("http://localhost:%s/api/v1/workflows/%s/progress",
		getServerPort(), workflowID)

	payload := map[string]interface{}{
		"phase":      progressInfo.Phase,
		"percentage": float64(percentage),
		"current":    progressInfo.Current,
		"total":      progressInfo.Total,
		"extra":      extra,
	}
	if progressInfo.Timestamp != "" {
		payload["message"] = progressInfo.Timestamp
	}
	if progressInfo.ReplaceProgress {
		payload["replace"] = true
	}

	jsonData, _ := json.Marshal(payload)
	resp, err := http.Post(progressURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[UpdateKBProgressActivity] WARNING: Failed to POST progress: %v", err)
		return nil
	}
	defer resp.Body.Close()

	log.Printf("[UpdateKBProgressActivity] Progress posted: %d%% (phase=%s, workflow=%s)",
		percentage, progressInfo.Phase, workflowID)
	return nil
}

// getServerPort returns the HTTP port the workflow-engine server is listening on.
func getServerPort() string {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	return port
}

// calculateProgressPercentage returns an overall progress percentage.
//
// If the Python processor has computed a per-phase percentage (Percentage > 0),
// we map it into the overall 0-100 range using per-phase weights.  Otherwise
// we fall back to the original phase-based heuristic.
func calculateProgressPercentage(progress types.KBProgressInfo) int {
	// Phase weight ranges (start%-end% of overall progress).
	type phaseRange struct{ start, end int }
	phaseRanges := map[string]phaseRange{
		"initializing":           {0, 1},
		"listing_files":          {1, 5},
		"connecting":             {5, 8},
		"processing_documents":   {8, 20},
		"generating_and_writing": {20, 95}, // Combined embedding + LanceDB write phase (used by processor)
		"generating_embeddings":  {20, 80}, // Legacy: separate embedding phase
		"writing_lancedb":        {80, 95}, // Legacy: separate write phase
		"finalizing":             {95, 100},
		"completed":              {100, 100},
	}

	// If the processor reported a per-phase percentage, interpolate into the
	// overall range for that phase.
	if progress.Percentage > 0 {
		if r, ok := phaseRanges[progress.Phase]; ok {
			span := r.end - r.start
			pct := r.start + int(float64(span)*progress.Percentage/100.0)
			if pct > 100 {
				pct = 100
			}
			return pct
		}
	}

	// Fallback: phase-based heuristic (same as before for phases that don't
	// report Percentage or for unknown phases).
	switch progress.Phase {
	case "initializing":
		return 0
	case "listing_files":
		return 1
	case "connecting":
		return 5
	case "processing_documents":
		if progress.DocumentsProcessed > 0 && progress.TotalDocuments > 0 {
			phasePct := float64(progress.DocumentsProcessed) / float64(progress.TotalDocuments)
			return 5 + int(15.0*phasePct) // 5-20
		}
		if progress.TotalFiles > 0 && progress.ChunksCreated > 0 {
			fileProgress := 5 * progress.ChunksCreated / (progress.TotalFiles * 10)
			return 5 + fileProgress
		}
		return 25 // Default mid-point of 5-20
	case "processing_complete":
		return 20
	case "generating_and_writing":
		return 45 // Mid-point of 20-95 range
	case "generating_embeddings":
		return 45
	case "embeddings_generated":
		return 80
	case "writing_lancedb":
		return 85
	case "uploading_to_s3":
		return 90
	case "upload_complete":
		return 95
	case "finalizing":
		return 97
	case "completed":
		return 100
	case "failed":
		return 0
	default:
		return 0
	}
}

// ReadKBProgressActivity reads the KB processing progress from S3
// Returns progress information or an error if the file doesn't exist yet
func ReadKBProgressActivity(ctx context.Context, bucketName string, kbId string, pathPrefix string) (types.KBProgressInfo, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ReadKBProgressActivity] Reading progress for KB: %s from bucket: %s", kbId, bucketName)
	log.Printf("[ReadKBProgressActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get S3 credentials from environment
	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Endpoint := clients.ResolveS3Endpoint()
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	// Create S3 client
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		return types.KBProgressInfo{}, fmt.Errorf("failed to load AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(s3Endpoint)
		o.UsePathStyle = true
	})

	// Construct S3 key for progress file (with optional path prefix)
	var progressKey string
	if pathPrefix != "" {
		progressKey = fmt.Sprintf("%s/knowledgebases/%s/progress.json", pathPrefix, kbId)
	} else {
		progressKey = fmt.Sprintf("knowledgebases/%s/progress.json", kbId)
	}

	// Download progress file
	result, err := s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(progressKey),
	})
	if err != nil {
		// Progress file might not exist yet - return empty progress
		log.Printf("[ReadKBProgressActivity] Progress file not found yet (this is normal early in processing): %v", err)
		return types.KBProgressInfo{
			Phase:  "initializing",
			Status: "in_progress",
		}, nil
	}
	defer result.Body.Close()

	// Parse progress JSON
	var progressInfo types.KBProgressInfo
	if err := json.NewDecoder(result.Body).Decode(&progressInfo); err != nil {
		return types.KBProgressInfo{}, fmt.Errorf("failed to parse progress JSON: %w", err)
	}

	log.Printf("[ReadKBProgressActivity] Progress read successfully: phase=%s, status=%s, totalFiles=%d, chunks=%d, vectors=%d",
		progressInfo.Phase, progressInfo.Status, progressInfo.TotalFiles, progressInfo.ChunksCreated, progressInfo.VectorsCreated)

	return progressInfo, nil
}

// ClearStaleProgressActivity deletes progress.json and the workflow-result
// file from S3 for a given KB before a reprocess, so the workflow doesn't
// observe a previous run's output. The unified shape moves the
// workflow-result fields into metadata.json (single source of truth), so
// that's the primary file to wipe; kb_processing_results.json is kept in
// the delete list for forward-compat with KBs last processed before the
// unification — they may still have the legacy file lying around.
func ClearStaleProgressActivity(ctx context.Context, bucketName string, kbId string, pathPrefix string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ClearStaleProgressActivity] Clearing stale progress files for KB: %s", kbId)
	log.Printf("[ClearStaleProgressActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get S3 credentials from environment
	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Endpoint := clients.ResolveS3Endpoint()
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	// Create S3 client
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		return fmt.Errorf("failed to load AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(s3Endpoint)
		o.UsePathStyle = true
	})

	// Build S3 keys for stale files
	var prefix string
	if pathPrefix != "" {
		prefix = fmt.Sprintf("%s/knowledgebases/%s", pathPrefix, kbId)
	} else {
		prefix = fmt.Sprintf("knowledgebases/%s", kbId)
	}

	staleKeys := []string{
		fmt.Sprintf("%s/progress.json", prefix),
		fmt.Sprintf("%s/metadata.json", prefix),
		fmt.Sprintf("%s/kb_processing_results.json", prefix), // Legacy pre-unification cleanup
	}

	for _, key := range staleKeys {
		_, err := s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(bucketName),
			Key:    aws.String(key),
		})
		if err != nil {
			// Non-fatal: the file may not exist (first-time processing)
			log.Printf("[ClearStaleProgressActivity] Could not delete %s (may not exist): %v", key, err)
		} else {
			log.Printf("[ClearStaleProgressActivity] Deleted stale file: s3://%s/%s", bucketName, key)
		}
	}

	log.Printf("[ClearStaleProgressActivity] Stale progress files cleared for KB: %s", kbId)
	return nil
}

// UnitProgressSeed is a single unit slot for progress seed (pending units before dispatch).
type UnitProgressSeed struct {
	UnitID string `json:"unitId"`
	Status string `json:"status"` // pending | running | completed | failed
}

// PostWorkflowProgressInput is the input for PostWorkflowProgressActivity.
// For job-level updates: set Phase, Percentage, Message, optionally Extra and Replace.
// For seed: set TotalUnits and optionally Units (e.g. [{ unitId: "s0", status: "pending" }, ...]).
// For per-unit completion: set UnitID, UnitStatus ("completed" or "failed"), and UnitMetrics.
type PostWorkflowProgressInput struct {
	Phase      string                 `json:"phase"`
	Percentage float64                `json:"percentage"`
	Message    string                 `json:"message,omitempty"`
	Extra      map[string]interface{} `json:"extra,omitempty"`
	Replace    bool                   `json:"replace,omitempty"`

	// Seed: total units and optional initial unit slots
	TotalUnits int                `json:"totalUnits,omitempty"`
	Units      []UnitProgressSeed `json:"units,omitempty"`

	// Per-unit update (unitId required)
	UnitID      string                 `json:"unitId,omitempty"`
	UnitStatus  string                 `json:"unitStatus,omitempty"`
	UnitMetrics map[string]interface{} `json:"unitMetrics,omitempty"`
}

// PostWorkflowProgressActivity posts progress to the workflow-engine in-memory store.
// This is a generic activity usable by any workflow (dataset import, KB creation, etc.).
// It derives the workflow ID from the activity context.
func PostWorkflowProgressActivity(ctx context.Context, input PostWorkflowProgressInput) error {
	activityInfo := activity.GetInfo(ctx)
	workflowID := activityInfo.WorkflowExecution.ID

	progressURL := fmt.Sprintf("http://localhost:%s/api/v1/workflows/%s/progress",
		getServerPort(), workflowID)

	payload := map[string]interface{}{
		"phase":      input.Phase,
		"percentage": input.Percentage,
	}
	if input.Message != "" {
		payload["message"] = input.Message
	}
	if input.Extra != nil && len(input.Extra) > 0 {
		payload["extra"] = input.Extra
	}
	if input.Replace {
		payload["replace"] = true
	}
	if input.TotalUnits > 0 {
		payload["totalUnits"] = input.TotalUnits
	}
	if len(input.Units) > 0 {
		units := make([]map[string]interface{}, len(input.Units))
		for i, u := range input.Units {
			status := u.Status
			if status == "" {
				status = "pending"
			}
			units[i] = map[string]interface{}{"unitId": u.UnitID, "status": status}
		}
		payload["units"] = units
	}
	if input.UnitID != "" {
		payload["unitId"] = input.UnitID
		if input.UnitStatus != "" {
			payload["unitStatus"] = input.UnitStatus
		}
		if input.UnitMetrics != nil && len(input.UnitMetrics) > 0 {
			payload["unitMetrics"] = input.UnitMetrics
		}
	}

	jsonData, _ := json.Marshal(payload)
	resp, err := http.Post(progressURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[PostWorkflowProgressActivity] WARNING: Failed to POST progress: %v", err)
		return nil // non-fatal
	}
	defer resp.Body.Close()

	log.Printf("[PostWorkflowProgressActivity] Progress posted: %.0f%% phase=%s workflow=%s",
		input.Percentage, input.Phase, workflowID)
	return nil
}
