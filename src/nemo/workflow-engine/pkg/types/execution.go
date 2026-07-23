package types

import "time"

// PipelineExecution represents a pipeline execution record
type PipelineExecution struct {
	ExecutionId string                 `json:"executionId"`
	PipelineId  string                 `json:"pipelineId"`
	ProjectId   string                 `json:"projectId"`
	WorkflowId  string                 `json:"workflowId"`
	RunId       string                 `json:"runId"`
	Status      string                 `json:"status"` // running, completed, failed, cancelled
	StartedAt   time.Time              `json:"startedAt"`
	EndedAt     *time.Time             `json:"endedAt,omitempty"`
	Results     map[string]interface{} `json:"results,omitempty"`
	Error       string                 `json:"error,omitempty"`
}

// Pipeline represents a pipeline definition
type Pipeline struct {
	ID          string        `json:"id"`
	ProjectId   string        `json:"projectId"`
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Type        string        `json:"type"` // Data or API
	Graph       PipelineGraph `json:"graph"`
	CreatedAt   time.Time     `json:"createdAt"`
	UpdatedAt   time.Time     `json:"updatedAt"`
}

// PipelineGraph represents the DAG structure
type PipelineGraph struct {
	Nodes []PipelineNode `json:"nodes"`
	Edges []PipelineEdge `json:"edges"`
}

// PipelineNode represents a node in the pipeline
type PipelineNode struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"`
	Config   map[string]interface{} `json:"config,omitempty"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// PipelineEdge represents an edge in the pipeline
type PipelineEdge struct {
	From   string                 `json:"from"`
	To     string                 `json:"to"`
	Config map[string]interface{} `json:"config,omitempty"`
}

// PipelineWorkflowInput is the input for the pipeline workflow
type PipelineWorkflowInput struct {
	PipelineId  string                 `json:"pipelineId"`
	ProjectId   string                 `json:"projectId"`
	ExecutionId string                 `json:"executionId"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Pipeline    *Pipeline              `json:"pipeline"`
}

// StepResult represents the result of a pipeline step
type StepResult struct {
	NodeId  string                 `json:"nodeId"`
	Status  string                 `json:"status"` // completed, failed, waiting_for_approval, timed_out
	Results map[string]interface{} `json:"results,omitempty"`
	Output  map[string]interface{} `json:"output,omitempty"`
	Error   string                 `json:"error,omitempty"`
}

// HILResumePayload is sent by the GUI to resume a paused HIL block
type HILResumePayload struct {
	ApprovedIds []string `json:"approvedIds"`
	RejectedIds []string `json:"rejectedIds"`
	TimedOut    bool     `json:"timedOut,omitempty"`
}

// PipelineExecutionResult represents the final result of a pipeline execution
type PipelineExecutionResult struct {
	ExecutionId string                 `json:"executionId"`
	PipelineId  string                 `json:"pipelineId"`
	Status      string                 `json:"status"`
	Steps       []StepResult           `json:"steps"`
	FinalOutput map[string]interface{} `json:"finalOutput,omitempty"`
}

// StepExecutionInput is the input for executing a pipeline step
type StepExecutionInput struct {
	ClusterId       string                            `json:"clusterId"`
	NodeId          string                            `json:"nodeId"`
	NodeType        string                            `json:"nodeType"`
	Config          map[string]interface{}            `json:"config"`
	PipelineId      string                            `json:"pipelineId"`
	ExecutionId     string                            `json:"executionId"`
	ProjectId       string                            `json:"projectId,omitempty"`
	PreviousOutputs map[string]map[string]interface{} `json:"previousOutputs,omitempty"`
}

// ResourceRequirements represents K8s resource requirements
type ResourceRequirements struct {
	CPU    string `json:"cpu,omitempty"`
	Memory string `json:"memory,omitempty"`
}

// PodCreationInput represents input for creating a pod
type PodCreationInput struct {
	Name      string               `json:"name"`
	Image     string               `json:"image"`
	Command   []string             `json:"command,omitempty"`
	Args      []string             `json:"args,omitempty"`
	Env       map[string]string    `json:"env,omitempty"`
	Resources ResourceRequirements `json:"resources,omitempty"`
	Namespace string               `json:"namespace"`
}

