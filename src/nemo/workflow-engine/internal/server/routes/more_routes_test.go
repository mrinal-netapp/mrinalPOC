package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

// --- DatasetImport ---------------------------------------------------------

func TestRoute_DatasetImport_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "dataset-import-p-d" }),
		"DatasetImportWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	body := map[string]interface{}{"datasetName": "ds", "bucketName": "b"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/import", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestRoute_DatasetImport_MissingDatasetName(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{"bucketName": "b"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/import", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_DatasetImport_MissingBucket(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{"datasetName": "ds"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/import", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_DatasetImport_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/import",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Pipeline execute ------------------------------------------------------

func TestRoute_ExecutePipeline_Success(t *testing.T) {
	r, mt, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe", ProjectId: "p"})
	})
	stub.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "PipelineWorkflow", mock.Anything).
		Return(&fakeWorkflowRun{id: "pipeline-pipe-x", runID: "r1"}, nil).Once()

	body := map[string]interface{}{"parameters": map[string]string{"k": "v"}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestRoute_ExecutePipeline_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_ExecutePipeline_ServiceError(t *testing.T) {
	r, _, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions",
		jsonReader(t, map[string]interface{}{"parameters": nil}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- listExecutions / getExecution / cancel / resume ----------------------

func TestRoute_ListExecutions_Success(t *testing.T) {
	r, _, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]*types.PipelineExecution{{ExecutionId: "e"}})
		})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var out []*types.PipelineExecution
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	assert.Len(t, out, 1)
}

func TestRoute_ListExecutions_Error(t *testing.T) {
	r, _, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_GetExecution_NotFound(t *testing.T) {
	r, _, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestRoute_CancelExecution_Success(t *testing.T) {
	r, mt, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{
				ProjectId: "p", PipelineId: "pipe", ExecutionId: "e",
				WorkflowId: "wf-1", RunId: "run-1",
			})
		})
	stub.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-1").Return(nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions/e/cancel", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_CancelExecution_Error(t *testing.T) {
	r, _, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions/e/cancel", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_ResumeExecution_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions/e/resume",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_ResumeExecution_Success(t *testing.T) {
	r, mt, stub := newExecutorRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{
				ProjectId: "p", PipelineId: "pipe", ExecutionId: "e",
				WorkflowId: "wf-1", RunId: "run-1",
			})
		})
	mt.On("SignalWorkflow", mock.Anything, "wf-1", "run-1", "hil_resume", mock.Anything).Return(nil).Once()

	body := map[string]interface{}{"approvedIds": []string{"a"}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions/e/resume",
		jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

// --- Pipeline schedule -----------------------------------------------------

func TestRoute_PipelineSchedule_Create_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/schedule",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_PipelineSchedule_DeleteAndDescribe(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("GetHandle", mock.Anything, "pipeline-p-pipe").Return(sh)
	sh.On("Delete", mock.Anything).Return(nil).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/pipelines/pipe/schedule", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	sh.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/schedule", nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusOK, w2.Code)
}

func TestRoute_PipelineTerminate_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ListWorkflow", mock.Anything, mock.Anything).
		Return(&workflowservice.ListWorkflowExecutionsResponse{
			Executions: []*workflow.WorkflowExecutionInfo{
				{Execution: &commonpb.WorkflowExecution{WorkflowId: "pipeline-p-pipe-1"}},
			},
		}, nil).Once()
	mt.On("CancelWorkflow", mock.Anything, "pipeline-p-pipe-1", "").Return(nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/terminate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

// --- MCP health schedule ---------------------------------------------------

func TestRoute_MCPHealthSchedule_Create(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("Create", mock.Anything, mock.Anything).Return(sh, nil).Once()
	sh.On("GetID").Return("mcp-health-check").Once()

	body := map[string]string{"cron": "*/5 * * * *"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp-health/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestRoute_MCPHealthSchedule_DeleteAndDescribe(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("GetHandle", mock.Anything, "mcp-health-check").Return(sh)
	sh.On("Delete", mock.Anything).Return(nil).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/mcp-health/schedule", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	sh.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/mcp-health/schedule", nil)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)
	require.Equal(t, http.StatusOK, w2.Code)
}

func TestRoute_MCPHealthSchedule_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/mcp-health/schedule",
		bytes.NewBufferString("{not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Reference Edge schedule -----------------------------------------------

func TestRoute_ReferenceEdgeSchedule_Lifecycle(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("Create", mock.Anything, mock.Anything).Return(sh, nil).Once()
	sh.On("GetID").Return("dependency-lineage-sync").Once()

	body := map[string]string{"cron": "*/5 * * * *"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/reference-edges/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	sc.On("GetHandle", mock.Anything, "dependency-lineage-sync").Return(sh)
	sh.On("Delete", mock.Anything).Return(nil).Once()
	dreq := httptest.NewRequest(http.MethodDelete, "/api/v1/reference-edges/schedule", nil)
	dw := httptest.NewRecorder()
	r.ServeHTTP(dw, dreq)
	require.Equal(t, http.StatusOK, dw.Code)

	sh.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()
	greq := httptest.NewRequest(http.MethodGet, "/api/v1/reference-edges/schedule", nil)
	gw := httptest.NewRecorder()
	r.ServeHTTP(gw, greq)
	require.Equal(t, http.StatusOK, gw.Code)
}

// --- KB schedule -----------------------------------------------------------

func TestRoute_KBSchedule_CreateThenDelete(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("Create", mock.Anything, mock.Anything).Return(sh, nil).Once()
	sh.On("GetID").Return("kbsync-p-kb").Once()

	body := map[string]interface{}{"cronExpression": "*/15 * * * *", "timezone": ""}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/schedule",
		jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)

	sc.On("GetHandle", mock.Anything, "kbsync-x").Return(sh)
	sh.On("Delete", mock.Anything).Return(nil).Once()
	delBody := map[string]interface{}{"temporalScheduleId": "kbsync-x"}
	dreq := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/knowledgebases/kb/schedule",
		jsonReader(t, delBody))
	dreq.Header.Set("Content-Type", "application/json")
	dw := httptest.NewRecorder()
	r.ServeHTTP(dw, dreq)
	require.Equal(t, http.StatusOK, dw.Code)
}

func TestRoute_KBSchedule_EnabledFalseTearsDown(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{
		"cronExpression": "0 * * * *",
		"enabled":        false,
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/schedule",
		jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, false, got["enabled"])
}

func TestRoute_KBSchedule_BadJSON(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/schedule",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_KBSchedule_DeleteRequiresId(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/knowledgebases/kb/schedule",
		jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// --- Workflow status (cancel error path already covered; add list smoke) ---

func TestRoute_WorkflowStatus_CancelError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", mock.Anything).
		Return(errors.New("nope")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel",
		jsonReader(t, map[string]string{"runId": "r"}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.NotEqual(t, http.StatusOK, w.Code)
}

// silence unused imports if all tests are skipped/compiled out.
var _ = strings.NewReader
