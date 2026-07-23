package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestInvokeAgentActivity_MissingFields(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(InvokeAgentActivity)
	_, err := env.ExecuteActivity(InvokeAgentActivity, map[string]interface{}{"agentId": "a1"})
	require.Error(t, err)
}

func TestInvokeAgentActivity_SyncResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/invoke/async") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"response": `{"answer":42}`,
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
		"agentId": "agent-1", "projectId": "p1", "message": "hello",
	})
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, float64(42), got["answer"])
}

func TestInvokeAgentActivity_AsyncPollCompleted(t *testing.T) {
	pollCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/invoke/async") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"taskId": "task-1"})
			return
		}
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/tasks/task-1") {
			pollCount++
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"status":       "completed",
				"parsedOutput": map[string]interface{}{"done": true},
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
		"agentId": "agent-1", "projectId": "p1", "message": "go", "timeoutSeconds": float64(30),
	})
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, true, got["done"])
	assert.GreaterOrEqual(t, pollCount, 1)
}

func TestInvokeAgentActivity_InvokeError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	agentServiceURL = srv.URL

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(InvokeAgentActivity)
	_, err := env.ExecuteActivity(InvokeAgentActivity, map[string]interface{}{
		"agentId": "a1", "projectId": "p1", "message": "x",
	})
	require.Error(t, err)
}

func TestSendHILNotification_LogChannel(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(SendHILNotification)
	_, err := env.ExecuteActivity(SendHILNotification, map[string]interface{}{
		"executionId": "ex-1",
	})
	require.NoError(t, err)
}

func TestSendHILNotification_SlackChannel(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(SendHILNotification)
	_, err := env.ExecuteActivity(SendHILNotification, map[string]interface{}{
		"channel": "slack", "executionId": "ex-1",
	})
	require.NoError(t, err)
}

func TestPersistExecutionStatus_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PersistExecutionStatus)
	_, err := env.ExecuteActivity(PersistExecutionStatus, map[string]interface{}{
		"executionId": "e1", "pipelineId": "pl1", "projectId": "p1", "status": "running",
	})
	require.NoError(t, err)
}

func TestPersistStepResult_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PersistStepResult)
	_, err := env.ExecuteActivity(PersistStepResult, map[string]interface{}{
		"executionId": "e1", "pipelineId": "pl1", "projectId": "p1", "stepId": "s1",
	})
	require.NoError(t, err)
}

func TestParseAgentResponse_JSONAndMarkdown(t *testing.T) {
	got, err := parseAgentResponse(`{"x":1}`)
	require.NoError(t, err)
	assert.Equal(t, float64(1), got["x"])

	got2, err := parseAgentResponse("```json\n{\"y\":2}\n```")
	require.NoError(t, err)
	assert.Equal(t, float64(2), got2["y"])

	got3, err := parseAgentResponse("plain text")
	require.NoError(t, err)
	assert.Equal(t, "plain text", got3["response"])
}

func TestGetEnvOrDefault_Activity(t *testing.T) {
	t.Setenv("AGENT_SERVICE_URL", "")
	// package-level var already set; test helper directly
	assert.Equal(t, "default", getEnvOrDefault("NONEXISTENT_ENV_XYZ", "default"))
}
