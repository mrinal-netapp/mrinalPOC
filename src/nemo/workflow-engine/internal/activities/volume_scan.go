package activities

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"go.temporal.io/sdk/activity"
)

// PostScanResultActivity posts the final scan_status (and optional scan_result)
// back to config-service via the internal /scan-result PATCH endpoint. Called
// at the end of VolumeScanWorkflow, regardless of whether the scan succeeded
// or failed.
func PostScanResultActivity(
	ctx context.Context,
	projectID, dataSourceID string,
	scanStatus map[string]interface{},
	scanResult map[string]interface{},
) error {
	info := activity.GetInfo(ctx)
	log.Printf(
		"[PostScanResultActivity] dataSource=%s/%s workflowID=%s state=%v",
		projectID, dataSourceID, info.WorkflowExecution.ID, scanStatus["state"],
	)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	if err := configClient.PostDataSourceScanResult(projectID, dataSourceID, scanStatus, scanResult); err != nil {
		log.Printf("[PostScanResultActivity] ERROR: %v", err)
		return fmt.Errorf("failed to post scan result: %w", err)
	}

	log.Printf("[PostScanResultActivity] Scan result posted for %s/%s", projectID, dataSourceID)
	return nil
}
