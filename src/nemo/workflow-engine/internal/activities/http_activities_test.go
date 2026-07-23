package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestRunReferenceEdgeReconcileActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/api/v1/internal/reference-edges/reconcile", r.URL.Path)
		_ = json.NewEncoder(w).Encode(types.ReferenceEdgeReconcileResult{
			Scanned: 5, Added: 1, Removed: 0,
		})
	}))
	t.Cleanup(srv.Close)

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunReferenceEdgeReconcileActivity)

	val, err := env.ExecuteActivity(RunReferenceEdgeReconcileActivity,
		types.ReferenceEdgeReconcileInput{
			ConfigServiceURL: srv.URL, ProjectID: "p", SourceType: "pipeline", GraphOnly: true, MaxRows: 100,
		})
	require.NoError(t, err)
	var got types.ReferenceEdgeReconcileResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, 5, got.Scanned)
}

func TestRunReferenceEdgeReconcileActivity_NotOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	t.Cleanup(srv.Close)

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunReferenceEdgeReconcileActivity)

	_, err := env.ExecuteActivity(RunReferenceEdgeReconcileActivity,
		types.ReferenceEdgeReconcileInput{ConfigServiceURL: srv.URL})
	require.Error(t, err)
}

func TestRunReferenceEdgeReconcileActivity_BadJSONResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunReferenceEdgeReconcileActivity)

	_, err := env.ExecuteActivity(RunReferenceEdgeReconcileActivity,
		types.ReferenceEdgeReconcileInput{ConfigServiceURL: srv.URL})
	require.Error(t, err)
}

func TestRunMCPHealthCheckActivity_NoServers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.True(t, strings.HasPrefix(r.URL.Path, "/api/v1/internal/mcp-servers/health-eligible"))
		_ = json.NewEncoder(w).Encode([]types.MCPServerHealthInfo{})
	}))
	t.Cleanup(srv.Close)

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunMCPHealthCheckActivity)

	val, err := env.ExecuteActivity(RunMCPHealthCheckActivity,
		types.MCPHealthCheckInput{ConfigServiceURL: srv.URL})
	require.NoError(t, err)
	var got types.MCPHealthCheckResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, 0, got.Checked)
}

func TestRunMCPHealthCheckActivity_HealthyAndUnhealthy(t *testing.T) {
	// Stand up a fake config-service that returns 2 servers and a fake LLM
	// proxy gateway (Bifrost) that reports one client as healthy ("connected")
	// and the other as unhealthy ("error") via GET /api/mcp/clients.
	configSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/health-eligible"):
			_ = json.NewEncoder(w).Encode([]types.MCPServerHealthInfo{
				{ID: "a", LLMProxyGatewayServerName: "alpha"},
				{ID: "b", LLMProxyGatewayServerName: "beta"},
			})
		case strings.Contains(r.URL.Path, "/status"):
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(configSrv.Close)

	// probeMCPServer now hits the aggregated GET /api/mcp/clients endpoint
	// once and decides health per-server from each entry's `state`. The
	// activity calls this URL once per server, so the same response is
	// returned to both probe calls.
	gatewaySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/api/mcp/clients") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"name": "alpha", "state": "connected"},
			{"name": "beta",  "state": "error"}
		]`))
	}))
	t.Cleanup(gatewaySrv.Close)

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("LLM_GATEWAY_URL", gatewaySrv.URL)
	t.Setenv("LLM_GATEWAY_API_KEY", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunMCPHealthCheckActivity)

	val, err := env.ExecuteActivity(RunMCPHealthCheckActivity,
		types.MCPHealthCheckInput{ConfigServiceURL: configSrv.URL})
	require.NoError(t, err)
	var got types.MCPHealthCheckResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, 2, got.Checked)
	assert.Equal(t, 1, got.Healthy)
	assert.Equal(t, 1, got.Unhealthy)
}

func TestRunMCPHealthCheckActivity_ListError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunMCPHealthCheckActivity)

	_, err := env.ExecuteActivity(RunMCPHealthCheckActivity,
		types.MCPHealthCheckInput{ConfigServiceURL: srv.URL})
	require.Error(t, err)
}
