package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
)

type ExecutorService struct {
	temporalClient client.Client
	configClient   *clients.ConfigClient
	historyService *HistoryService
}

func NewExecutorService(temporalAddress, configServiceURL string) *ExecutorService {
	// Retry connection to Temporal server (it may not be ready immediately)
	var temporalClient client.Client
	var err error
	maxRetries, retryDelay := util.TemporalConnectOptions()
	for i := 0; i < maxRetries; i++ {
		temporalClient, err = client.Dial(client.Options{
			HostPort: temporalAddress,
		})
		if err == nil {
			break
		}
		if i < maxRetries-1 {
			time.Sleep(retryDelay)
		}
	}
	if err != nil {
		panic(fmt.Sprintf("Failed to create Temporal client after %d retries: %v", maxRetries, err))
	}

	return &ExecutorService{
		temporalClient: temporalClient,
		configClient:   clients.NewConfigClient(configServiceURL),
		historyService: NewHistoryService(configServiceURL),
	}
}

// NewExecutorServiceWithDeps returns an ExecutorService wired to caller-supplied
// Temporal and config-service clients. Used by tests to avoid a real Temporal
// dial; the behaviour of every method on ExecutorService is identical to the
// production constructor — only construction wiring differs.
func NewExecutorServiceWithDeps(temporalClient client.Client, configClient *clients.ConfigClient, historyService *HistoryService) *ExecutorService {
	if historyService == nil {
		historyService = &HistoryService{configClient: configClient}
	}
	return &ExecutorService{
		temporalClient: temporalClient,
		configClient:   configClient,
		historyService: historyService,
	}
}

// GetConfigClient returns the config client for use by activities (e.g. acquisition activities).
func (s *ExecutorService) GetConfigClient() *clients.ConfigClient {
	return s.configClient
}

