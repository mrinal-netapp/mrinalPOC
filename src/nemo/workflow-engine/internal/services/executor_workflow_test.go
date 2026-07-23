package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

// fakeWorkflowRun is the mockable WorkflowRun returned by ExecuteWorkflow.
type fakeWorkflowRun struct {
	id     string
	runID  string
	getErr error
	getOut interface{}
}

func (f *fakeWorkflowRun) GetID() string    { return f.id }
func (f *fakeWorkflowRun) GetRunID() string { return f.runID }
func (f *fakeWorkflowRun) Get(_ context.Context, valuePtr interface{}) error {
	return f.assignAndReturn(valuePtr)
}
func (f *fakeWorkflowRun) GetWithOptions(_ context.Context, _ interface{}, _ client.WorkflowRunGetOptions) error {
	return f.getErr
}
func (f *fakeWorkflowRun) assignAndReturn(out interface{}) error {
	if f.getErr != nil {
		return f.getErr
	}
	if out == nil || f.getOut == nil {
		return nil
	}
	// JSON round-trip into the caller's pointer
	data, err := json.Marshal(f.getOut)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func newExecutorWithMockTemporal(t *testing.T) (*ExecutorService, *mocks.Client, *stubConfigService) {
	t.Helper()
	mt := &mocks.Client{}
	stub := newStubConfigService(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, stub.server.Client())
	hs := NewHistoryServiceWithClient(cc)
	ex := NewExecutorServiceWithDeps(mt, cc, hs)
	t.Cleanup(func() { mt.AssertExpectations(t) })
	return ex, mt, stub
}

func TestExecutor_ExecutePipeline_Success(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)

	stub.handle(http.MethodGet, "/api/v1/projects/p1/pipelines/pipe-1",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe-1", ProjectId: "p1"})
		})
	stub.handle(http.MethodPost, "/api/v1/projects/p1/pipelines/pipe-1/executions",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusCreated)
		})

	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return strings.HasPrefix(opts.ID, "pipeline-pipe-1-exec-") &&
				opts.TaskQueue == "pipeline-execution"
		}),
		"PipelineWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "run-1"}, nil).Once()

	id, err := ex.ExecutePipeline("p1", "pipe-1", map[string]interface{}{"k": "v"})
	require.NoError(t, err)
	assert.NotEmpty(t, id)
}

func TestExecutor_ExecutePipeline_PipelineFetchFailure(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})

	_, err := ex.ExecutePipeline("p", "pipe", nil)
	require.Error(t, err)
}

func TestExecutor_ExecutePipeline_StartWorkflowError(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe"})
		})
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()

	_, err := ex.ExecutePipeline("p", "pipe", nil)
	require.Error(t, err)
}

func TestExecutor_StartProjectInit_Success(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "project-init-p1" && opts.TaskQueue == "pipeline-execution"
		}),
		"ProjectInitWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "project-init-p1", runID: "r1"}, nil).Once()

	id, err := ex.StartProjectInit("p1", types.ProjectInitWorkflowInput{Region: "us-east"})
	require.NoError(t, err)
	assert.Equal(t, "project-init-p1", id)
}

func TestExecutor_StartProjectInit_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectInitWorkflow", mock.Anything).
		Return(nil, errors.New("boom")).Once()
	_, err := ex.StartProjectInit("p", types.ProjectInitWorkflowInput{})
	require.Error(t, err)
}

func TestExecutor_StartProjectDelete_DefaultsBucketName(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.Anything,
		"ProjectDeleteWorkflow",
		mock.MatchedBy(func(input types.ProjectDeleteWorkflowInput) bool {
			return input.ProjectId == "p1" && input.BucketName == "p1"
		}),
	).Return(&fakeWorkflowRun{id: "project-delete-p1"}, nil).Once()

	id, err := ex.StartProjectDelete("p1", types.ProjectDeleteWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "project-delete-p1", id)
}

func TestExecutor_StartTableProcessing_BuildsID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "table-processing-p1-d1"
		}),
		"TableProcessingWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "table-processing-p1-d1"}, nil).Once()

	id, err := ex.StartTableProcessing("p1", "d1", types.TableProcessingWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "table-processing-p1-d1", id)
}

func TestExecutor_StartDatasetDeletion_BuildsID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "dataset-delete-p1-d1"
		}),
		"DatasetDeleteWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "dataset-delete-p1-d1"}, nil).Once()

	id, err := ex.StartDatasetDeletion("p1", "d1", types.DatasetDeleteWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "dataset-delete-p1-d1", id)
}

func TestExecutor_StartDatasetImport_NormalAndPII(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)

	// Normal (non-PII) path: regular dataset-import ID.
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "dataset-import-p-d" && !o.WorkflowExecutionErrorWhenAlreadyStarted
		}),
		"DatasetImportWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "dataset-import-p-d"}, nil).Once()

	id, err := ex.StartDatasetImport("p", "d", types.DatasetImportWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "dataset-import-p-d", id)

	// PII reprocess path: deterministic ID + dedup error flag.
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "facet-dataset-d-pii" && o.WorkflowExecutionErrorWhenAlreadyStarted
		}),
		"DatasetImportWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "facet-dataset-d-pii"}, nil).Once()

	id2, err := ex.StartDatasetImport("p", "d", types.DatasetImportWorkflowInput{ReprocessPiiOnly: true})
	require.NoError(t, err)
	assert.Equal(t, "facet-dataset-d-pii", id2)
}

