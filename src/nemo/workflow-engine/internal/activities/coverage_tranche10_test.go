package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestInvokeAgentActivity_AsyncTaskFailed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/invoke/async") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"taskId": "task-fail"})
			return
		}
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/tasks/task-fail") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "failed", "error": "model error",
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	agentServiceURL = srv.URL

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(InvokeAgentActivity)
	_, err := env.ExecuteActivity(InvokeAgentActivity, map[string]interface{}{
		"agentId": "a1", "projectId": "p1", "message": "go", "timeoutSeconds": float64(30),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "agent task failed")
}

func TestInvokeAgentActivity_AsyncPollUsesResponseString(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/invoke/async") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"taskId": "task-2"})
			return
		}
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/tasks/task-2") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status": "completed", "response": `{"ok":true}`,
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	agentServiceURL = srv.URL

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(InvokeAgentActivity)
	val, err := env.ExecuteActivity(InvokeAgentActivity, map[string]interface{}{
		"agentId": "a1", "projectId": "p1", "message": "go", "timeoutSeconds": float64(30),
	})
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	require.Equal(t, true, got["ok"])
}

func TestPersistExecutionStatus_ConnectionErrorIsNonFatal(t *testing.T) {
	t.Setenv("CONFIG_SERVICE_URL", "http://127.0.0.1:1")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PersistExecutionStatus)
	_, err := env.ExecuteActivity(PersistExecutionStatus, map[string]interface{}{
		"executionId": "e1", "pipelineId": "pl1", "projectId": "p1",
	})
	require.NoError(t, err)
}

func TestPersistStepResult_ConnectionErrorIsNonFatal(t *testing.T) {
	t.Setenv("CONFIG_SERVICE_URL", "http://127.0.0.1:1")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PersistStepResult)
	_, err := env.ExecuteActivity(PersistStepResult, map[string]interface{}{
		"executionId": "e1", "pipelineId": "pl1", "projectId": "p1", "stepId": "s1",
	})
	require.NoError(t, err)
}
