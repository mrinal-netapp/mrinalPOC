package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

func TestExecutor_CreateAcquisitionSchedule_BuildsScheduleID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)

	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create",
		mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			return opts.ID == "acq-p-d" &&
				len(opts.Spec.CronExpressions) == 1 &&
				opts.Spec.CronExpressions[0] == "*/5 * * * *"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("acq-p-d").Once()

	id, err := ex.CreateAcquisitionSchedule("p", "d", "*/5 * * * *", "")
	require.NoError(t, err)
	assert.Equal(t, "acq-p-d", id)
}

func TestExecutor_CreateAcquisitionSchedule_ErrorPropagated(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, errors.New("boom")).Once()

	_, err := ex.CreateAcquisitionSchedule("p", "d", "* * * * *", "")
	require.Error(t, err)
}

func TestExecutor_DeleteAcquisitionSchedule(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "acq-p-d").Return(schedHandle).Once()
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()

	require.NoError(t, ex.DeleteAcquisitionSchedule("acq-p-d"))
}

func TestExecutor_DescribeAcquisitionSchedule(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "acq-p-d").Return(schedHandle).Once()
	desc := &client.ScheduleDescription{}
	schedHandle.On("Describe", mock.Anything).Return(desc, nil).Once()

	got, err := ex.DescribeAcquisitionSchedule("acq-p-d")
	require.NoError(t, err)
	require.NotNil(t, got)
}

func TestExecutor_CreateKBSyncSchedule_DefaultsTimezoneAndID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create",
		mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			return opts.ID == "kbsync-p-kb" && opts.Spec.TimeZoneName == "UTC"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("kbsync-p-kb").Once()

	id, err := ex.CreateKBSyncSchedule("p", "kb", "0 * * * *", "")
	require.NoError(t, err)
	assert.Equal(t, "kbsync-p-kb", id)
}

func TestExecutor_DeleteKBSyncSchedule(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "kbsync-x").Return(schedHandle).Once()
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()
	require.NoError(t, ex.DeleteKBSyncSchedule("kbsync-x"))
}

func TestExecutor_MCPHealthSchedule_LifecycleAndDefaults(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)

	// Default cron is */5 * * * * when caller passes "".
	schedClient.On("Create",
		mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			return opts.ID == "mcp-health-check" &&
				opts.Spec.CronExpressions[0] == "*/5 * * * *"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("mcp-health-check").Once()

	id, err := ex.CreateMCPHealthSchedule("")
	require.NoError(t, err)
	assert.Equal(t, "mcp-health-check", id)

	schedClient.On("GetHandle", mock.Anything, "mcp-health-check").Return(schedHandle)
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()
	require.NoError(t, ex.DeleteMCPHealthSchedule())

	schedHandle.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	desc, err := ex.DescribeMCPHealthSchedule()
	require.NoError(t, err)
	require.NotNil(t, desc)
}

func TestExecutor_EnsureMCPHealthSchedule_AlreadyExists(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, &serviceerror.AlreadyExists{Message: "exists"}).Once()

	id, err := ex.EnsureMCPHealthSchedule("0 * * * *")
	require.NoError(t, err)
	assert.Equal(t, "mcp-health-check", id)
}

func TestExecutor_EnsureMCPHealthSchedule_PropagatesOtherError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, errors.New("boom")).Once()

	_, err := ex.EnsureMCPHealthSchedule("0 * * * *")
	require.Error(t, err)
}

func TestExecutor_ReferenceEdgeReconcileSchedule(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)

	schedClient.On("Create",
		mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			return opts.ID == "dependency-lineage-sync"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("dependency-lineage-sync").Once()

	id, err := ex.CreateReferenceEdgeReconcileSchedule("")
	require.NoError(t, err)
	assert.Equal(t, "dependency-lineage-sync", id)

	// EnsureReferenceEdgeReconcileSchedule with AlreadyExists is treated as success
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, &serviceerror.AlreadyExists{Message: "exists"}).Once()
	id2, err := ex.EnsureReferenceEdgeReconcileSchedule("0 * * * *")
	require.NoError(t, err)
	assert.Equal(t, "dependency-lineage-sync", id2)

	// Other errors propagate.
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, errors.New("nope")).Once()
	_, err = ex.EnsureReferenceEdgeReconcileSchedule("0 * * * *")
	require.Error(t, err)

	// Delete + Describe.
	schedClient.On("GetHandle", mock.Anything, "dependency-lineage-sync").Return(schedHandle)
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()
	require.NoError(t, ex.DeleteReferenceEdgeReconcileSchedule())

	schedHandle.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	d, err := ex.DescribeReferenceEdgeReconcileSchedule()
	require.NoError(t, err)
	require.NotNil(t, d)
}

