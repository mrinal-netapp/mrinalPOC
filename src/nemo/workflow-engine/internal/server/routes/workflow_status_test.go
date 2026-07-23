package routes

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	failurepb "go.temporal.io/api/failure/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/serviceerror"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
	"go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
)

// --- pure helpers -----------------------------------------------------------

func TestDeriveCategory_KnownPrefixes(t *testing.T) {
	assert.Equal(t, "kb-creation", deriveCategory("kb-creation-p1-kb1"))
	assert.Equal(t, "dataset-import", deriveCategory("dataset-import-p1-d1"))
	assert.Equal(t, "pipeline", deriveCategory("pipeline-p1-pipe-exec"))
	assert.Equal(t, "unknown", deriveCategory("custom-wf-123"))
}

func TestMapWorkflowStatus_AllKnown(t *testing.T) {
	assert.Equal(t, "running", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING))
	assert.Equal(t, "completed", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED))
	assert.Equal(t, "failed", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_FAILED))
	assert.Equal(t, "cancelled", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_CANCELED))
	assert.Equal(t, "terminated", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED))
	assert.Equal(t, "continued_as_new", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW))
	assert.Equal(t, "timed_out", mapWorkflowStatus(enumspb.WORKFLOW_EXECUTION_STATUS_TIMED_OUT))
	assert.Equal(t, "unknown", mapWorkflowStatus(enumspb.WorkflowExecutionStatus(99)))
}

func TestHistoryEventToLogEntry_CommonTypes(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	started := historyEventToLogEntry(&historypb.HistoryEvent{
		EventId: 1, EventTime: &now,
		EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
		Attributes: &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{
			WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
				TaskQueue: &taskqueuepb.TaskQueue{Name: "q1"},
			},
		},
	})
	assert.Contains(t, started.Details, "q1")

	failed := historyEventToLogEntry(&historypb.HistoryEvent{
		EventId: 2, EventTime: &now,
		EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
		Attributes: &historypb.HistoryEvent_WorkflowExecutionFailedEventAttributes{
			WorkflowExecutionFailedEventAttributes: &historypb.WorkflowExecutionFailedEventAttributes{
				Failure: &failurepb.Failure{Message: "boom"},
			},
		},
	})
	assert.Contains(t, failed.Details, "boom")

	scheduled := historyEventToLogEntry(&historypb.HistoryEvent{
		EventId: 3, EventTime: &now,
		EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
		Attributes: &historypb.HistoryEvent_ActivityTaskScheduledEventAttributes{
			ActivityTaskScheduledEventAttributes: &historypb.ActivityTaskScheduledEventAttributes{
				ActivityType: &commonpb.ActivityType{Name: "FetchCreds"},
			},
		},
	})
	assert.Contains(t, scheduled.Details, "FetchCreds")

	dur := 5 * time.Second
	timer := historyEventToLogEntry(&historypb.HistoryEvent{
		EventId: 4, EventTime: &now,
		EventType: enumspb.EVENT_TYPE_TIMER_STARTED,
		Attributes: &historypb.HistoryEvent_TimerStartedEventAttributes{
			TimerStartedEventAttributes: &historypb.TimerStartedEventAttributes{
				StartToFireTimeout: &dur,
			},
		},
	})
	assert.Contains(t, timer.Details, "5s")
}

// --- fake history iterator --------------------------------------------------

type fakeHistoryIter struct {
	events       []*historypb.HistoryEvent
	idx          int
	nextErr      error
	forceHasNext bool
}

func (f *fakeHistoryIter) HasNext() bool {
	if f.forceHasNext {
		return true
	}
	return f.idx < len(f.events)
}

func (f *fakeHistoryIter) Next() (*historypb.HistoryEvent, error) {
	if f.nextErr != nil {
		err := f.nextErr
		f.nextErr = nil
		f.forceHasNext = false
		return nil, err
	}
	if f.idx >= len(f.events) {
		return nil, errors.New("no more events")
	}
	e := f.events[f.idx]
	f.idx++
	return e, nil
}

type fakeEncodedValue struct {
	val interface{}
	err error
}

func (f *fakeEncodedValue) Get(valuePtr interface{}) error {
	if f.err != nil {
		return f.err
	}
	if f.val != nil && valuePtr != nil {
		b, err := json.Marshal(f.val)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, valuePtr)
	}
	return nil
}

func (f *fakeEncodedValue) HasValue() bool { return f.val != nil || f.err != nil }

func encodeQueryResult(t *testing.T, v interface{}) converter.EncodedValue {
	t.Helper()
	return &fakeEncodedValue{val: v}
}

func describeResponse(workflowID string, status enumspb.WorkflowExecutionStatus) *workflowservice.DescribeWorkflowExecutionResponse {
	start := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	close := time.Date(2026, 1, 1, 12, 5, 0, 0, time.UTC)
	return &workflowservice.DescribeWorkflowExecutionResponse{
		WorkflowExecutionInfo: &workflow.WorkflowExecutionInfo{
			Execution:     &commonpb.WorkflowExecution{WorkflowId: workflowID, RunId: "run-1"},
			Type:          &commonpb.WorkflowType{Name: "DatasetImportWorkflow"},
			Status:        status,
			TaskQueue:     "dataset-processing",
			HistoryLength: 42,
			StartTime:     ptrTime(start),
			CloseTime:     ptrTime(close),
		},
	}
}

