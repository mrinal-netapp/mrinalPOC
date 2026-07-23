package types

// TableProcessingWorkflowInput represents input for table processing workflow
type TableProcessingWorkflowInput struct {
	ProjectId   string `json:"projectId"`
	DataSetId   string `json:"dataSetId"`
	TableName   string `json:"tableName"`
	Namespace   string `json:"namespace"` // Catalog namespace (e.g., "default")
	WarehouseId string `json:"warehouseId,omitempty"`
}

// TableProcessingWorkflowResult represents result of table processing workflow
type TableProcessingWorkflowResult struct {
	ProjectId    string `json:"projectId"`
	DataSetId    string `json:"dataSetId"`
	TableName    string `json:"tableName"`
	Status       string `json:"status"` // "completed", "failed"
	ErrorMessage string `json:"errorMessage,omitempty"`
}