func (s *ExecutorService) ExecutePipeline(projectId, pipelineId string, parameters map[string]interface{}) (string, error) {
	// Get pipeline definition from config-service
	pipeline, err := s.configClient.GetPipeline(projectId, pipelineId)
	if err != nil {
		return "", fmt.Errorf("failed to get pipeline: %w", err)
	}

	// Generate execution ID
	executionId := fmt.Sprintf("exec-%d-%s", time.Now().Unix(), generateRandomString(9))

	// Prepare workflow input
	workflowInput := types.PipelineWorkflowInput{
		PipelineId:  pipelineId,
		ProjectId:   projectId,
		ExecutionId: executionId,
		Parameters:  parameters,
		Pipeline:    pipeline,
	}

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("pipeline-%s-%s", pipelineId, executionId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"PipelineWorkflow",
		workflowInput,
	)
	if err != nil {
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	// Store execution metadata
	execution := &types.PipelineExecution{
		ExecutionId: executionId,
		PipelineId:  pipelineId,
		ProjectId:   projectId,
		WorkflowId:  workflowRun.GetID(),
		RunId:       workflowRun.GetRunID(),
		Status:      "running",
		StartedAt:   time.Now(),
	}

	if err := s.historyService.CreateExecution(execution); err != nil {
		// Log error but don't fail - workflow is already started
		fmt.Printf("Warning: Failed to store execution metadata: %s\n", util.SanitizeLog(err.Error()))
	}

	return executionId, nil
}

func (s *ExecutorService) CancelExecution(projectId, pipelineId, executionId string) error {
	// Get execution to find workflow ID
	execution, err := s.historyService.GetExecution(projectId, pipelineId, executionId)
	if err != nil {
		return fmt.Errorf("execution not found: %w", err)
	}

	// Cancel workflow
	err = s.temporalClient.CancelWorkflow(context.Background(), execution.WorkflowId, execution.RunId)
	if err != nil {
		return fmt.Errorf("failed to cancel workflow: %w", err)
	}

	// Update execution status
	execution.Status = "cancelled"
	endedAt := time.Now()
	execution.EndedAt = &endedAt
	return s.historyService.UpdateExecution(execution)
}

func (s *ExecutorService) StartProjectInit(projectId string, config types.ProjectInitWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting project init workflow for project: %s\n", util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: region=%s, storageClass=%s, storageSize=%s, s3GatewayEndpoint=%s\n",
		util.SanitizeLog(config.Region), util.SanitizeLog(config.StorageClass), util.SanitizeLog(config.StorageSize), util.SanitizeLog(config.S3GatewayEndpoint))

	// Ensure projectId is set
	config.ProjectId = projectId

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("project-init-%s", projectId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"ProjectInitWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start project init workflow for project %s: %v\n", util.SanitizeLog(projectId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] Project init workflow started successfully for project: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(projectId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartProjectDelete(projectId string, config types.ProjectDeleteWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting project delete workflow for project: %s\n", util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: bucketName=%s\n", util.SanitizeLog(config.BucketName))

	// Ensure projectId is set
	config.ProjectId = projectId
	if config.BucketName == "" {
		config.BucketName = projectId
	}

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("project-delete-%s", projectId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"ProjectDeleteWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start project delete workflow for project %s: %v\n", util.SanitizeLog(projectId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] Project delete workflow started successfully for project: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(projectId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartProjectAddUser(projectId string, input types.ProjectMembershipInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting add-user workflow for project: %s, user: %s, role: %s\n",
		util.SanitizeLog(projectId), util.SanitizeLog(input.UserId), util.SanitizeLog(input.Role))

	input.ProjectId = projectId

	workflowOptions := client.StartWorkflowOptions{
		ID:                    fmt.Sprintf("project-add-user-%s-%s-%s", projectId, input.UserId, input.Role),
		TaskQueue:             "pipeline-execution",
		WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"ProjectAddUserWorkflow",
		input,
	)
	if err != nil {
		return "", fmt.Errorf("failed to start add-user workflow: %w", err)
	}

	return workflowRun.GetID(), nil
}

func (s *ExecutorService) StartProjectRemoveUser(projectId string, input types.ProjectMembershipInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting remove-user workflow for project: %s, user: %s\n",
		util.SanitizeLog(projectId), util.SanitizeLog(input.UserId))

	input.ProjectId = projectId

	workflowOptions := client.StartWorkflowOptions{
		ID:                    fmt.Sprintf("project-remove-user-%s-%s", projectId, input.UserId),
		TaskQueue:             "pipeline-execution",
		WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"ProjectRemoveUserWorkflow",
		input,
	)
	if err != nil {
		return "", fmt.Errorf("failed to start remove-user workflow: %w", err)
	}

	return workflowRun.GetID(), nil
}

func (s *ExecutorService) StartProjectChangeRole(projectId string, input types.ProjectMembershipInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting change-role workflow for project: %s, user: %s, newRole: %s\n",
		util.SanitizeLog(projectId), util.SanitizeLog(input.UserId), util.SanitizeLog(input.Role))

	input.ProjectId = projectId

	workflowOptions := client.StartWorkflowOptions{
		ID:                                       fmt.Sprintf("project-change-role-%s-%s", projectId, input.UserId),
		TaskQueue:                                "pipeline-execution",
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"ProjectChangeRoleWorkflow",
		input,
	)
	if err != nil {
		return "", fmt.Errorf("failed to start change-role workflow: %w", err)
	}

	return workflowRun.GetID(), nil
}

func (s *ExecutorService) StartTableProcessing(projectId, datasetId string, config types.TableProcessingWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting table processing workflow for dataset: %s, project: %s\n", util.SanitizeLog(datasetId), util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: tableName=%s, namespace=%s, warehouseId=%s\n",
		util.SanitizeLog(config.TableName), util.SanitizeLog(config.Namespace), util.SanitizeLog(config.WarehouseId))

	// Ensure projectId and datasetId are set
	config.ProjectId = projectId
	config.DataSetId = datasetId

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("table-processing-%s-%s", projectId, datasetId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"TableProcessingWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start table processing workflow for dataset %s: %v\n", util.SanitizeLog(datasetId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] Table processing workflow started successfully for dataset: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(datasetId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartDatasetDeletion(projectId, datasetId string, config types.DatasetDeleteWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting dataset deletion workflow for dataset: %s, project: %s\n", util.SanitizeLog(datasetId), util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: tableName=%s, namespace=%s, warehouseId=%s, bucketName=%s\n",
		util.SanitizeLog(config.TableName), util.SanitizeLog(config.Namespace), util.SanitizeLog(config.WarehouseId), util.SanitizeLog(config.BucketName))

	// Ensure projectId and datasetId are set
	config.ProjectId = projectId
	config.DataSetId = datasetId

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("dataset-delete-%s-%s", projectId, datasetId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"DatasetDeleteWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start dataset deletion workflow for dataset %s: %v\n", util.SanitizeLog(datasetId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] Dataset deletion workflow started successfully for dataset: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(datasetId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartDatasetImport(projectId, datasetId string, config types.DatasetImportWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting dataset import workflow for dataset: %s, project: %s\n", util.SanitizeLog(datasetId), util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: datasetName=%s, datasetKind=%s, bucketName=%s, namespace=%s\n",
		util.SanitizeLog(config.DatasetName), util.SanitizeLog(config.DatasetKind), util.SanitizeLog(config.BucketName), util.SanitizeLog(config.Namespace))

	// Ensure projectId and datasetId are set
	config.ProjectId = projectId
	config.DataSetId = datasetId

	// For PII reprocess, use a deterministic facet workflow ID with dedup protection
	var workflowOptions client.StartWorkflowOptions
	if config.ReprocessPiiOnly {
		workflowOptions = client.StartWorkflowOptions{
			ID:                                       fmt.Sprintf("facet-dataset-%s-pii", datasetId),
			TaskQueue:                                "pipeline-execution",
			WorkflowExecutionErrorWhenAlreadyStarted: true,
		}
	} else {
		workflowOptions = client.StartWorkflowOptions{
			ID:        fmt.Sprintf("dataset-import-%s-%s", projectId, datasetId),
			TaskQueue: "pipeline-execution",
		}
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"DatasetImportWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start dataset import workflow for dataset %s: %v\n", util.SanitizeLog(datasetId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] Dataset import workflow started successfully for dataset: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(datasetId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartKnowledgeBaseCreation(projectId, kbId string, config types.KnowledgeBaseCreationWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting KB creation workflow for KB: %s, project: %s\n", util.SanitizeLog(kbId), util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: kbName=%s, sourceDatasetId=%s, embeddingModel=%s, chunkSize=%s, vectorSize=%s\n",
		util.SanitizeLog(config.KBName), util.SanitizeLog(config.SourceDatasetId), util.SanitizeLog(config.EmbeddingModel), util.SanitizeLog(strconv.Itoa(config.ChunkSize)), util.SanitizeLog(strconv.Itoa(config.VectorSize)))

	// Ensure projectId and kbId are set
	config.ProjectId = projectId
	config.KnowledgeBaseId = kbId

	// Start workflow with dedup protection (Layer 2: Temporal workflow ID dedup)
	workflowOptions := client.StartWorkflowOptions{
		ID:                                       fmt.Sprintf("facet-knowledge_base-%s-embedding", kbId),
		TaskQueue:                                "pipeline-execution",
		WorkflowRunTimeout:                       13 * time.Hour, // Must exceed the 12h absolute ceiling inside the workflow
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"KnowledgeBaseCreationWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start KB creation workflow for KB %s: %v\n", util.SanitizeLog(kbId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] KB creation workflow started successfully for KB: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(kbId), workflowID, runID)

	return workflowID, nil
}

func (s *ExecutorService) StartKnowledgeBaseDeletion(projectId, kbId string, config types.KnowledgeBaseDeleteWorkflowInput) (string, error) {
	fmt.Printf("[ExecutorService] Starting KB deletion workflow for KB: %s, project: %s\n", util.SanitizeLog(kbId), util.SanitizeLog(projectId))
	fmt.Printf("[ExecutorService] Configuration: bucketName=%s\n", util.SanitizeLog(config.BucketName))

	// Ensure projectId and kbId are set
	config.ProjectId = projectId
	config.KnowledgeBaseId = kbId

	// Start workflow
	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("kb-delete-%s-%s", projectId, kbId),
		TaskQueue: "pipeline-execution",
	}

	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"KnowledgeBaseDeleteWorkflow",
		config,
	)
	if err != nil {
		fmt.Printf("[ExecutorService] ERROR: Failed to start KB deletion workflow for KB %s: %v\n", util.SanitizeLog(kbId), err)
		return "", fmt.Errorf("failed to start workflow: %w", err)
	}

	workflowID := workflowRun.GetID()
	runID := workflowRun.GetRunID()
	fmt.Printf("[ExecutorService] KB deletion workflow started successfully for KB: %s, workflowID: %s, runID: %s\n", util.SanitizeLog(kbId), workflowID, runID)

	return workflowID, nil
}

// StartDataAcquisition starts a one-time data acquisition workflow.
func (s *ExecutorService) StartDataAcquisition(projectId, datasetId string) (string, error) {
	fmt.Printf("[ExecutorService] Starting data acquisition workflow for dataset: %s, project: %s\n", util.SanitizeLog(datasetId), util.SanitizeLog(projectId))

	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("data-acquire-%s-%s", projectId, datasetId),
		TaskQueue: "pipeline-execution",
	}

	configServiceURL := s.configClient.GetBaseURL()
	workflowRun, err := s.temporalClient.ExecuteWorkflow(
		context.Background(),
		workflowOptions,
		"DataAcquisitionWorkflow",
		map[string]interface{}{
			"projectId":        projectId,
			"datasetId":        datasetId,
			"configServiceURL": configServiceURL,
		},
	)
	if err != nil {
		return "", fmt.Errorf("failed to start data acquisition workflow: %w", err)
	}

	return workflowRun.GetID(), nil
}

// AcquisitionScheduleID returns the deterministic Temporal schedule id used for a
// dataset's recurring acquisition. Kept in one place so callers (e.g. the schedule
// handler) can delete a dataset's schedule even when the persisted
// temporalScheduleId is unavailable.
func AcquisitionScheduleID(projectId, datasetId string) string {
	return fmt.Sprintf("acq-%s-%s", projectId, datasetId)
}

// CreateAcquisitionSchedule creates a Temporal schedule for recurring data acquisition.
func (s *ExecutorService) CreateAcquisitionSchedule(projectId, datasetId, cronExpr, timezone string) (string, error) {
	fmt.Printf("[ExecutorService] Creating acquisition schedule for dataset: %s, cron: %s\n", util.SanitizeLog(datasetId), util.SanitizeLog(cronExpr))

	// Default to UTC so Temporal never receives an empty TimeZoneName (which it
	// may reject or resolve to an unintended server default).
	if timezone == "" {
		timezone = "UTC"
	}

	scheduleID := AcquisitionScheduleID(projectId, datasetId)

	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: scheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
			// Honor the caller's timezone so the cron fires at the intended
			// local time rather than the worker's server timezone.
			TimeZoneName: timezone,
			Jitter:       time.Minute,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow: "DataAcquisitionWorkflow",
			Args: []interface{}{map[string]interface{}{
				"projectId":        projectId,
				"datasetId":        datasetId,
				"configServiceURL": s.configClient.GetBaseURL(),
			}},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create schedule: %w", err)
	}

	return handle.GetID(), nil
}

// DeleteAcquisitionSchedule deletes a Temporal schedule.
func (s *ExecutorService) DeleteAcquisitionSchedule(scheduleID string) error {
	fmt.Printf("[ExecutorService] Deleting acquisition schedule: %s\n", util.SanitizeLog(scheduleID))
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), scheduleID)
	return handle.Delete(context.Background())
}

// DescribeAcquisitionSchedule returns schedule info from Temporal.
func (s *ExecutorService) DescribeAcquisitionSchedule(scheduleID string) (*client.ScheduleDescription, error) {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), scheduleID)
	return handle.Describe(context.Background())
}

