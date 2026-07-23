package activities

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestPostScanResultActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPatch, r.Method)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	// Disable Keycloak so config-client doesn't try to acquire a token.
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PostScanResultActivity)

	_, err := env.ExecuteActivity(PostScanResultActivity, "p", "ds",
		map[string]interface{}{"state": "completed"},
		map[string]interface{}{"total_files": 10})
	require.NoError(t, err)
}

func TestPostScanResultActivity_ServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PostScanResultActivity)

	_, err := env.ExecuteActivity(PostScanResultActivity, "p", "ds",
		map[string]interface{}{"state": "failed"}, nil)
	require.Error(t, err)
}
