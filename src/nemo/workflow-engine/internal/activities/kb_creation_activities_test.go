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

func TestReadKBMetadataActivity_NoCreds(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadKBMetadataActivity)
	_, err := env.ExecuteActivity(ReadKBMetadataActivity, "b", "kb1", "")
	require.Error(t, err)
}

func TestReadKBMetadataActivity_Success(t *testing.T) {
	body, _ := json.Marshal(types.KBMetadata{
		Status: "ready", DocumentCount: 3, ChunkCount: 10, VectorCount: 10,
	})
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
	env.RegisterActivity(ReadKBMetadataActivity)
	val, err := env.ExecuteActivity(ReadKBMetadataActivity, "b", "kb1", "projects/p1")
	require.NoError(t, err)
	var got types.KBMetadata
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "ready", got.Status)
	assert.Equal(t, 3, got.DocumentCount)
}

func TestUpdateKBStatusActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(UpdateKBStatusActivity)
	_, err := env.ExecuteActivity(UpdateKBStatusActivity, "p1", "kb1", "ready", "s3://b/path", "")
	require.NoError(t, err)
}

func TestUpdateKBStatusWithStatsActivity_FullPayload(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s := string(body)
		if strings.Contains(s, `"embeddingModel"`) {
			assert.Contains(t, s, `"chunkSize":512`)
		}
		w.WriteHeader(http.StatusOK)
	})
	env.RegisterActivity(UpdateKBStatusWithStatsActivity)
	_, err := env.ExecuteActivity(UpdateKBStatusWithStatsActivity, UpdateKBStatusInput{
		ProjectId: "p1", KbId: "kb1", Status: "ready",
		DocumentCount: 1, ChunkCount: 2, VectorCount: 2,
		EmbeddingModel: "text-embedding", ChunkSize: 512,
		ChunkOptions: `{"overlap":50}`, QuantizationOptions: `{"bits":8}`,
		Stats: &types.KBStats{StorageBytes: 100, StorageMB: 0.1, FileCount: 1},
	})
	require.NoError(t, err)
}

func TestUpdateKBProgressActivity_Smoke(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateKBProgressActivity)
	_, err := env.ExecuteActivity(UpdateKBProgressActivity, "p1", "kb1", types.KBProgressInfo{
		Phase: "processing_documents", Percentage: 25, TotalDocuments: 4, DocumentsProcessed: 1,
	})
	require.NoError(t, err)
}

func TestReadKBProgressActivity_NoCredsReturnsInitializing(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadKBProgressActivity)
	val, err := env.ExecuteActivity(ReadKBProgressActivity, "b", "kb1", "")
	require.NoError(t, err)
	var got types.KBProgressInfo
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "initializing", got.Phase)
}

func TestClearStaleProgressActivity_Smoke(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ClearStaleProgressActivity)
	_, err := env.ExecuteActivity(ClearStaleProgressActivity, "b", "kb1", "")
	require.NoError(t, err)
}

func TestPostWorkflowProgressActivity_Smoke(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PostWorkflowProgressActivity)
	_, err := env.ExecuteActivity(PostWorkflowProgressActivity, PostWorkflowProgressInput{
		Phase: "running", Percentage: 10,
	})
	require.NoError(t, err)
}

func TestCalculateProgressPercentage_WithPhasePct(t *testing.T) {
	got := calculateProgressPercentage(types.KBProgressInfo{
		Phase: "generating_and_writing", Percentage: 50,
	})
	assert.Equal(t, 57, got) // 20 + 75*0.5
}

func TestCalculateProgressPercentage_Fallback(t *testing.T) {
	got := calculateProgressPercentage(types.KBProgressInfo{Phase: "listing_files"})
	assert.Equal(t, 1, got)
}