// PodCreationResult represents the result of pod creation
type PodCreationResult struct {
	PodName string `json:"podName"`
	Status  string `json:"status"`
}

// ProjectMemberInvite is a requested project member, by email + role. The
// email is resolved to a Keycloak userId (resolve-or-create) before the role
// is granted, since authz policies are keyed by userId, never email.
type ProjectMemberInvite struct {
	Email string `json:"email"`
	Role  string `json:"role"` // admin | member | viewer
}

// ResolvedMember is the result of resolving an invitee email to a Keycloak
// userId via config-service's /internal/users/resolve-or-create endpoint.
type ResolvedMember struct {
	Email   string `json:"email"`
	UserId  string `json:"userId"`
	Created bool   `json:"created"`
}

// ProjectInitWorkflowInput is the input for the project initialization workflow
type ProjectInitWorkflowInput struct {
	ProjectId         string `json:"projectId"`
	Region            string `json:"region"`
	StorageClass      string `json:"storageClass,omitempty"`
	StorageSize       string `json:"storageSize,omitempty"`
	S3GatewayEndpoint string `json:"s3GatewayEndpoint,omitempty"`
	OwnerUserId       string `json:"ownerUserId,omitempty"` // Keycloak user ID of the project creator (from JWT sub)
	// Members are additional invitees (besides the owner) to grant roles to as
	// part of init. Each email is resolved-or-created in config-service, then
	// granted its role via GrantProjectRoleActivity.
	Members []ProjectMemberInvite `json:"members,omitempty"`
}

// ReportProjectInitStatusInput is the activity input for reporting the terminal
// init status back to config-service. Status is "ready" or "failed".
type ReportProjectInitStatusInput struct {
	ProjectId string `json:"projectId"`
	Status    string `json:"status"`          // ready | failed
	Error     string `json:"error,omitempty"` // populated when Status == failed
}

// ProjectInitWorkflowResult represents the result of project initialization
type ProjectInitWorkflowResult struct {
	ProjectId           string        `json:"projectId"`
	BucketCreated       bool          `json:"bucketCreated"`
	BucketName          string        `json:"bucketName"`
	WarehouseRegistered bool          `json:"warehouseRegistered"`
	WarehouseName       string        `json:"warehouseName"`
	WarehouseId         string        `json:"warehouseId,omitempty"`
	NamespaceCreated    bool          `json:"namespaceCreated"`
	NamespaceName       string        `json:"namespaceName,omitempty"`
	Status              string        `json:"status"` // completed, failed
	Error               string        `json:"error,omitempty"`
	Duration            time.Duration `json:"duration,omitempty"`
}