// CreateKBSyncSchedule creates (or replaces) a Temporal schedule that triggers
// recurring KnowledgeBase sync. The schedule action targets the lightweight
// ScheduledKBSyncWorkflow which simply asks the config-service to run a fresh
// reprocess so the KB's persisted chunking/embedding/quantization settings are
// always read at trigger time.
func (s *ExecutorService) CreateKBSyncSchedule(projectId, kbId, cronExpr, timezone string) (string, error) {
	fmt.Printf("[ExecutorService] Creating KB sync schedule for KB: %s, cron: %s, tz: %s\n",
		util.SanitizeLog(kbId), util.SanitizeLog(cronExpr), util.SanitizeLog(timezone))

	scheduleID := fmt.Sprintf("kbsync-%s-%s", projectId, kbId)
	if timezone == "" {
		timezone = "UTC"
	}

	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: scheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
			TimeZoneName:    timezone,
			Jitter:          time.Minute,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow: "ScheduledKBSyncWorkflow",
			Args: []interface{}{map[string]interface{}{
				"projectId":        projectId,
				"knowledgeBaseId":  kbId,
				"configServiceURL": s.configClient.GetBaseURL(),
			}},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create KB sync schedule: %w", err)
	}

	return handle.GetID(), nil
}

// DeleteKBSyncSchedule deletes a KB sync Temporal schedule.
func (s *ExecutorService) DeleteKBSyncSchedule(scheduleID string) error {
	fmt.Printf("[ExecutorService] Deleting KB sync schedule: %s\n", util.SanitizeLog(scheduleID))
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), scheduleID)
	return handle.Delete(context.Background())
}

