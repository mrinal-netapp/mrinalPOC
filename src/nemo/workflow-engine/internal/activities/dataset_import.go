package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

// ReadProcessingResultActivity reads the processing result from S3
// The Python processor writes this file after completing data processing
func ReadProcessingResultActivity(ctx context.Context, bucketName, datasetId, pathPrefix string) (types.ProcessingResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ReadProcessingResultActivity] Reading processing result for dataset: %s from bucket: %s (prefix: %s)", datasetId, bucketName, pathPrefix)
	log.Printf("[ReadProcessingResultActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	s3Client := clients.NewS3Client()
	if s3Client == nil {
		log.Printf("[ReadProcessingResultActivity] ERROR: Failed to create S3 client - credentials not configured")
		return types.ProcessingResult{}, fmt.Errorf("S3 client initialization failed: credentials not configured")
	}

	var resultKey string
	if pathPrefix != "" {
		resultKey = fmt.Sprintf("%s/datasets/%s/processing_result.json", pathPrefix, datasetId)
	} else {
		resultKey = fmt.Sprintf("datasets/%s/processing_result.json", datasetId)
	}
	result, err := s3Client.ReadProcessingResult(bucketName, resultKey)
	if err != nil {
		log.Printf("[ReadProcessingResultActivity] ERROR: Failed to read processing result: %v", err)
		return types.ProcessingResult{}, fmt.Errorf("failed to read processing result: %w", err)
	}

	log.Printf("[ReadProcessingResultActivity] Successfully read processing result: status=%s, rows=%d, columns=%d",
		result.Status, result.RowCount, result.ColumnCount)

	return result, nil
}

// RegisterTableWithCatalogActivity registers the table with Lakekeeper catalog
// This uses the Go LakekeeperClient to ensure namespace exists and create the Iceberg table
func RegisterTableWithCatalogActivity(ctx context.Context, request types.RegisterTableRequest) (types.RegisterTableResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[RegisterTableWithCatalogActivity] Starting activity for dataset: %s, namespace: %s", request.DatasetId, request.Namespace)
	log.Printf("[RegisterTableWithCatalogActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	// Step 1: Look up warehouse UUID by project name
	log.Printf("[RegisterTableWithCatalogActivity] Looking up warehouse UUID for project: %s", request.ProjectId)
	warehouseId, err := lakekeeperClient.GetWarehouseByName(request.ProjectId)
	if err != nil {
		log.Printf("[RegisterTableWithCatalogActivity] ERROR: Failed to get warehouse: %v", err)
		return types.RegisterTableResult{}, fmt.Errorf("failed to get warehouse: %w", err)
	}
	log.Printf("[RegisterTableWithCatalogActivity] Found warehouse UUID: %s", warehouseId)

	// Step 2: Ensure namespace exists
	log.Printf("[RegisterTableWithCatalogActivity] Ensuring namespace exists: %s", request.Namespace)
	err = lakekeeperClient.EnsureNamespace(warehouseId, request.Namespace)
	if err != nil {
		log.Printf("[RegisterTableWithCatalogActivity] ERROR: Failed to ensure namespace: %v", err)
		return types.RegisterTableResult{}, fmt.Errorf("failed to ensure namespace: %w", err)
	}

	// Step 3: Register the Iceberg table
	log.Printf("[RegisterTableWithCatalogActivity] Registering table: %s in namespace: %s", request.DatasetName, request.Namespace)
	tableRequest := clients.CreateTableRequest{
		Name:        request.DatasetName,
		Location:    request.ParquetLocation,
		Schema:      request.IcebergSchema,
		DatasetId:   request.DatasetId,
		DatasetKind: request.DatasetKind,
		StageCreate: true, // Use stage_create for external data
	}

	err = lakekeeperClient.CreateTable(warehouseId, request.Namespace, tableRequest)
	if err != nil {
		log.Printf("[RegisterTableWithCatalogActivity] ERROR: Failed to create table: %v", err)
		return types.RegisterTableResult{}, fmt.Errorf("failed to create table: %w", err)
	}

	catalogTableRef := fmt.Sprintf("%s.%s", request.Namespace, request.DatasetName)
	log.Printf("[RegisterTableWithCatalogActivity] Successfully registered table: %s", catalogTableRef)

	return types.RegisterTableResult{
		CatalogTableRef: catalogTableRef,
		WarehouseId:     warehouseId,
	}, nil
}

// UpdateDatasetCatalogRefActivity updates the dataset with the catalog table reference
func UpdateDatasetCatalogRefActivity(ctx context.Context, projectId, datasetId, catalogTableRef string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateDatasetCatalogRefActivity] Updating catalog ref for dataset: %s to: %s", datasetId, catalogTableRef)
	log.Printf("[UpdateDatasetCatalogRefActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)
	err := configClient.UpdateDatasetCatalogRef(projectId, datasetId, catalogTableRef)
	if err != nil {
		log.Printf("[UpdateDatasetCatalogRefActivity] ERROR: Failed to update catalog ref: %v", err)
		return fmt.Errorf("failed to update catalog ref: %w", err)
	}

	log.Printf("[UpdateDatasetCatalogRefActivity] Successfully updated catalog ref")
	return nil
}

// UpdateDatasetStatsFacetInput holds the parameters for updating the stats facet
type UpdateDatasetStatsFacetInput struct {
	ProjectId       string `json:"projectId"`
	DataSetId       string `json:"dataSetId"`
	SourceFileCount int    `json:"sourceFileCount"`
	RowCount        int    `json:"rowCount"`
	ColumnCount     int    `json:"columnCount"`
	Status          string `json:"status"`
	ErrorMessage    string `json:"errorMessage,omitempty"`
}

// UpdateDatasetStatsFacetActivity creates/updates a "stats" facet on the dataset
// with import metrics collected from the processing result.
func UpdateDatasetStatsFacetActivity(ctx context.Context, input UpdateDatasetStatsFacetInput) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateDatasetStatsFacetActivity] Updating stats facet for dataset: %s", input.DataSetId)
	log.Printf("[UpdateDatasetStatsFacetActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	facetState := "ready"
	if input.Status == "errored" {
		facetState = "errored"
	}

	facetUpdate := map[string]interface{}{
		"state": facetState,
	}
	if facetState == "ready" {
		facetUpdate["summary"] = map[string]interface{}{
			"sourceFileCount": input.SourceFileCount,
			"rowCount":        input.RowCount,
			"columnCount":     input.ColumnCount,
		}
	}
	if input.ErrorMessage != "" && facetState == "errored" {
		facetUpdate["errorMessage"] = input.ErrorMessage
	}

	if err := configClient.UpdateFacet(input.ProjectId, "datasets", input.DataSetId, "stats", facetUpdate); err != nil {
		log.Printf("[UpdateDatasetStatsFacetActivity] WARNING: Failed to update stats facet: %v", err)
		return nil
	}

	log.Printf("[UpdateDatasetStatsFacetActivity] Stats facet updated successfully")
	return nil
}