// CreateBucketRequest represents a request to create a bucket
type CreateBucketRequest struct {
	Name       string                 `json:"name"`
	Region     string                 `json:"region"`
	Protocol   string                 `json:"protocol"`
	VolumeInfo map[string]interface{} `json:"volume_info"`
	AuthInfo   map[string]interface{} `json:"auth_info"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
}

// RegisterWarehouseRequest represents a request to register a warehouse in Lakekeeper
// Warehouses are created in the default Lakekeeper project (nil UUID)
type RegisterWarehouseRequest struct {
	WarehouseName     string                 `json:"warehouse-name"`
	StorageProfile    map[string]interface{} `json:"storage-profile"`
	StorageCredential map[string]interface{} `json:"storage-credential,omitempty"`
}

// CreateNamespaceRequest represents a request to create a namespace in Lakekeeper catalog
type CreateNamespaceRequest struct {
	WarehouseId string   `json:"warehouseId"` // Warehouse ID used as prefix in catalog path
	Namespace   []string `json:"namespace"`   // Namespace is an array of strings (e.g., ["default"])
}

// ProjectGatewayMeta carries the pre-loaded Bifrost team / virtual-key
// identifiers for a project, captured by the config-service DELETE
// handler from `projects.metadata._gateway` BEFORE the project row is
// dropped. The values are forwarded into `ProjectDeleteWorkflowInput`
// so `TeardownProjectLLMGatewayActivity` can pass them on to
// `POST /api/v1/internal/projects/:projectId/gateway-teardown`, which
// uses them to find the VK / team to delete in Bifrost's `config_store`
// even after the project row in config-service Postgres is gone (the
// workflow runs asynchronously after the handler returns 204).
//
// Never carries the VK bearer TOKEN itself -- that lives only in the
// K8s Secret (and in the future, a managed Key Vault). The
// gateway-teardown endpoint doesn't need the token to drop the VK.
type ProjectGatewayMeta struct {
	TeamId         string `json:"teamId,omitempty"`
	TeamName       string `json:"teamName,omitempty"`
	VirtualKeyId   string `json:"virtualKeyId,omitempty"`
	VirtualKeyName string `json:"virtualKeyName,omitempty"`
}

// ProjectDeleteWorkflowInput is the input for the project deletion workflow
type ProjectDeleteWorkflowInput struct {
	ProjectId  string              `json:"projectId"`
	BucketName string              `json:"bucketName"`        // Default bucket name (usually same as projectId)
	Gateway    *ProjectGatewayMeta `json:"gateway,omitempty"` // Pre-loaded Bifrost team/VK ids; nil when project has no governance
}

// TeardownProjectLLMGatewayInput is the activity input for
// `TeardownProjectLLMGatewayActivity`. Mirrors the
// `gateway-teardown` config-service endpoint body.
type TeardownProjectLLMGatewayInput struct {
	ProjectId string              `json:"projectId"`
	Gateway   *ProjectGatewayMeta `json:"gateway,omitempty"`
}

// ProjectDeleteWorkflowResult represents the result of project deletion
type ProjectDeleteWorkflowResult struct {
	ProjectId             string        `json:"projectId"`
	BucketDeleted         bool          `json:"bucketDeleted"`
	BucketName            string        `json:"bucketName"`
	WarehouseUnregistered bool          `json:"warehouseUnregistered"`
	WarehouseName         string        `json:"warehouseName"`
	BucketRemovedFromDB   bool          `json:"bucketRemovedFromDB"`
	Status                string        `json:"status"` // completed, failed
	Error                 string        `json:"error,omitempty"`
	Duration              time.Duration `json:"duration,omitempty"`
}

// DeleteBucketRequest represents a request to delete a bucket
type DeleteBucketRequest struct {
	ProjectId  string `json:"projectId"`
	BucketName string `json:"bucketName"`
}

// UnregisterWarehouseRequest represents a request to unregister a warehouse in Lakekeeper
type UnregisterWarehouseRequest struct {
	WarehouseName string `json:"warehouse-name"`         // Used to look up warehouse ID
	WarehouseId   string `json:"warehouse-id,omitempty"` // If provided, used directly; otherwise looked up by name
}

// ListTablesInWarehouseRequest represents a request to list all tables in a warehouse
type ListTablesInWarehouseRequest struct {
	WarehouseId string `json:"warehouseId"`
	Namespace   string `json:"namespace"` // e.g., "default"
}

// ListTablesResult represents the result of listing tables
type ListTablesResult struct {
	Tables []string `json:"tables"` // List of table names
}

// DeleteNamespaceRequest represents a request to delete a namespace from Lakekeeper
type DeleteNamespaceRequest struct {
	WarehouseId string `json:"warehouseId"`
	Namespace   string `json:"namespace"`
}

// LookupWarehouseRequest represents a request to look up warehouse ID by name
type LookupWarehouseRequest struct {
	WarehouseName string `json:"warehouseName"`
}

// LookupWarehouseResult represents the result of warehouse lookup
type LookupWarehouseResult struct {
	WarehouseId   string `json:"warehouseId"`
	WarehouseName string `json:"warehouseName"`
	Found         bool   `json:"found"`
}

// ListNamespacesRequest represents a request to list all namespaces in a warehouse
type ListNamespacesRequest struct {
	WarehouseId string `json:"warehouseId"`
}

// ListNamespacesResult represents the result of listing namespaces
type ListNamespacesResult struct {
	Namespaces []string `json:"namespaces"`
}