// --- route integration ------------------------------------------------------

func TestRoute_WorkflowStart_Validation(t *testing.T) {
	r, _, _ := newExecutorRouter(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)

	body := map[string]interface{}{"workflowName": "Wf"}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_WorkflowStart_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "wf-1" && o.TaskQueue == "q1"
		}),
		"MyWorkflow", mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "run-new"}, nil).Once()

	body := map[string]interface{}{
		"workflowName": "MyWorkflow", "workflowId": "wf-1", "taskQueue": "q1", "args": []interface{}{},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got startWorkflowResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "wf-1", got.WorkflowID)
	assert.Equal(t, "run-new", got.RunID)
}

func TestRoute_WorkflowStart_AlreadyStartedReturnsExistingRun(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, serviceerror.NewWorkflowExecutionAlreadyStarted("dup", "wf-1", "run-existing")).Once()

	body := map[string]interface{}{
		"workflowName": "MyWorkflow", "workflowId": "wf-1", "taskQueue": "q1",
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got startWorkflowResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "run-existing", got.RunID)
}

func TestRoute_WorkflowQuery_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("QueryWorkflow", mock.Anything, "wf-1", "", "state", mock.Anything).
		Return(encodeQueryResult(t, map[string]string{"phase": "running"}), nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/query/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got map[string]string
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "running", got["phase"])
}

func TestRoute_WorkflowQuery_NotFound(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("QueryWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, serviceerror.NewNotFound("missing")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-missing/query/state", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestRoute_WorkflowStatus_Completed(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("DescribeWorkflowExecution", mock.Anything, "dataset-import-p-d", "").
		Return(describeResponse("dataset-import-p-d", enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED), nil).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/dataset-import-p-d/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got WorkflowStatusResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "completed", got.Status)
	assert.Equal(t, "dataset-import", got.WorkflowCategory)
	assert.False(t, got.IsRunning)
	require.NotNil(t, got.StartTime)
	require.NotNil(t, got.ExecutionDuration)
}

func TestRoute_WorkflowStatus_FailedIncludesFailureMessage(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("DescribeWorkflowExecution", mock.Anything, "wf-fail", "").
		Return(describeResponse("wf-fail", enumspb.WORKFLOW_EXECUTION_STATUS_FAILED), nil).Once()
	failTime := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	mt.On("GetWorkflowHistory", mock.Anything, "wf-fail", "", false, mock.Anything).
		Return(&fakeHistoryIter{events: []*historypb.HistoryEvent{
			{
				EventId: 1, EventTime: &failTime,
				EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED,
				Attributes: &historypb.HistoryEvent_WorkflowExecutionFailedEventAttributes{
					WorkflowExecutionFailedEventAttributes: &historypb.WorkflowExecutionFailedEventAttributes{
						Failure: &failurepb.Failure{Message: "root cause"},
					},
				},
			},
		}}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-fail/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got WorkflowStatusResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "failed", got.Status)
	assert.Equal(t, "root cause", got.FailureMessage)
}

func TestRoute_WorkflowStatus_NotFound(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("DescribeWorkflowExecution", mock.Anything, "wf-x", "").
		Return(nil, errors.New("workflow not found")).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-x/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestRoute_WorkflowResult_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("GetWorkflow", mock.Anything, "wf-1", "").
		Return(&fakeWorkflowRun{getOut: map[string]interface{}{"status": "completed"}}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/result", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_WorkflowResult_StillRunning(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("GetWorkflow", mock.Anything, "wf-1", "").
		Return(&fakeWorkflowRun{getErr: errors.New("workflow is still running")}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/result", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusConflict, w.Code)
}

func TestRoute_WorkflowCancel_IdempotentAlreadyCompleted(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "").
		Return(errors.New("workflow already completed")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_WorkflowSignal_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("SignalWorkflow", mock.Anything, "wf-1", "", "stop", map[string]interface{}{"grace": float64(30)}).
		Return(nil).Once()

	body := map[string]interface{}{"payload": map[string]interface{}{"grace": 30}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/signal/stop", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestRoute_WorkflowSignal_NotFound(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("SignalWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(errors.New("NotFound: workflow missing")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-x/signal/stop", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestRoute_WorkflowLogs_WithFilters(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	ts := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	events := []*historypb.HistoryEvent{
		{
			EventId: 1, EventTime: &ts,
			EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
			Attributes: &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{
				WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
					TaskQueue: &taskqueuepb.TaskQueue{Name: "q"},
				},
			},
		},
		{
			EventId: 2, EventTime: ptrTime(ts.Add(time.Minute)),
			EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
		},
	}
	mt.On("GetWorkflowHistory", mock.Anything, "wf-1", "", false, mock.Anything).
		Return(&fakeHistoryIter{events: events}).Once()

	req := httptest.NewRequest(http.MethodGet,
		"/api/v1/workflows/wf-1/logs?search=activity&tail=1&since=2026-01-01T12:00:30Z", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got WorkflowLogsResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.Equal(t, "wf-1", got.WorkflowId)
	assert.Equal(t, 1, got.Total)
}

func TestRoute_WorkflowLogs_NotFound(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("GetWorkflowHistory", mock.Anything, "wf-x", "", false, mock.Anything).
		Return(&fakeHistoryIter{forceHasNext: true, nextErr: errors.New("workflow not found")}).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-x/logs", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func ptrTime(t time.Time) *time.Time { return &t }
