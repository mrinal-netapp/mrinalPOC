package workflows

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// VolumeScanInput is the input for the VolumeScanWorkflow.
type VolumeScanInput struct {
	ProjectID    string                 `json:"projectId"`
	DataSourceID string                 `json:"dataSourceId"`
	ScanConfig   map[string]interface{} `json:"scanConfig"`
}

// VolumeScanResult is the shape returned by the ScanVolume Python activity
// and persisted to config-service as the `scan_result` field on the data
// source.
type VolumeScanResult struct {
	CompletedAt    string                   `json:"completed_at"`
	ErrorMessage   string                   `json:"error_message,omitempty"`
	TotalFiles     int64                    `json:"total_files"`
	TotalFolders   int64                    `json:"total_folders"`
	TotalSizeBytes int64                    `json:"total_size_bytes"`
	FileTypeStats  []map[string]interface{} `json:"file_type_stats"`
}

// VolumeScanWorkflow scans the mounted filesystem of a volume data source
// according to the supplied ScanConfig and posts the scan_result back to
// config-service via PostScanResultActivity. The workflow is started
// asynchronously from POST /api/v1/connectors/volume-scan and the caller
// (config-service) tracks state via the returned workflowId + the eventual
// /scan-result callback PATCH.
func VolumeScanWorkflow(ctx workflow.Context, input VolumeScanInput) (map[string]interface{}, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("VolumeScanWorkflow start",
		"projectId", input.ProjectID,
		"dataSourceId", input.DataSourceID,
	)

	// Step 1: Resolve the volume name from config-service.
	localAO := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	localCtx := workflow.WithActivityOptions(ctx, localAO)

	var volume map[string]interface{}
	if err := workflow.ExecuteActivity(localCtx, activities.FetchDataSourceConfigActivity,
		input.ProjectID, input.DataSourceID).Get(ctx, &volume); err != nil {
		return reportFailure(ctx, input, fmt.Sprintf("failed to fetch volume data source config: %v", err))
	}

	volName, _ := volume["name"].(string)
	if volName == "" {
		volName = input.DataSourceID
	}
	mountPath := filepath.Join("/mnt/pvcs", volName)

	// Step 2: Dispatch the ScanVolume activity to connector-worker. Allow up
	// to one hour for the recursive walk and enable heartbeats so long scans
	// do not time out silently.
	connAO := workflow.ActivityOptions{
		TaskQueue:              connectorOperationsQueue,
		StartToCloseTimeout:    60 * time.Minute,
		ScheduleToCloseTimeout: 65 * time.Minute,
		HeartbeatTimeout:       2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    1,
		},
	}
	connCtx := workflow.WithActivityOptions(ctx, connAO)

	activityInput := map[string]interface{}{
		"projectId":    input.ProjectID,
		"dataSourceId": input.DataSourceID,
		"volumeId":     input.DataSourceID,
		"volumeName":   volName,
		"mountPath":    mountPath,
		"scanConfig":   input.ScanConfig,
	}

	var scanResult map[string]interface{}
	if err := workflow.ExecuteActivity(connCtx, "ScanVolume", activityInput).Get(ctx, &scanResult); err != nil {
		return reportFailure(ctx, input, fmt.Sprintf("ScanVolume activity failed: %v", err))
	}

	// Step 3: Post the success callback back to config-service.
	postAO := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	postCtx := workflow.WithActivityOptions(ctx, postAO)

	completedAt := workflow.Now(ctx).UTC().Format(time.RFC3339)
	scanStatus := map[string]interface{}{
		"state":        "completed",
		"completed_at": completedAt,
	}
	// Ensure scan_result has a completed_at if the activity omitted one.
	if scanResult != nil {
		if _, ok := scanResult["completed_at"]; !ok {
			scanResult["completed_at"] = completedAt
		}
	}

	if err := workflow.ExecuteActivity(postCtx, activities.PostScanResultActivity,
		input.ProjectID, input.DataSourceID, scanStatus, scanResult).Get(ctx, nil); err != nil {
		// Log only — we have no other recourse; the scan itself did succeed.
		logger.Error("PostScanResultActivity failed", "error", err)
	}

	return map[string]interface{}{
		"projectId":    input.ProjectID,
		"dataSourceId": input.DataSourceID,
		"state":        "completed",
		"scan_result":  scanResult,
	}, nil
}

// reportFailure posts a {state:'failed', last_error} status update back to
// config-service and returns a non-nil error so Temporal records the workflow
// as failed.
func reportFailure(ctx workflow.Context, input VolumeScanInput, message string) (map[string]interface{}, error) {
	postAO := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	postCtx := workflow.WithActivityOptions(ctx, postAO)

	completedAt := workflow.Now(ctx).UTC().Format(time.RFC3339)
	scanStatus := map[string]interface{}{
		"state":        "failed",
		"completed_at": completedAt,
		"last_error":   message,
	}

	if err := workflow.ExecuteActivity(postCtx, activities.PostScanResultActivity,
		input.ProjectID, input.DataSourceID, scanStatus, nil).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("PostScanResultActivity (failure path) failed", "error", err)
	}

	return nil, fmt.Errorf("%s", message)
}
