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

func TestCheckBucketStatusActivity_NotReady(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckBucketStatusActivity)
	val, err := env.ExecuteActivity(CheckBucketStatusActivity, "missing-bucket")
	require.NoError(t, err)
	var got types.BucketStatusResult
	require.NoError(t, val.Get(&got))
	assert.False(t, got.Ready)
}

func TestRegisterWarehouseActivity_ConflictLookup(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		case r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"warehouses": []map[string]interface{}{
					{"warehouse-name": "wh", "warehouse-id": "wh-existing"},
				},
			})
		}
	})
	env.RegisterActivity(RegisterWarehouseActivity)
	val, err := env.ExecuteActivity(RegisterWarehouseActivity, types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	var id string
	require.NoError(t, val.Get(&id))
	assert.Equal(t, "wh-existing", id)
}

func TestCreateNamespaceActivity_Error(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	env.RegisterActivity(CreateNamespaceActivity)
	_, err := env.ExecuteActivity(CreateNamespaceActivity, types.CreateNamespaceRequest{
		WarehouseId: "wh-1", Namespace: []string{"ns"},
	})
	require.Error(t, err)
}

func TestLookupWarehouseActivity_NotFound(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"warehouses": []interface{}{}})
	})
	env.RegisterActivity(LookupWarehouseActivity)
	val, err := env.ExecuteActivity(LookupWarehouseActivity, types.LookupWarehouseRequest{WarehouseName: "missing"})
	require.NoError(t, err)
	var got types.LookupWarehouseResult
	require.NoError(t, val.Get(&got))
	assert.False(t, got.Found)
}

func TestDeleteBucketFromConfigActivity_Error(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteBucketFromConfigActivity)
	_, err := env.ExecuteActivity(DeleteBucketFromConfigActivity, types.DeleteBucketRequest{
		ProjectId: "p1", BucketName: "b1",
	})
	require.Error(t, err)
}

func TestUpdateProjectMetadataActivity_Error(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	env.RegisterActivity(UpdateProjectMetadataActivity)
	_, err := env.ExecuteActivity(UpdateProjectMetadataActivity, "p1", "wh-1")
	require.Error(t, err)
}
