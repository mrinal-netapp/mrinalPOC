package workflows

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// VolumeBrowseInput is the input for the VolumeBrowseWorkflow.
type VolumeBrowseInput struct {
	ProjectID string `json:"projectId"`
	VolumeID  string `json:"volumeId"`
	SubPath   string `json:"subPath"`
}

// VolumeBrowseWorkflow resolves the volume's mount path via config-service,
// then dispatches a ListVolumeDirectory activity to the connector-operations
// queue and returns the directory listing.
func VolumeBrowseWorkflow(ctx workflow.Context, input VolumeBrowseInput) (map[string]interface{}, error) {
	// Resolve the volume name from config-service (Go activity on the local queue)
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
		input.ProjectID, input.VolumeID).Get(ctx, &volume); err != nil {
		return nil, fmt.Errorf("failed to fetch volume data source config: %w", err)
	}

	volName, _ := volume["name"].(string)
	if volName == "" {
		volName = input.VolumeID
	}
	mountPath := filepath.Join("/mnt/pvcs", volName)

	connAO := workflow.ActivityOptions{
		TaskQueue:              connectorOperationsQueue,
		StartToCloseTimeout:    30 * time.Second,
		ScheduleToCloseTimeout: 60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    1,
		},
	}
	connCtx := workflow.WithActivityOptions(ctx, connAO)

	activityInput := map[string]interface{}{
		"volumeId":  input.VolumeID,
		"mountPath": mountPath,
		"subPath":   input.SubPath,
	}

	var result map[string]interface{}
	err := workflow.ExecuteActivity(connCtx, "ListVolumeDirectory", activityInput).Get(ctx, &result)
	if err != nil {
		return nil, fmt.Errorf("ListVolumeDirectory activity failed: %w", err)
	}

	return result, nil
}