func TestExecutor_ProjectVKRotationSchedule_LifecycleAndDefaults(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)

	schedClient.On("Create", mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			action, ok := opts.Action.(*client.ScheduleWorkflowAction)
			return ok &&
				opts.ID == "project-vk-rotation" &&
				len(opts.Spec.Intervals) == 1 &&
				opts.Spec.Intervals[0].Every == 24*time.Hour &&
				action.Workflow == "ScheduledProjectVirtualKeyRotationWorkflow"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("project-vk-rotation").Once()

	id, err := ex.CreateProjectVKRotationSchedule(24*time.Hour, 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "project-vk-rotation", id)

	schedClient.On("GetHandle", mock.Anything, "project-vk-rotation").Return(schedHandle)
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()
	require.NoError(t, ex.DeleteProjectVKRotationSchedule())

	schedHandle.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	desc, err := ex.DescribeProjectVKRotationSchedule()
	require.NoError(t, err)
	require.NotNil(t, desc)
}

func TestExecutor_EnsureProjectVKRotationSchedule_AlreadyExists(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, &serviceerror.AlreadyExists{}).Once()

	id, err := ex.EnsureProjectVKRotationSchedule(24*time.Hour, 30*time.Minute)
	require.NoError(t, err)
	assert.Equal(t, "project-vk-rotation", id)
}

func TestExecutor_PipelineSchedule_LifeCycle(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)

	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe"})
		})

	schedClient.On("Create",
		mock.Anything,
		mock.MatchedBy(func(opts client.ScheduleOptions) bool {
			return opts.ID == "pipeline-p-pipe"
		}),
	).Return(schedHandle, nil).Once()
	schedHandle.On("GetID").Return("pipeline-p-pipe").Once()

	id, err := ex.CreatePipelineSchedule("p", "pipe", "*/15 * * * *", "")
	require.NoError(t, err)
	assert.Equal(t, "pipeline-p-pipe", id)

	schedClient.On("GetHandle", mock.Anything, "pipeline-p-pipe").Return(schedHandle)
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()
	require.NoError(t, ex.DeletePipelineSchedule("p", "pipe"))

	schedHandle.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	got, err := ex.DescribePipelineSchedule("p", "pipe")
	require.NoError(t, err)
	require.NotNil(t, got)
}

func TestExecutor_CreatePipelineSchedule_PipelineFetchError(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})

	_, err := ex.CreatePipelineSchedule("p", "pipe", "*/15 * * * *", "America/New_York")
	require.Error(t, err)
}

func TestExecutor_TerminateDatasetWorkflows_DeletesScheduleAndCancelsAllIDs(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "acq-p-d").Return(schedHandle).Once()
	schedHandle.On("Delete", mock.Anything).Return(nil).Once()

	for _, wfID := range []string{
		"data-acquire-p-d",
		"dataset-import-p-d",
		"import-p-d",
		"facet-dataset-d-pii",
	} {
		mt.On("CancelWorkflow", mock.Anything, wfID, "").Return(nil).Once()
	}

	got := ex.TerminateDatasetWorkflows(context.Background(), "p", "d")
	require.NotEmpty(t, got)
	assert.Contains(t, got, "schedule:acq-p-d")
	assert.Contains(t, got, "data-acquire-p-d")
}

