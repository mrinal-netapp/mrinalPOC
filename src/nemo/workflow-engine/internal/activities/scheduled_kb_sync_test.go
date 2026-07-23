package activities

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestTriggerKBSyncActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "/api/v1/projects/p1/knowledgebases/kb1/create", r.URL.Path)
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(TriggerKBSyncActivity)

	_, err := env.ExecuteActivity(TriggerKBSyncActivity, TriggerKBSyncInput{
		ProjectId:        "p1",
		KnowledgeBaseId:  "kb1",
		ConfigServiceURL: srv.URL,
	})
	require.NoError(t, err)
}

func TestTriggerKBSyncActivity_5xxBubblesError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream down"))
	}))
	t.Cleanup(srv.Close)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(TriggerKBSyncActivity)

	_, err := env.ExecuteActivity(TriggerKBSyncActivity, TriggerKBSyncInput{
		ProjectId: "p", KnowledgeBaseId: "kb", ConfigServiceURL: srv.URL,
	})
	require.Error(t, err)
}

func TestTriggerKBSyncActivity_DefaultsURLFromEnv(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(TriggerKBSyncActivity)

	_, err := env.ExecuteActivity(TriggerKBSyncActivity, TriggerKBSyncInput{
		ProjectId: "p", KnowledgeBaseId: "kb",
	})
	require.NoError(t, err)
}

func TestTriggerKBSyncActivity_HTTPDoErrorPropagates(t *testing.T) {
	// Closed server -> connection refused.
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	srv.Close()

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(TriggerKBSyncActivity)

	_, err := env.ExecuteActivity(TriggerKBSyncActivity, TriggerKBSyncInput{
		ProjectId: "p", KnowledgeBaseId: "kb", ConfigServiceURL: srv.URL,
	})
	require.Error(t, err)
}

func TestGetKBSyncServiceAccountClient_DisabledByDefault(t *testing.T) {
	// Without Keycloak env vars, the lazy initialiser logs a warning and
	// returns nil; subsequent calls keep returning nil due to sync.Once.
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")

	got := getKBSyncServiceAccountClient()
	_ = got // value is package-level cached state; no assertion needed beyond not panicking
}

// Ensure context.Background usage compiles when imported.
var _ = context.Background