func (s *ExecutorService) CreateMCPHealthSchedule(cronExpr string) (string, error) {
	if cronExpr == "" {
		cronExpr = "*/5 * * * *"
	}
	scheduleID := "mcp-health-check"
	input := types.MCPHealthCheckInput{
		ConfigServiceURL: s.configClient.GetBaseURL(),
	}
	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: scheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
			Jitter:          time.Minute,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow:  "MCPHealthCheckWorkflow",
			Args:      []interface{}{input},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create MCP health schedule: %w", err)
	}
	return handle.GetID(), nil
}

func (s *ExecutorService) DeleteMCPHealthSchedule() error {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), "mcp-health-check")
	return handle.Delete(context.Background())
}

func (s *ExecutorService) DescribeMCPHealthSchedule() (*client.ScheduleDescription, error) {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), "mcp-health-check")
	return handle.Describe(context.Background())
}

// EnsureMCPHealthSchedule creates the MCP health schedule if it does not exist.
// If the schedule already exists, it is treated as success and left unchanged.
func (s *ExecutorService) EnsureMCPHealthSchedule(cronExpr string) (string, error) {
	scheduleID, err := s.CreateMCPHealthSchedule(cronExpr)
	if err == nil {
		return scheduleID, nil
	}
	var alreadyExists *serviceerror.AlreadyExists
	if errors.As(err, &alreadyExists) {
		return "mcp-health-check", nil
	}
	return "", err
}

const referenceEdgeReconcileScheduleID = "dependency-lineage-sync"

// CreateReferenceEdgeReconcileSchedule creates a Temporal schedule that
// fires `DependencyLineageSyncWorkflow` to discover cross-entity
// dependencies and maintain usage/lineage information.
func (s *ExecutorService) CreateReferenceEdgeReconcileSchedule(cronExpr string) (string, error) {
	if cronExpr == "" {
		cronExpr = "*/5 * * * *"
	}
	input := types.ReferenceEdgeReconcileInput{
		ConfigServiceURL: s.configClient.GetBaseURL(),
		// Full reconcile: scan all entity kinds so that edges for entities
		// created before the sync hooks were deployed are discovered, and
		// the lineage graph always reflects the current state.
		GraphOnly: false,
	}
	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: referenceEdgeReconcileScheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
			Jitter:          time.Minute,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow:  "DependencyLineageSyncWorkflow",
			Args:      []interface{}{input},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create dependency-lineage-sync schedule: %w", err)
	}
	return handle.GetID(), nil
}

func (s *ExecutorService) DeleteReferenceEdgeReconcileSchedule() error {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), referenceEdgeReconcileScheduleID)
	return handle.Delete(context.Background())
}

func (s *ExecutorService) DescribeReferenceEdgeReconcileSchedule() (*client.ScheduleDescription, error) {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), referenceEdgeReconcileScheduleID)
	return handle.Describe(context.Background())
}

