package activities

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func configActivityEnv(t *testing.T, handler http.HandlerFunc) *testsuite.TestActivityEnvironment {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	return env
}

func lakekeeperActivityEnv(t *testing.T, handler http.HandlerFunc) *testsuite.TestActivityEnvironment {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	t.Setenv("LAKEKEEPER_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	return env
}

func TestCreateBucketActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/buckets") {
			w.WriteHeader(http.StatusCreated)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateBucketActivity)

	_, err := env.ExecuteActivity(CreateBucketActivity, types.CreateBucketRequest{Name: "proj-1"})
	require.NoError(t, err)
}

func TestCreateBucketActivity_ConfigError(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	env.RegisterActivity(CreateBucketActivity)
	_, err := env.ExecuteActivity(CreateBucketActivity, types.CreateBucketRequest{Name: "proj-1"})
	require.Error(t, err)
}

func TestSetupProjectLLMGatewayActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Contains(t, r.URL.Path, "/gateway-setup")
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(SetupProjectLLMGatewayActivity)
	_, err := env.ExecuteActivity(SetupProjectLLMGatewayActivity, "proj-1")
	require.NoError(t, err)
}

func TestSetupProjectLLMGatewayActivity_Error(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	env.RegisterActivity(SetupProjectLLMGatewayActivity)
	_, err := env.ExecuteActivity(SetupProjectLLMGatewayActivity, "proj-1")
	require.Error(t, err)
}

func TestTeardownProjectLLMGatewayActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/gateway-teardown")
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(TeardownProjectLLMGatewayActivity)
	_, err := env.ExecuteActivity(TeardownProjectLLMGatewayActivity, types.TeardownProjectLLMGatewayInput{
		ProjectId: "proj-1",
		Gateway:   &types.ProjectGatewayMeta{TeamId: "t1", VirtualKeyId: "vk1"},
	})
	require.NoError(t, err)
}

func TestCreateProjectServiceAccountActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/service-account")
		w.WriteHeader(http.StatusCreated)
	})
	env.RegisterActivity(CreateProjectServiceAccountActivity)
	_, err := env.ExecuteActivity(CreateProjectServiceAccountActivity, "proj-1")
	require.NoError(t, err)
}

func TestReportProjectInitStatusActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"status":"ready"`)
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(ReportProjectInitStatusActivity)
	_, err := env.ExecuteActivity(ReportProjectInitStatusActivity, types.ReportProjectInitStatusInput{
		ProjectId: "proj-1", Status: "ready",
	})
	require.NoError(t, err)
}

func TestUpdateProjectMetadataActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateProjectMetadataActivity)
	_, err := env.ExecuteActivity(UpdateProjectMetadataActivity, "proj-1", "wh-uuid")
	require.NoError(t, err)
}

func TestDeleteBucketActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodDelete, r.Method)
		w.WriteHeader(http.StatusNoContent)
	})
	env.RegisterActivity(DeleteBucketActivity)
	_, err := env.ExecuteActivity(DeleteBucketActivity, types.DeleteBucketRequest{
		ProjectId: "proj-1", BucketName: "proj-1",
	})
	require.NoError(t, err)
}

func TestDeleteBucketFromConfigActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	env.RegisterActivity(DeleteBucketFromConfigActivity)
	_, err := env.ExecuteActivity(DeleteBucketFromConfigActivity, types.DeleteBucketRequest{
		ProjectId: "proj-1", BucketName: "proj-1",
	})
	require.NoError(t, err)
}

func TestRegisterWarehouseActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/warehouse") {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]string{"warehouse-id": "wh-new"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(RegisterWarehouseActivity)
	val, err := env.ExecuteActivity(RegisterWarehouseActivity, types.RegisterWarehouseRequest{WarehouseName: "proj-1"})
	require.NoError(t, err)
	var whID string
	require.NoError(t, val.Get(&whID))
	assert.Equal(t, "wh-new", whID)
}

func TestCreateNamespaceActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(CreateNamespaceActivity)
	_, err := env.ExecuteActivity(CreateNamespaceActivity, types.CreateNamespaceRequest{
		WarehouseId: "wh-1", Namespace: []string{"default"},
	})
	require.NoError(t, err)
}

func TestUnregisterWarehouseActivity_WithProvidedID(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(UnregisterWarehouseActivity)
	_, err := env.ExecuteActivity(UnregisterWarehouseActivity, types.UnregisterWarehouseRequest{
		WarehouseName: "proj-1", WarehouseId: "wh-1",
	})
	require.NoError(t, err)
}

func TestUnregisterWarehouseActivity_LookupFailsIdempotent(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(UnregisterWarehouseActivity)
	_, err := env.ExecuteActivity(UnregisterWarehouseActivity, types.UnregisterWarehouseRequest{
		WarehouseName: "missing",
	})
	require.NoError(t, err)
}

func TestLookupWarehouseActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/management/v1/warehouse" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"warehouses": []map[string]interface{}{
					{"name": "proj-1", "id": "wh-found"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(LookupWarehouseActivity)
	val, err := env.ExecuteActivity(LookupWarehouseActivity, types.LookupWarehouseRequest{WarehouseName: "proj-1"})
	require.NoError(t, err)
	var result types.LookupWarehouseResult
	require.NoError(t, val.Get(&result))
	assert.Equal(t, "wh-found", result.WarehouseId)
}

func TestListNamespacesActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/namespaces") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"namespaces": [][]string{{"default"}, {"staging"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(ListNamespacesActivity)
	val, err := env.ExecuteActivity(ListNamespacesActivity, types.ListNamespacesRequest{WarehouseId: "wh-1"})
	require.NoError(t, err)
	var result types.ListNamespacesResult
	require.NoError(t, val.Get(&result))
	assert.Len(t, result.Namespaces, 2)
}

func TestDeleteNamespaceActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(DeleteNamespaceActivity)
	_, err := env.ExecuteActivity(DeleteNamespaceActivity, types.DeleteNamespaceRequest{
		WarehouseId: "wh-1", Namespace: "tmp",
	})
	require.NoError(t, err)
}

func TestListTablesInWarehouseActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/tables") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"identifiers": []map[string]interface{}{
					{"namespace": []string{"default"}, "name": "t1"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(ListTablesInWarehouseActivity)
	val, err := env.ExecuteActivity(ListTablesInWarehouseActivity, types.ListTablesInWarehouseRequest{
		WarehouseId: "wh-1", Namespace: "default",
	})
	require.NoError(t, err)
	var result types.ListTablesResult
	require.NoError(t, val.Get(&result))
	assert.Len(t, result.Tables, 1)
}

func TestDeleteTableFromCatalogByNameActivity_Success(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(DeleteTableFromCatalogByNameActivity)
	_, err := env.ExecuteActivity(DeleteTableFromCatalogByNameActivity, "wh-1", "default", "t1")
	require.NoError(t, err)
}

func TestWaitForBucketReadyActivity_MissingCredentials(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForBucketReadyActivity)
	_, err := env.ExecuteActivity(WaitForBucketReadyActivity, "p1", "bucket-1", 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "S3 credentials not configured")
}

func TestCheckBucketStatusActivity_MissingCredentials(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckBucketStatusActivity)
	_, err := env.ExecuteActivity(CheckBucketStatusActivity, "bucket-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "S3 credentials not configured")
}

func TestHostHeaderTransport_RoundTrip(t *testing.T) {
	inner := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "custom-host", r.Host)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(inner.Close)

	baseURL, err := url.Parse(inner.URL)
	require.NoError(t, err)
	transport := &hostHeaderTransport{
		host:    "custom-host",
		base:    http.DefaultTransport,
		baseURL: baseURL,
	}
	req, err := http.NewRequest(http.MethodGet, inner.URL, nil)
	require.NoError(t, err)
	resp, err := transport.RoundTrip(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())
}
