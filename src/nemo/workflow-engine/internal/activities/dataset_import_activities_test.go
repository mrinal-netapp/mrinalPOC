package activities

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestReadProcessingResultActivity_NoS3Creds(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadProcessingResultActivity)
	_, err := env.ExecuteActivity(ReadProcessingResultActivity, "b", "d1", "")
	require.Error(t, err)
}

func TestReadProcessingResultActivity_Success(t *testing.T) {
	body, _ := json.Marshal(types.ProcessingResult{Status: "success", RowCount: 10})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
			return
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadProcessingResultActivity)
	val, err := env.ExecuteActivity(ReadProcessingResultActivity, "bucket", "d1", "projects/p1")
	require.NoError(t, err)
	var got types.ProcessingResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "success", got.Status)
	assert.Equal(t, 10, got.RowCount)
}

func TestRegisterTableWithCatalogActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/management/v1/warehouse":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"warehouses": []map[string]interface{}{
					{"name": "p1", "id": "wh-1"},
				},
			})
		case r.Method == http.MethodGet && strings.Contains(r.URL.Path, "/namespaces"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"namespaces": []string{"default"}})
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/tables"):
			w.WriteHeader(http.StatusCreated)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("LAKEKEEPER_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RegisterTableWithCatalogActivity)
	val, err := env.ExecuteActivity(RegisterTableWithCatalogActivity, types.RegisterTableRequest{
		ProjectId: "p1", DatasetId: "d1", DatasetName: "ds", Namespace: "default",
	})
	require.NoError(t, err)
	var got types.RegisterTableResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "wh-1", got.WarehouseId)
}

func TestUpdateDatasetCatalogRefActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPut, r.Method)
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateDatasetCatalogRefActivity)
	_, err := env.ExecuteActivity(UpdateDatasetCatalogRefActivity, "p1", "d1", "ns.t1")
	require.NoError(t, err)
}

func TestUpdateDatasetStatsFacetActivity_Ready(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"state":"ready"`)
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateDatasetStatsFacetActivity)
	_, err := env.ExecuteActivity(UpdateDatasetStatsFacetActivity, UpdateDatasetStatsFacetInput{
		ProjectId: "p1", DataSetId: "d1", Status: "success",
		SourceFileCount: 2, RowCount: 10, ColumnCount: 3,
	})
	require.NoError(t, err)
}

func TestUpdateDatasetStatsFacetActivity_Errored(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"state":"errored"`)
		assert.Contains(t, string(body), "boom")
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateDatasetStatsFacetActivity)
	_, err := env.ExecuteActivity(UpdateDatasetStatsFacetActivity, UpdateDatasetStatsFacetInput{
		ProjectId: "p1", DataSetId: "d1", Status: "errored", ErrorMessage: "boom",
	})
	require.NoError(t, err)
}

func TestReadDatasetProgressActivity_NoCreds(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadDatasetProgressActivity)
	_, err := env.ExecuteActivity(ReadDatasetProgressActivity, "b", "d1", "")
	require.Error(t, err)
}

func TestReadDatasetProgressActivity_NotFoundReturnsInitializing(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadDatasetProgressActivity)
	val, err := env.ExecuteActivity(ReadDatasetProgressActivity, "b", "d1", "")
	require.NoError(t, err)
	var got types.DatasetProgressInfo
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "initializing", got.Phase)
}

func TestReadDatasetProgressActivity_Success(t *testing.T) {
	body, _ := json.Marshal(types.DatasetProgressInfo{Phase: "processing", Percentage: 50, Status: "in_progress"})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadDatasetProgressActivity)
	val, err := env.ExecuteActivity(ReadDatasetProgressActivity, "b", "d1", "")
	require.NoError(t, err)
	var got types.DatasetProgressInfo
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "processing", got.Phase)
}

func TestUpdateDatasetProgressActivity_Smoke(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateDatasetProgressActivity)
	_, err := env.ExecuteActivity(UpdateDatasetProgressActivity, "p1", "d1", types.DatasetProgressInfo{
		Phase: "processing", Percentage: 40, ProcessedFiles: 2, TotalFiles: 5,
	})
	require.NoError(t, err)
}

func TestUpdateAcquisitionFacetActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"state":"in_progress"`)
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateAcquisitionFacetActivity)
	_, err := env.ExecuteActivity(UpdateAcquisitionFacetActivity, UpdateAcquisitionFacetInput{
		ProjectID: "p1", DatasetID: "d1", State: "in_progress", JobID: "wf-1",
	})
	require.NoError(t, err)
}

func TestCalculateDatasetProgressPercentage_PhasePercentage(t *testing.T) {
	got := calculateDatasetProgressPercentage(types.DatasetProgressInfo{
		Phase: "processing", Percentage: 50,
	})
	assert.Equal(t, 32, got) // 5 + 55*0.5
}

func TestCalculateDatasetProgressPercentage_FallbackProcessing(t *testing.T) {
	got := calculateDatasetProgressPercentage(types.DatasetProgressInfo{
		Phase: "processing", ProcessedFiles: 1, TotalFiles: 2,
	})
	assert.Equal(t, 32, got)
}