// EnsureReferenceEdgeReconcileSchedule creates the schedule if missing,
// returning success when it already exists.
func (s *ExecutorService) EnsureReferenceEdgeReconcileSchedule(cronExpr string) (string, error) {
	scheduleID, err := s.CreateReferenceEdgeReconcileSchedule(cronExpr)
	if err == nil {
		return scheduleID, nil
	}
	var alreadyExists *serviceerror.AlreadyExists
	if errors.As(err, &alreadyExists) {
		return referenceEdgeReconcileScheduleID, nil
	}
	return "", err
}

const projectVKRotationScheduleID = "project-vk-rotation"

// CreateProjectVKRotationSchedule creates a Temporal schedule that fans out
// per-project virtual key rotation workflows on a fixed interval (default 24h).
func (s *ExecutorService) CreateProjectVKRotationSchedule(interval time.Duration, gracePeriod time.Duration) (string, error) {
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	if gracePeriod <= 0 {
		gracePeriod = 30 * time.Minute
	}
	input := types.ScheduledProjectVKRotationInput{
		ConfigServiceURL: s.configClient.GetBaseURL(),
		GracePeriod:      gracePeriod,
	}
	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: projectVKRotationScheduleID,
		Spec: client.ScheduleSpec{
			Intervals: []client.ScheduleIntervalSpec{
				{Every: interval},
			},
			Jitter: time.Minute * 5,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow:  "ScheduledProjectVirtualKeyRotationWorkflow",
			Args:      []interface{}{input},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create project VK rotation schedule: %w", err)
	}
	return handle.GetID(), nil
}

func (s *ExecutorService) DeleteProjectVKRotationSchedule() error {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), projectVKRotationScheduleID)
	return handle.Delete(context.Background())
}

func (s *ExecutorService) DescribeProjectVKRotationSchedule() (*client.ScheduleDescription, error) {
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), projectVKRotationScheduleID)
	return handle.Describe(context.Background())
}

// EnsureProjectVKRotationSchedule creates the VK rotation schedule if missing.
func (s *ExecutorService) EnsureProjectVKRotationSchedule(interval, gracePeriod time.Duration) (string, error) {
	scheduleID, err := s.CreateProjectVKRotationSchedule(interval, gracePeriod)
	if err == nil {
		return scheduleID, nil
	}
	var alreadyExists *serviceerror.AlreadyExists
	if errors.As(err, &alreadyExists) {
		return projectVKRotationScheduleID, nil
	}
	return "", err
}

// resolveConnectorTestActivityName picks the worker activity that should run
// for a given connector_type / provider pair.
//
// Routing is by connector_type first so a "storage" connector never
// accidentally falls back to a database-shaped test. Newer providers should
// use the generic TestProviderConnection activity (which dispatches in the
// worker by `provider` to the matching adapter); the per-type legacy
// activities (TestDatabaseConnection, TestObjectStoreConnection,
// TestCloudConnection) stay intact for SQL/object-store/GCP until they are
// migrated to the generic path.
func resolveConnectorTestActivityName(connType, provider string) string {
	switch connType {
	case "objectstore":
		return "TestObjectStoreConnection"
	case "cloud":
		// Azure cloud (ANF metrics) uses service-principal credentials, not GCP JSON.
		if provider == "azure_cloud" {
			return "TestProviderConnection"
		}
		return "TestCloudConnection"
	case "storage", "api":
		return "TestProviderConnection"
	case "database":
		return "TestDatabaseConnection"
	}
	// Legacy fallback for older records that pre-date connector_type:
	// route ONTAP explicitly to the generic activity.
	if provider == "ontap" {
		return "TestProviderConnection"
	}
	return ""
}

// StartConnectorTest dispatches a test activity and waits for the result.
func (s *ExecutorService) StartConnectorTest(projectId, connectorId string, connectorConfig map[string]interface{}, credentialID, configServiceURL string) (string, error) {
	connType, _ := connectorConfig["connector_type"].(string)
	provider, _ := connectorConfig["provider"].(string)
	activityName := resolveConnectorTestActivityName(connType, provider)
	if activityName == "" {
		return "", fmt.Errorf("unsupported connector type %q (provider %q) for connection test", connType, provider)
	}

	if configServiceURL == "" {
		configServiceURL = s.configClient.GetBaseURL()
	}

	workflowOptions := client.StartWorkflowOptions{
		ID:        fmt.Sprintf("connector-test-%s-%s-%d", projectId, connectorId, time.Now().Unix()),
		TaskQueue: "pipeline-execution",
	}

	input := map[string]interface{}{
		"projectID":        projectId,
		"credentialID":     credentialID,
		"connectorConfig":  connectorConfig,
		"configServiceURL": configServiceURL,
		"activityName":     activityName,
	}

	wfRun, err := s.temporalClient.ExecuteWorkflow(context.Background(), workflowOptions,
		"ConnectorInteractiveWorkflow", input)
	if err != nil {
		return "", err
	}
	return wfRun.GetID(), nil
}

// GetTemporalClient returns the underlying Temporal client for direct API access
// Used by workflow status/logs endpoints to query Temporal directly
func (s *ExecutorService) GetTemporalClient() client.Client {
	return s.temporalClient
}

