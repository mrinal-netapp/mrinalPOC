package activities

import (
	"context"
	"fmt"
	"log"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
)

var configClientForAcquisition *clients.ConfigClient

// InitAcquisitionActivities sets the config client for acquisition activities.
func InitAcquisitionActivities(cc *clients.ConfigClient) {
	configClientForAcquisition = cc
}

// FetchDatasetConfigActivity fetches dataset configuration from config-service.
func FetchDatasetConfigActivity(ctx context.Context, projectID, datasetID string) (map[string]interface{}, error) {
	if configClientForAcquisition == nil {
		return nil, fmt.Errorf("config client not initialized for acquisition activities (InitAcquisitionActivities not called)")
	}
	log.Printf("[FetchDatasetConfigActivity] Fetching dataset: %s/%s", projectID, datasetID)
	return configClientForAcquisition.GetDataset(projectID, datasetID)
}

// FetchDataSourceConfigActivity fetches data source configuration from config-service.
func FetchDataSourceConfigActivity(ctx context.Context, projectID, dataSourceID string) (map[string]interface{}, error) {
	if configClientForAcquisition == nil {
		return nil, fmt.Errorf("config client not initialized for acquisition activities (InitAcquisitionActivities not called)")
	}
	log.Printf("[FetchDataSourceConfigActivity] Fetching data source: %s/%s", projectID, dataSourceID)
	return configClientForAcquisition.GetDataSource(projectID, dataSourceID)
}

// UpdateDatasetWatermarkActivity updates the dataset watermark via config-service.
func UpdateDatasetWatermarkActivity(ctx context.Context, projectID, datasetID, lastWatermarkValue string) error {
	if configClientForAcquisition == nil {
		return fmt.Errorf("config client not initialized for acquisition activities (InitAcquisitionActivities not called)")
	}
	log.Printf("[UpdateDatasetWatermarkActivity] Updating watermark: %s/%s -> %s", projectID, datasetID, lastWatermarkValue)
	return configClientForAcquisition.UpdateDatasetWatermark(projectID, datasetID, lastWatermarkValue)
}