// ReadDatasetProgressActivity reads progress.json from S3 written by the dataset processor.
func ReadDatasetProgressActivity(ctx context.Context, bucketName string, datasetId string, pathPrefix string) (types.DatasetProgressInfo, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ReadDatasetProgressActivity] Reading progress for dataset: %s from bucket: %s", datasetId, bucketName)
	log.Printf("[ReadDatasetProgressActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	s3Client := clients.NewS3Client()
	if s3Client == nil {
		return types.DatasetProgressInfo{}, fmt.Errorf("S3 client initialization failed: credentials not configured")
	}

	var progressKey string
	if pathPrefix != "" {
		progressKey = fmt.Sprintf("%s/datasets/%s/progress.json", pathPrefix, datasetId)
	} else {
		progressKey = fmt.Sprintf("datasets/%s/progress.json", datasetId)
	}

	data, err := s3Client.ReadJSON(bucketName, progressKey)
	if err != nil {
		log.Printf("[ReadDatasetProgressActivity] Progress file not found yet (normal early in processing): %v", err)
		return types.DatasetProgressInfo{
			Phase:  "initializing",
			Status: "in_progress",
		}, nil
	}

	var progressInfo types.DatasetProgressInfo
	if err := json.Unmarshal(data, &progressInfo); err != nil {
		return types.DatasetProgressInfo{}, fmt.Errorf("failed to parse progress JSON: %w", err)
	}

	log.Printf("[ReadDatasetProgressActivity] Progress: phase=%s, pct=%.1f%%, status=%s",
		progressInfo.Phase, progressInfo.Percentage, progressInfo.Status)
	return progressInfo, nil
}

// calculateDatasetProgressPercentage maps per-phase percentage into an overall 0-100 range.
func calculateDatasetProgressPercentage(progress types.DatasetProgressInfo) int {
	type phaseRange struct{ start, end int }
	phaseRanges := map[string]phaseRange{
		"initializing":        {0, 2},
		"listing_files":       {2, 5},
		"processing":          {5, 60},
		"writing_parquet":     {60, 75},
		"registering_catalog": {75, 90},
		"pii_analysis":        {90, 98},
		"completed":           {100, 100},
	}

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

	// Fallback: phase-based heuristic
	switch progress.Phase {
	case "initializing":
		return 0
	case "listing_files":
		return 3
	case "processing":
		if progress.ProcessedFiles > 0 && progress.TotalFiles > 0 {
			phasePct := float64(progress.ProcessedFiles) / float64(progress.TotalFiles)
			return 5 + int(55.0*phasePct)
		}
		return 30
	case "writing_parquet":
		return 65
	case "registering_catalog":
		return 80
	case "pii_analysis":
		return 94
	case "completed":
		return 100
	default:
		return 0
	}
}

