package routes

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func TestRoute_WorkflowCancel_WithRunId(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-specific").
		Return(nil).Once()

	body := map[string]interface{}{"runId": "run-specific"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_WorkflowCancel_AlreadyCancelled(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "").
		Return(errors.New("workflow already canceled")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_WorkflowStatus_GenericDescribeError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("DescribeWorkflowExecution", mock.Anything, "wf-1", "").
		Return(nil, errors.New("internal temporal error")).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_WorkflowLogs_GenericHistoryError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("GetWorkflowHistory", mock.Anything, "wf-1", "", false, mock.Anything).
		Return(&fakeHistoryIter{forceHasNext: true, nextErr: errors.New("history unavailable")}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/logs", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}
