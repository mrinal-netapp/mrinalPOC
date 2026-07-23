package activities

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestWaitForBucketReadyActivity_Timeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForBucketReadyActivity)
	_, err := env.ExecuteActivity(WaitForBucketReadyActivity, "p1", "slow-bucket", 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "timeout")
}

func TestListTablesInWarehouseActivity_Error(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	env.RegisterActivity(ListTablesInWarehouseActivity)
	_, err := env.ExecuteActivity(ListTablesInWarehouseActivity, types.ListTablesInWarehouseRequest{
		WarehouseId: "wh-1", Namespace: "ns",
	})
	require.Error(t, err)
}

func TestListNamespacesActivity_Error(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	env.RegisterActivity(ListNamespacesActivity)
	_, err := env.ExecuteActivity(ListNamespacesActivity, types.ListNamespacesRequest{WarehouseId: "wh-1"})
	require.Error(t, err)
}

func TestLookupWarehouseActivity_FoundExtended(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"warehouses":[{"warehouse-name":"wh","warehouse-id":"wh-99"}]}`))
	})
	env.RegisterActivity(LookupWarehouseActivity)
	val, err := env.ExecuteActivity(LookupWarehouseActivity, types.LookupWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	var got types.LookupWarehouseResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Found)
	assert.Equal(t, "wh-99", got.WarehouseId)
}
