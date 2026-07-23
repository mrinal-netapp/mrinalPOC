package types

// DatasetDeleteWorkflowInput represents input for dataset deletion workflow
type DatasetDeleteWorkflowInput struct {
	ProjectId   string `json:"projectId"`
	DataSetId   string `json:"dataSetId"`
	TableName   string `json:"tableName"`            // Table name in Lakekeeper catalog
	Namespace   string `json:"namespace"`            // Catalog namespace (e.g., projectId)
	WarehouseId string `json:"warehouseId"`          // Warehouse ID in Lakekeeper
	BucketName  string `json:"bucketName"`           // S3 bucket name (e.g., default-nemo)
	PathPrefix  string `json:"pathPrefix,omitempty"` // S3 path prefix (e.g., projects/<projectId>)
}

// DatasetDeleteWorkflowResult represents result of dataset deletion workflow
type DatasetDeleteWorkflowResult struct {
	ProjectId      string `json:"projectId"`
	DataSetId      string `json:"dataSetId"`
	TableName      string `json:"tableName"`
	TableDeleted   bool   `json:"tableDeleted"`   // Deleted from Lakekeeper
	S3FilesDeleted bool   `json:"s3FilesDeleted"` // Deleted from S3
	Status         string `json:"status"`         // "completed", "failed"
	ErrorMessage   string `json:"errorMessage,omitempty"`
}

// DeleteTableFromCatalogRequest represents request to delete a table from Lakekeeper catalog
type DeleteTableFromCatalogRequest struct {
	ProjectId   string `json:"projectId"`
	DataSetId   string `json:"dataSetId"`
	TableName   string `json:"tableName"`
	Namespace   string `json:"namespace"`
	WarehouseId string `json:"warehouseId"`
}

// DeleteDatasetFilesRequest represents request to delete dataset files from S3
type DeleteDatasetFilesRequest struct {
	ProjectId  string `json:"projectId"`
	DataSetId  string `json:"dataSetId"`
	BucketName string `json:"bucketName"`
	PathPrefix string `json:"pathPrefix,omitempty"` // S3 path prefix (e.g., projects/<projectId>)
}
