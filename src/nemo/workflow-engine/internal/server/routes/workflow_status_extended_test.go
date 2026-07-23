package routes

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
)

func TestRoute_WorkflowStart_MissingWorkflowName(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{"workflowId": "wf-1", "taskQueue": "q1"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_WorkflowStart_MissingWorkflowId(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{"workflowName": "Wf", "taskQueue": "q1"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_WorkflowStart_MissingTaskQueue(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	body := map[string]interface{}{"workflowName": "Wf", "workflowId": "wf-1"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_WorkflowStart_GenericError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()

	body := map[string]interface{}{
		"workflowName": "Wf", "workflowId": "wf-1", "taskQueue": "q1",
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_WorkflowQuery_DecodeError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("QueryWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeEncodedValue{err: errors.New("decode failed")}, nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/query/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadGateway, w.Code)
}

func TestRoute_WorkflowQuery_GenericError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("QueryWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("query failed")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/query/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadGateway, w.Code)
}

func TestRoute_WorkflowResult_GenericError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("GetWorkflow", mock.Anything, "wf-1", "").
		Return(&fakeWorkflowRun{getErr: errors.New("something else")}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/result", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_WorkflowCancel_GenericError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "").
		Return(errors.New("cancel failed")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_WorkflowSignal_GenericError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("SignalWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(errors.New("signal failed")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/signal/stop",
		bytes.NewBufferString(`{"payload":{}}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_WorkflowStart_WithArgs(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "wf-args" }),
		"MyWorkflow",
		mock.MatchedBy(func(arg map[string]interface{}) bool { return arg["k"] == "v" }),
	).Return(&fakeWorkflowRun{id: "wf-args", runID: "run-1"}, nil).Once()

	body := map[string]interface{}{
		"workflowName": "MyWorkflow", "workflowId": "wf-args", "taskQueue": "q1",
		"args": []interface{}{map[string]interface{}{"k": "v"}},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}