// CancelWorkflowByID requests cancellation of a workflow by its ID and optional run ID.
// If runId is empty, the current run is cancelled. Returns nil on success or when the
// workflow is already cancelled/completed (idempotent).
func (s *ExecutorService) CancelWorkflowByID(ctx context.Context, workflowId, runId string) error {
	return s.temporalClient.CancelWorkflow(ctx, workflowId, runId)
}

// SignalWorkflowByID sends a signal to a running workflow by ID. Used by
// callers (e.g. config-service's eval cancel route) that want to deliver
// a soft-cancel or other in-band signal without hard-cancelling the run.
// If runId is empty, the current run receives the signal.
func (s *ExecutorService) SignalWorkflowByID(ctx context.Context, workflowId, runId, signalName string, payload any) error {
	return s.temporalClient.SignalWorkflow(ctx, workflowId, runId, signalName, payload)
}

// cancelWorkflowBestEffort cancels a workflow by ID, ignoring not-found / already-completed errors.
func (s *ExecutorService) cancelWorkflowBestEffort(ctx context.Context, workflowId string) bool {
	err := s.temporalClient.CancelWorkflow(ctx, workflowId, "")
	if err == nil {
		return true
	}
	var notFound *serviceerror.NotFound
	if errors.As(err, &notFound) {
		return false
	}
	log.Printf("[ExecutorService] CancelWorkflow %s: %s (ignored)", util.SanitizeLog(workflowId), util.SanitizeLog(err.Error()))
	return false
}

// TerminateDatasetWorkflows cancels all known workflow types associated with a dataset
// and deletes the acquisition schedule. Best-effort: errors are logged but not returned.
func (s *ExecutorService) TerminateDatasetWorkflows(ctx context.Context, projectId, datasetId string) []string {
	cancelled := []string{}

	// Delete acquisition schedule first to prevent new workflows from being spawned
	scheduleID := fmt.Sprintf("acq-%s-%s", projectId, datasetId)
	if err := s.DeleteAcquisitionSchedule(scheduleID); err == nil {
		cancelled = append(cancelled, "schedule:"+scheduleID)
	}

	workflowIDs := []string{
		fmt.Sprintf("data-acquire-%s-%s", projectId, datasetId),
		fmt.Sprintf("dataset-import-%s-%s", projectId, datasetId),
		fmt.Sprintf("import-%s-%s", projectId, datasetId),
		fmt.Sprintf("facet-dataset-%s-pii", datasetId),
	}
	for _, wfID := range workflowIDs {
		if s.cancelWorkflowBestEffort(ctx, wfID) {
			cancelled = append(cancelled, wfID)
		}
	}
	return cancelled
}

// TerminateKBWorkflows cancels all known workflow types associated with a knowledge base.
func (s *ExecutorService) TerminateKBWorkflows(ctx context.Context, kbId string) []string {
	cancelled := []string{}
	workflowIDs := []string{
		fmt.Sprintf("facet-knowledge_base-%s-embedding", kbId),
	}
	for _, wfID := range workflowIDs {
		if s.cancelWorkflowBestEffort(ctx, wfID) {
			cancelled = append(cancelled, wfID)
		}
	}
	return cancelled
}

// TerminatePipelineWorkflows cancels all running pipeline execution workflows
// by querying Temporal visibility with an ID prefix match.
func (s *ExecutorService) TerminatePipelineWorkflows(ctx context.Context, pipelineId string) []string {
	cancelled := []string{}
	prefix := fmt.Sprintf("pipeline-%s-", pipelineId)
	query := fmt.Sprintf("WorkflowId STARTS_WITH '%s' AND ExecutionStatus = 'Running'", prefix)

	resp, err := s.temporalClient.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{
		Query: query,
	})
	if err != nil {
		log.Printf("[ExecutorService] TerminatePipelineWorkflows list failed: %s", util.SanitizeLog(err.Error()))
		return cancelled
	}

	for _, wf := range resp.Executions {
		wfID := wf.GetExecution().GetWorkflowId()
		if s.cancelWorkflowBestEffort(ctx, wfID) {
			cancelled = append(cancelled, wfID)
		}
	}
	return cancelled
}

// TerminateConnectorWorkflows cancels all running connector workflows (test, explorer)
// by querying Temporal visibility with ID prefix matches.
func (s *ExecutorService) TerminateConnectorWorkflows(ctx context.Context, projectId, connectorId string) []string {
	cancelled := []string{}
	prefixes := []string{
		fmt.Sprintf("connector-test-%s-%s-", projectId, connectorId),
		fmt.Sprintf("explorer-%s-%s-", projectId, connectorId),
		fmt.Sprintf("explorer-list-%s-%s-", projectId, connectorId),
	}

	for _, prefix := range prefixes {
		query := fmt.Sprintf("WorkflowId STARTS_WITH '%s' AND ExecutionStatus = 'Running'", prefix)
		resp, err := s.temporalClient.ListWorkflow(ctx, &workflowservice.ListWorkflowExecutionsRequest{
			Query: query,
		})
		if err != nil {
			log.Printf("[ExecutorService] TerminateConnectorWorkflows list failed for prefix %s: %s", util.SanitizeLog(prefix), util.SanitizeLog(err.Error()))
			continue
		}
		for _, wf := range resp.Executions {
			wfID := wf.GetExecution().GetWorkflowId()
			if s.cancelWorkflowBestEffort(ctx, wfID) {
				cancelled = append(cancelled, wfID)
			}
		}
	}
	return cancelled
}

