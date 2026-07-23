package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestGetTableMetadataActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodGet, r.Method)
		require.Equal(t, "/catalog/v1/wh-1/namespaces/ns/tables/my-table", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "my-table", "format": "parquet"})
	}))
	t.Cleanup(srv.Close)

	t.Setenv("LAKEKEEPER_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetTableMetadataActivity)

	val, err := env.ExecuteActivity(GetTableMetadataActivity, "p1", "ns", "my-table", "wh-1")
	require.NoError(t, err)

	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "my-table", got["name"])
}

func TestGetTableMetadataActivity_DefaultsWarehouseToProject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/catalog/v1/p1/namespaces/ns/tables/t", r.URL.Path)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "t"})
	}))
	t.Cleanup(srv.Close)

	t.Setenv("LAKEKEEPER_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetTableMetadataActivity)

	val, err := env.ExecuteActivity(GetTableMetadataActivity, "p1", "ns", "t", "")
	require.NoError(t, err)

	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "t", got["name"])
}

func TestGetTableMetadataActivity_LakekeeperError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("LAKEKEEPER_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetTableMetadataActivity)

	_, err := env.ExecuteActivity(GetTableMetadataActivity, "p1", "ns", "t", "wh")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get table metadata")
}

func TestUpdateDatasetStatusActivity_Success(t *testing.T) {
	var gotStatus, gotError string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		require.Equal(t, "/api/v1/projects/p1/datasets/d1/status", r.URL.Path)

		var body map[string]string
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		gotStatus = body["status"]
		gotError = body["errorMessage"]
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateDatasetStatusActivity)

	_, err := env.ExecuteActivity(UpdateDatasetStatusActivity, "p1", "d1", "ready", "all good")
	require.NoError(t, err)
	assert.Equal(t, "ready", gotStatus)
	assert.Equal(t, "all good", gotError)
}

func TestUpdateDatasetStatusActivity_ConfigServiceError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateDatasetStatusActivity)

	_, err := env.ExecuteActivity(UpdateDatasetStatusActivity, "p1", "d1", "errored", "boom")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to update dataset status")
}
