package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func newKeycloakTokenServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/protocol/openid-connect/token", r.URL.Path)
		_, _ = w.Write([]byte(`{"access_token":"test-token","token_type":"Bearer","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDeleteTableFromCatalogActivity_SuccessWithUUID(t *testing.T) {
	tokenSrv := newKeycloakTokenServer(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", tokenSrv.URL)
	t.Setenv("KEYCLOAK_CLIENT_ID", "client")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	var deleteCalled bool
	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete &&
			r.URL.Path == "/catalog/v1/wh-uuid/namespaces/ns/tables/my-table" {
			deleteCalled = true
			require.Equal(t, "true", r.URL.Query().Get("purgeRequested"))
			require.Equal(t, "Bearer test-token", r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(lkSrv.Close)
	t.Setenv("LAKEKEEPER_URL", lkSrv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTableFromCatalogActivity)

	_, err := env.ExecuteActivity(DeleteTableFromCatalogActivity, types.DeleteTableFromCatalogRequest{
		ProjectId: "p1", TableName: "my-table", Namespace: "ns",
		WarehouseId: "wh-uuid",
	})
	require.NoError(t, err)
	assert.True(t, deleteCalled)
}

func TestDeleteTableFromCatalogActivity_LookupWarehouseThenDelete(t *testing.T) {
	tokenSrv := newKeycloakTokenServer(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", tokenSrv.URL)
	t.Setenv("KEYCLOAK_CLIENT_ID", "client")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/management/v1/warehouse":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"warehouses": []map[string]interface{}{
					{"warehouse-name": "p1", "warehouse-id": "resolved-wh"},
				},
			})
		case r.Method == http.MethodDelete &&
			r.URL.Path == "/catalog/v1/resolved-wh/namespaces/a/b/tables/t":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(lkSrv.Close)
	t.Setenv("LAKEKEEPER_URL", lkSrv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTableFromCatalogActivity)

	_, err := env.ExecuteActivity(DeleteTableFromCatalogActivity, types.DeleteTableFromCatalogRequest{
		ProjectId: "p1", TableName: "t", Namespace: "a.b",
	})
	require.NoError(t, err)
}

func TestDeleteTableFromCatalogActivity_TableNotFoundIsOK(t *testing.T) {
	tokenSrv := newKeycloakTokenServer(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", tokenSrv.URL)
	t.Setenv("KEYCLOAK_CLIENT_ID", "client")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(lkSrv.Close)
	t.Setenv("LAKEKEEPER_URL", lkSrv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTableFromCatalogActivity)

	_, err := env.ExecuteActivity(DeleteTableFromCatalogActivity, types.DeleteTableFromCatalogRequest{
		ProjectId: "p1", TableName: "gone", Namespace: "ns", WarehouseId: "wh-1",
	})
	require.NoError(t, err)
}

func TestDeleteTableFromCatalogActivity_WarehouseLookupFailureContinues(t *testing.T) {
	tokenSrv := newKeycloakTokenServer(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", tokenSrv.URL)
	t.Setenv("KEYCLOAK_CLIENT_ID", "client")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	lkSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/management/v1/warehouse" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(lkSrv.Close)
	t.Setenv("LAKEKEEPER_URL", lkSrv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTableFromCatalogActivity)

	_, err := env.ExecuteActivity(DeleteTableFromCatalogActivity, types.DeleteTableFromCatalogRequest{
		ProjectId: "p1", TableName: "t", Namespace: "ns",
	})
	require.NoError(t, err)
}

func TestDeleteDatasetFilesActivity_MissingS3Credentials(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteDatasetFilesActivity)

	_, err := env.ExecuteActivity(DeleteDatasetFilesActivity, types.DeleteDatasetFilesRequest{
		ProjectId: "p1", DataSetId: "d1",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "S3 credentials not configured")
}