// StartExplorerSession loads the connector from config-service and starts a long-running
// ExplorerSessionWorkflow with the connector metadata as workflow input.
func (s *ExecutorService) StartExplorerSession(projectId, connectorId string) (string, error) {
	ds, err := s.configClient.GetDataSource(projectId, connectorId)
	if err != nil {
		return "", fmt.Errorf("failed to load connector %s: %w", connectorId, err)
	}

	connectorConfig, _ := ds["connector_config"].(map[string]interface{})
	if connectorConfig == nil {
		return "", fmt.Errorf("connector %s has no connector_config", connectorId)
	}
	credentialId, _ := ds["credential_id"].(string)
	provider, _ := connectorConfig["provider"].(string)
	scope, _ := connectorConfig["scope"].(string)
	if provider == "" {
		return "", fmt.Errorf("connector %s has no provider", connectorId)
	}
	if scope == "" {
		scope = "resource"
	}

	sessionId := fmt.Sprintf("%d", time.Now().UnixMilli())
	workflowId := fmt.Sprintf("explorer-%s-%s-%s", projectId, connectorId, sessionId)

	input := workflows.ExplorerSessionInput{
		ProjectID:        projectId,
		ConnectorID:      connectorId,
		ConnectorConfig:  connectorConfig,
		CredentialID:     credentialId,
		ConfigServiceURL: s.configClient.GetBaseURL(),
		Provider:         provider,
		Scope:            scope,
	}

	opts := client.StartWorkflowOptions{
		ID:        workflowId,
		TaskQueue: "pipeline-execution",
	}

	wfRun, err := s.temporalClient.ExecuteWorkflow(context.Background(), opts, workflows.ExplorerSessionWorkflow, input)
	if err != nil {
		return "", fmt.Errorf("failed to start explorer session workflow: %w", err)
	}
	log.Printf("[ExecutorService] Explorer session started: workflowId=%s runId=%s", wfRun.GetID(), wfRun.GetRunID())
	return workflowId, nil
}

// ExplorerList sends an Update to the explorer session workflow with the list request.
// Deprecated: use ExplorerListDirect when Temporal Update API is disabled.
func (s *ExecutorService) ExplorerList(sessionId string, action string, payload map[string]interface{}) (*workflows.ExplorerResponse, error) {
	req := workflows.ExplorerListRequest{
		Action:  action,
		Payload: payload,
	}

	handle, err := s.temporalClient.UpdateWorkflow(context.Background(), sessionId, "", "List", req)
	if err != nil {
		return nil, fmt.Errorf("failed to send List update: %w", err)
	}

	var result workflows.ExplorerResponse
	if err := handle.Get(context.Background(), &result); err != nil {
		return nil, fmt.Errorf("List update failed: %w", err)
	}

	return &result, nil
}

// ExplorerListDirect runs a one-shot ExplorerListWorkflow (no Update API required).
// Use this when UpdateWorkflowExecution is disabled on the Temporal namespace.
func (s *ExecutorService) ExplorerListDirect(projectId, connectorId, action string, payload map[string]interface{}) (*workflows.ExplorerResponse, error) {
	ds, err := s.configClient.GetDataSource(projectId, connectorId)
	if err != nil {
		return nil, fmt.Errorf("failed to load connector %s: %w", connectorId, err)
	}

	connectorConfig, _ := ds["connector_config"].(map[string]interface{})
	if connectorConfig == nil {
		return nil, fmt.Errorf("connector %s has no connector_config", connectorId)
	}
	credentialId, _ := ds["credential_id"].(string)
	provider, _ := connectorConfig["provider"].(string)
	scope, _ := connectorConfig["scope"].(string)
	if provider == "" {
		return nil, fmt.Errorf("connector %s has no provider", connectorId)
	}
	if scope == "" {
		scope = "resource"
	}
	if payload == nil {
		payload = map[string]interface{}{}
	}

	input := workflows.ExplorerListInput{
		ProjectID:        projectId,
		ConnectorID:      connectorId,
		ConnectorConfig:  connectorConfig,
		CredentialID:     credentialId,
		ConfigServiceURL: s.configClient.GetBaseURL(),
		Provider:         provider,
		Scope:            scope,
		Action:           action,
		Payload:          payload,
	}

	workflowId := fmt.Sprintf("explorer-list-%s-%s-%d", projectId, connectorId, time.Now().UnixNano())
	opts := client.StartWorkflowOptions{
		ID:        workflowId,
		TaskQueue: "pipeline-execution",
	}

	wfRun, err := s.temporalClient.ExecuteWorkflow(context.Background(), opts, workflows.ExplorerListWorkflow, input)
	if err != nil {
		return nil, fmt.Errorf("failed to start explorer list workflow: %w", err)
	}

	var result workflows.ExplorerResponse
	if err := wfRun.Get(context.Background(), &result); err != nil {
		return nil, fmt.Errorf("explorer list workflow failed: %w", err)
	}

	return &result, nil
}