func TestExecutor_StartKnowledgeBaseCreation_BuildsID(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "facet-knowledge_base-kb1-embedding" && o.WorkflowExecutionErrorWhenAlreadyStarted
		}),
		"KnowledgeBaseCreationWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "facet-knowledge_base-kb1-embedding"}, nil).Once()

	id, err := ex.StartKnowledgeBaseCreation("p", "kb1", types.KnowledgeBaseCreationWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "facet-knowledge_base-kb1-embedding", id)
}

func TestExecutor_StartKnowledgeBaseDeletion(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "kb-delete-p-kb"
		}),
		"KnowledgeBaseDeleteWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "kb-delete-p-kb"}, nil).Once()

	id, err := ex.StartKnowledgeBaseDeletion("p", "kb", types.KnowledgeBaseDeleteWorkflowInput{})
	require.NoError(t, err)
	assert.Equal(t, "kb-delete-p-kb", id)
}

func TestExecutor_StartDataAcquisition(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	_ = stub
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "data-acquire-p-d"
		}),
		"DataAcquisitionWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "data-acquire-p-d"}, nil).Once()

	id, err := ex.StartDataAcquisition("p", "d")
	require.NoError(t, err)
	assert.Equal(t, "data-acquire-p-d", id)
}

func TestExecutor_StartDataAcquisition_ErrorPropagated(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "DataAcquisitionWorkflow", mock.Anything).
		Return(nil, errors.New("nope")).Once()
	_, err := ex.StartDataAcquisition("p", "d")
	require.Error(t, err)
}

func TestExecutor_GetTemporalAndConfig(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	require.NotNil(t, ex.GetTemporalClient())
	require.Same(t, mt, ex.GetTemporalClient())
	require.NotNil(t, ex.GetConfigClient())
}

func TestExecutor_CancelWorkflowByID_Delegates(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-1").Return(nil).Once()
	require.NoError(t, ex.CancelWorkflowByID(context.Background(), "wf-1", "run-1"))
}

func TestExecutor_CancelWorkflowBestEffort_NotFoundIsSuppressed(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)

	mt.On("CancelWorkflow", mock.Anything, "ok-wf", "").Return(nil).Once()
	mt.On("CancelWorkflow", mock.Anything, "missing-wf", "").
		Return(serviceerror.NewNotFound("nope")).Once()
	mt.On("CancelWorkflow", mock.Anything, "transient-wf", "").
		Return(errors.New("transient")).Once()

	require.True(t, ex.cancelWorkflowBestEffort(context.Background(), "ok-wf"))
	require.False(t, ex.cancelWorkflowBestEffort(context.Background(), "missing-wf"))
	// transient errors are logged + treated as "not cancelled" but not surfaced.
	require.False(t, ex.cancelWorkflowBestEffort(context.Background(), "transient-wf"))
}

func TestExecutor_TerminateKBWorkflows(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("CancelWorkflow", mock.Anything, "facet-knowledge_base-kbX-embedding", "").
		Return(nil).Once()
	got := ex.TerminateKBWorkflows(context.Background(), "kbX")
	assert.Equal(t, []string{"facet-knowledge_base-kbX-embedding"}, got)
}

func TestExecutor_ResumeExecution_LooksUpAndSignals(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)

	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{
				ProjectId: "p", PipelineId: "pipe",
				ExecutionId: "e", WorkflowId: "wf-1", RunId: "run-1",
			})
		})

	mt.On("SignalWorkflow",
		mock.Anything, "wf-1", "run-1", "hil_resume", mock.Anything,
	).Return(nil).Once()

	require.NoError(t, ex.ResumeExecution("p", "pipe", "e", types.HILResumePayload{}))
}

func TestExecutor_ResumeExecution_ExecutionLookupError(t *testing.T) {
	ex, _, _ := newExecutorWithMockTemporal(t)
	err := ex.ResumeExecution("p", "pipe", "missing", types.HILResumePayload{})
	require.Error(t, err)
}

func TestExecutor_CancelExecution_LooksUpAndCancelsAndUpdates(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)

	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{
				ProjectId: "p", PipelineId: "pipe",
				ExecutionId: "e", WorkflowId: "wf-1", RunId: "run-1",
			})
		})
	stub.handle(http.MethodPut, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})

	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-1").Return(nil).Once()

	require.NoError(t, ex.CancelExecution("p", "pipe", "e"))
}

func TestExecutor_CancelExecution_TemporalError(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{
				ProjectId: "p", PipelineId: "pipe",
				ExecutionId: "e", WorkflowId: "wf-1", RunId: "run-1",
			})
		})
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-1").
		Return(errors.New("nope")).Once()

	require.Error(t, ex.CancelExecution("p", "pipe", "e"))
}

func TestExecutor_StartConnectorTest_UnsupportedTypeErrors(t *testing.T) {
	ex, _, _ := newExecutorWithMockTemporal(t)
	_, err := ex.StartConnectorTest("p", "c", map[string]interface{}{
		"connector_type": "unknown",
		"provider":       "weird",
	}, "cred", "")
	require.Error(t, err)
}

func TestExecutor_StartConnectorTest_HappyPath(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return strings.HasPrefix(o.ID, "connector-test-p-c-")
		}),
		"ConnectorInteractiveWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "connector-test-p-c-1"}, nil).Once()

	id, err := ex.StartConnectorTest("p", "c", map[string]interface{}{
		"connector_type": "objectstore",
		"provider":       "s3",
	}, "cred", "")
	require.NoError(t, err)
	assert.Equal(t, "connector-test-p-c-1", id)
}

func TestExecutor_GenerateRandomString_Length(t *testing.T) {
	for _, n := range []int{0, 1, 9, 16} {
		got := generateRandomString(n)
		assert.Equal(t, n, len(got))
	}
}