// UpdateDatasetProgressActivity forwards dataset progress to the in-memory ProgressStore.
func UpdateDatasetProgressActivity(ctx context.Context, projectId string, datasetId string, progressInfo types.DatasetProgressInfo) error {
	activityInfo := activity.GetInfo(ctx)
	workflowID := activityInfo.WorkflowExecution.ID
	log.Printf("[UpdateDatasetProgressActivity] Updating progress: workflow=%s, phase=%s", workflowID, progressInfo.Phase)

	percentage := calculateDatasetProgressPercentage(progressInfo)

	extra := map[string]interface{}{}
	if progressInfo.TotalFiles > 0 {
		extra["totalFiles"] = progressInfo.TotalFiles
	}
	if progressInfo.ProcessedFiles > 0 {
		extra["processedFiles"] = progressInfo.ProcessedFiles
	}
	if progressInfo.CurrentFile != "" {
		extra["currentFile"] = progressInfo.CurrentFile
	}
	if progressInfo.RowCount > 0 {
		extra["rowCount"] = progressInfo.RowCount
	}
	if progressInfo.ColumnCount > 0 {
		extra["columnCount"] = progressInfo.ColumnCount
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
	if progressInfo.SourceFileCount > 0 {
		extra["sourceFileCount"] = progressInfo.SourceFileCount
	}
	if len(progressInfo.CompletedPhases) > 0 {
		extra["completedPhases"] = progressInfo.CompletedPhases
	}

	progressURL := fmt.Sprintf("http://localhost:%s/api/v1/workflows/%s/progress",
		getServerPort(), workflowID)

	// Build a human-readable message
	message := ""
	if progressInfo.ProcessedFiles > 0 && progressInfo.TotalFiles > 0 {
		message = fmt.Sprintf("Processing file %d of %d", progressInfo.ProcessedFiles, progressInfo.TotalFiles)
		if progressInfo.CurrentFile != "" {
			message += fmt.Sprintf(" (%s)", progressInfo.CurrentFile)
		}
	} else if progressInfo.CurrentFile != "" {
		message = fmt.Sprintf("Processing: %s", progressInfo.CurrentFile)
	}

	payload := map[string]interface{}{
		"phase":      progressInfo.Phase,
		"percentage": float64(percentage),
		"current":    progressInfo.Current,
		"total":      progressInfo.Total,
		"extra":      extra,
	}
	if message != "" {
		payload["message"] = message
	}

	jsonData, _ := json.Marshal(payload)
	resp, err := http.Post(progressURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[UpdateDatasetProgressActivity] WARNING: Failed to POST progress: %v", err)
		return nil
	}
	defer resp.Body.Close()

	log.Printf("[UpdateDatasetProgressActivity] Progress posted: %d%% (phase=%s, workflow=%s)",
		percentage, progressInfo.Phase, workflowID)
	return nil
}

// UpdateAcquisitionFacetInput is the input for UpdateAcquisitionFacetActivity.
//
// Lifecycle:
//   - At workflow start: state="in_progress", JobID=workflowID, Summary={startedAt}.
//     This activates the existing per-facet live-progress polling in
//     dataSetRoutes.ts (mirrors the PII facet pattern).
//   - On completion: state="ready" (or "errored"/"failed"), JobID="" (clears
//     the in-progress signal so the GUI stops polling).
type UpdateAcquisitionFacetInput struct {
	ProjectID    string                 `json:"projectId"`
	DatasetID    string                 `json:"datasetId"`
	State        string                 `json:"state"` // in_progress | ready | errored | failed
	JobID        string                 `json:"jobId,omitempty"`
	Summary      map[string]interface{} `json:"summary,omitempty"`
	ErrorMessage string                 `json:"errorMessage,omitempty"`
}

// UpdateAcquisitionFacetActivity creates/updates the "acquisition" facet on a dataset.
// Writes are best-effort -- a facet write failure should not abort the workflow.
func UpdateAcquisitionFacetActivity(ctx context.Context, input UpdateAcquisitionFacetInput) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateAcquisitionFacetActivity] dataset=%s state=%s workflow=%s",
		input.DatasetID, input.State, activityInfo.WorkflowExecution.ID)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	update := map[string]interface{}{
		"state": input.State,
	}
	// Always send jobId (even when empty) to clear it on terminal states; empty
	// string means "no in-progress job" so the GUI stops polling.
	update["jobId"] = input.JobID
	if input.Summary != nil {
		update["summary"] = input.Summary
	}
	if input.ErrorMessage != "" {
		update["errorMessage"] = input.ErrorMessage
	}

	if err := configClient.UpdateFacet(input.ProjectID, "datasets", input.DatasetID, "acquisition", update); err != nil {
		log.Printf("[UpdateAcquisitionFacetActivity] WARNING: facet update failed: %v", err)
		return nil
	}
	return nil
}
