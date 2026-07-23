package activities

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"go.temporal.io/sdk/activity"
)

// GetTableMetadataActivity gets table metadata from lakekeeper catalog
func GetTableMetadataActivity(ctx context.Context, projectId, namespace, tableName, warehouseId string) (map[string]interface{}, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[GetTableMetadataActivity] Starting activity for table: %s, namespace: %s, project: %s, warehouse: %s", tableName, namespace, projectId, warehouseId)
	log.Printf("[GetTableMetadataActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	// Use provided warehouseId or fallback to projectId
	if warehouseId == "" {
		warehouseId = projectId
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	// Get table metadata from catalog
	metadata, err := lakekeeperClient.GetTable(warehouseId, namespace, tableName)
	if err != nil {
		log.Printf("[GetTableMetadataActivity] ERROR: Failed to get table metadata: %v", err)
		return nil, fmt.Errorf("failed to get table metadata: %w", err)
	}

	log.Printf("[GetTableMetadataActivity] Table metadata retrieved successfully for table: %s", tableName)
	return metadata, nil
}

// UpdateDatasetStatusActivity updates dataset status in config-service
func UpdateDatasetStatusActivity(ctx context.Context, projectId, datasetId, status, errorMessage string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateDatasetStatusActivity] Starting activity for dataset: %s, status: %s", datasetId, status)
	log.Printf("[UpdateDatasetStatusActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.UpdateDatasetStatus(projectId, datasetId, status, errorMessage)
	if err != nil {
		log.Printf("[UpdateDatasetStatusActivity] ERROR: Failed to update dataset status: %v", err)
		return fmt.Errorf("failed to update dataset status: %w", err)
	}

	log.Printf("[UpdateDatasetStatusActivity] Dataset status updated successfully for dataset: %s", datasetId)
	return nil
}