func TestExecutor_TerminatePipelineWorkflows_HappyPath(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ListWorkflow", mock.Anything,
		mock.MatchedBy(func(req *workflowservice.ListWorkflowExecutionsRequest) bool {
			return strings.Contains(req.Query, "WorkflowId STARTS_WITH 'pipeline-pX-'")
		}),
	).Return(&workflowservice.ListWorkflowExecutionsResponse{
		Executions: []*workflow.WorkflowExecutionInfo{
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "pipeline-pX-1", RunId: "r1"}},
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "pipeline-pX-2", RunId: "r2"}},
		},
	}, nil).Once()
	mt.On("CancelWorkflow", mock.Anything, "pipeline-pX-1", "").Return(nil).Once()
	mt.On("CancelWorkflow", mock.Anything, "pipeline-pX-2", "").Return(nil).Once()

	got := ex.TerminatePipelineWorkflows(context.Background(), "pX")
	assert.ElementsMatch(t, []string{"pipeline-pX-1", "pipeline-pX-2"}, got)
}

func TestExecutor_TerminatePipelineWorkflows_ListError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ListWorkflow", mock.Anything, mock.Anything).
		Return(nil, errors.New("list down")).Once()

	got := ex.TerminatePipelineWorkflows(context.Background(), "pX")
	assert.Empty(t, got)
}

func TestExecutor_TerminateConnectorWorkflows_AllPrefixes(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	// Three list queries (test/explorer/explorer-list); one returns a workflow, others empty.
	hit := &workflowservice.ListWorkflowExecutionsResponse{
		Executions: []*workflow.WorkflowExecutionInfo{
			{Execution: &commonpb.WorkflowExecution{WorkflowId: "explorer-p-c-1", RunId: "r"}},
		},
	}
	empty := &workflowservice.ListWorkflowExecutionsResponse{}
	mt.On("ListWorkflow", mock.Anything,
		mock.MatchedBy(func(req *workflowservice.ListWorkflowExecutionsRequest) bool {
			return strings.Contains(req.Query, "connector-test-")
		})).Return(empty, nil).Once()
	mt.On("ListWorkflow", mock.Anything,
		mock.MatchedBy(func(req *workflowservice.ListWorkflowExecutionsRequest) bool {
			return strings.HasPrefix(req.Query, "WorkflowId STARTS_WITH 'explorer-p-c-' AND")
		})).Return(hit, nil).Once()
	mt.On("ListWorkflow", mock.Anything,
		mock.MatchedBy(func(req *workflowservice.ListWorkflowExecutionsRequest) bool {
			return strings.Contains(req.Query, "explorer-list-")
		})).Return(empty, nil).Once()

	mt.On("CancelWorkflow", mock.Anything, "explorer-p-c-1", "").Return(nil).Once()

	got := ex.TerminateConnectorWorkflows(context.Background(), "p", "c")
	assert.Equal(t, []string{"explorer-p-c-1"}, got)
}

func TestExecutor_StartVolumeScan_BuildsID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return strings.HasPrefix(o.ID, "volume-scan-p-ds-")
		}),
		mock.Anything,
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "volume-scan-p-ds-1"}, nil).Once()

	id, err := ex.StartVolumeScan("p", "ds", map[string]interface{}{"depth": 3})
	require.NoError(t, err)
	assert.Equal(t, "volume-scan-p-ds-1", id)
}

func TestExecutor_StartExplorerSession_LoadsConnectorAndDispatches(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"connector_config": map[string]interface{}{"provider": "ontap", "scope": "resource"},
				"credential_id":    "cred",
			})
		})
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return strings.HasPrefix(o.ID, "explorer-p-c-")
		}),
		mock.Anything,
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "explorer-p-c-x", runID: "r"}, nil).Once()

	id, err := ex.StartExplorerSession("p", "c")
	require.NoError(t, err)
	assert.NotEmpty(t, id)
}

func TestExecutor_StartExplorerSession_MissingConnector(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})
	_, err := ex.StartExplorerSession("p", "c")
	require.Error(t, err)
}

func TestExecutor_StartExplorerSession_MissingProvider(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"connector_config": map[string]interface{}{},
			})
		})
	_, err := ex.StartExplorerSession("p", "c")
	require.Error(t, err)
}