// StartVolumeScan launches a VolumeScanWorkflow asynchronously and returns
// the Temporal workflowId. The workflow itself posts the scan_result/status
// back to config-service via PostScanResultActivity, so this call returns as
// soon as the workflow has been accepted by Temporal.
func (s *ExecutorService) StartVolumeScan(projectId, dataSourceId string, scanConfig map[string]interface{}) (string, error) {
	workflowId := fmt.Sprintf("volume-scan-%s-%s-%d", projectId, dataSourceId, time.Now().UnixNano())
	opts := client.StartWorkflowOptions{
		ID:        workflowId,
		TaskQueue: "pipeline-execution",
	}

	input := workflows.VolumeScanInput{
		ProjectID:    projectId,
		DataSourceID: dataSourceId,
		ScanConfig:   scanConfig,
	}

	wfRun, err := s.temporalClient.ExecuteWorkflow(context.Background(), opts, workflows.VolumeScanWorkflow, input)
	if err != nil {
		return "", fmt.Errorf("failed to start volume scan workflow: %w", err)
	}

	log.Printf("[ExecutorService] Volume scan started: workflowId=%s runId=%s project=%s dataSource=%s",
		wfRun.GetID(), wfRun.GetRunID(), util.SanitizeLog(projectId), util.SanitizeLog(dataSourceId))
	return wfRun.GetID(), nil
}

// ListVolumeDirectory dispatches a ListVolumeDirectory activity via a one-shot
// workflow and returns the directory listing result.
func (s *ExecutorService) ListVolumeDirectory(projectId, volumeId, subPath string) (map[string]interface{}, error) {
	input := workflows.VolumeBrowseInput{
		ProjectID: projectId,
		VolumeID:  volumeId,
		SubPath:   subPath,
	}

	workflowId := fmt.Sprintf("volume-browse-%s-%s-%d", projectId, volumeId, time.Now().UnixNano())
	opts := client.StartWorkflowOptions{
		ID:        workflowId,
		TaskQueue: "pipeline-execution",
	}

	wfRun, err := s.temporalClient.ExecuteWorkflow(context.Background(), opts, workflows.VolumeBrowseWorkflow, input)
	if err != nil {
		return nil, fmt.Errorf("failed to start volume browse workflow: %w", err)
	}

	var result map[string]interface{}
	if err := wfRun.Get(context.Background(), &result); err != nil {
		return nil, fmt.Errorf("volume browse workflow failed: %w", err)
	}

	return result, nil
}

// ResumeExecution sends a signal to a paused HIL workflow to resume with approval payload.
func (s *ExecutorService) ResumeExecution(projectId, pipelineId, executionId string, payload types.HILResumePayload) error {
	execution, err := s.historyService.GetExecution(projectId, pipelineId, executionId)
	if err != nil {
		return fmt.Errorf("execution not found: %w", err)
	}

	return s.temporalClient.SignalWorkflow(
		context.Background(), execution.WorkflowId, execution.RunId, "hil_resume", payload,
	)
}

// CreatePipelineSchedule creates a Temporal Schedule for recurring pipeline execution.
func (s *ExecutorService) CreatePipelineSchedule(projectId, pipelineId, cronExpr, timezone string) (string, error) {
	fmt.Printf("[ExecutorService] Creating pipeline schedule for pipeline: %s, cron: %s\n", util.SanitizeLog(pipelineId), util.SanitizeLog(cronExpr))

	pipeline, err := s.configClient.GetPipeline(projectId, pipelineId)
	if err != nil {
		return "", fmt.Errorf("failed to get pipeline: %w", err)
	}

	scheduleID := fmt.Sprintf("pipeline-%s-%s", projectId, pipelineId)

	if timezone == "" {
		timezone = "UTC"
	}

	handle, err := s.temporalClient.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: scheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
			Jitter:          time.Minute,
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow: "PipelineWorkflow",
			Args: []interface{}{types.PipelineWorkflowInput{
				PipelineId:  pipelineId,
				ProjectId:   projectId,
				ExecutionId: fmt.Sprintf("exec-%d-sched", time.Now().Unix()),
				Parameters:  map[string]interface{}{"trigger": "scheduled"},
				Pipeline:    pipeline,
			}},
			TaskQueue: "pipeline-execution",
		},
	})
	if err != nil {
		return "", fmt.Errorf("failed to create pipeline schedule: %w", err)
	}

	return handle.GetID(), nil
}

// DeletePipelineSchedule deletes a pipeline's Temporal schedule.
func (s *ExecutorService) DeletePipelineSchedule(projectId, pipelineId string) error {
	scheduleID := fmt.Sprintf("pipeline-%s-%s", projectId, pipelineId)
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), scheduleID)
	return handle.Delete(context.Background())
}

// DescribePipelineSchedule returns schedule info for a pipeline.
func (s *ExecutorService) DescribePipelineSchedule(projectId, pipelineId string) (*client.ScheduleDescription, error) {
	scheduleID := fmt.Sprintf("pipeline-%s-%s", projectId, pipelineId)
	handle := s.temporalClient.ScheduleClient().GetHandle(context.Background(), scheduleID)
	return handle.Describe(context.Background())
}

func generateRandomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[time.Now().UnixNano()%int64(len(charset))]
	}
	return string(b)
}
