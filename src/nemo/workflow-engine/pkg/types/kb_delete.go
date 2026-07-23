package types

// KnowledgeBaseDeleteWorkflowInput represents input for KB deletion workflow
type KnowledgeBaseDeleteWorkflowInput struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	BucketName      string `json:"bucketName"`           // S3 bucket name
	PathPrefix      string `json:"pathPrefix,omitempty"` // S3 path prefix (e.g., "projects/<projectId>")
}

// KnowledgeBaseDeleteWorkflowResult represents result of KB deletion workflow
type KnowledgeBaseDeleteWorkflowResult struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	S3FilesDeleted  bool   `json:"s3FilesDeleted"` // LanceDB and metadata deleted from S3
	Status          string `json:"status"`         // "completed", "failed"
	ErrorMessage    string `json:"errorMessage,omitempty"`
	FilesDeleted    int    `json:"filesDeleted,omitempty"` // Number of files deleted
}

// DeleteKBFilesRequest represents request to delete KB files from S3
type DeleteKBFilesRequest struct {
	ProjectId       string `json:"projectId"`
	KnowledgeBaseId string `json:"knowledgeBaseId"`
	BucketName      string `json:"bucketName"`
	PathPrefix      string `json:"pathPrefix,omitempty"` // S3 path prefix (e.g., "projects/<projectId>")
}

// DeleteKBFilesResult represents result of deleting KB files from S3
type DeleteKBFilesResult struct {
	FilesDeleted int  `json:"filesDeleted"`
	Success      bool `json:"success"`
}
