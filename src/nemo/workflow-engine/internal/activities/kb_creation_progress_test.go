package activities

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestCalculateProgressPercentage_AllPhases(t *testing.T) {
	cases := []struct {
		name string
		in   types.KBProgressInfo
		want int
	}{
		{"initializing", types.KBProgressInfo{Phase: "initializing"}, 0},
		{"listing_files", types.KBProgressInfo{Phase: "listing_files"}, 1},
		{"connecting", types.KBProgressInfo{Phase: "connecting"}, 5},
		{"processing_docs_ratio", types.KBProgressInfo{
			Phase: "processing_documents", DocumentsProcessed: 5, TotalDocuments: 10,
		}, 12},
		{"processing_docs_files", types.KBProgressInfo{
			Phase: "processing_documents", TotalFiles: 10, ChunksCreated: 4,
		}, 5},
		{"processing_docs_default", types.KBProgressInfo{Phase: "processing_documents"}, 25},
		{"processing_complete", types.KBProgressInfo{Phase: "processing_complete"}, 20},
		{"generating_and_writing_pct", types.KBProgressInfo{
			Phase: "generating_and_writing", Percentage: 50,
		}, 57},
		{"generating_embeddings_pct", types.KBProgressInfo{
			Phase: "generating_embeddings", Percentage: 100,
		}, 80},
		{"writing_lancedb_pct", types.KBProgressInfo{
			Phase: "writing_lancedb", Percentage: 50,
		}, 87},
		{"generating_and_writing_fallback", types.KBProgressInfo{Phase: "generating_and_writing"}, 45},
		{"embeddings_generated", types.KBProgressInfo{Phase: "embeddings_generated"}, 80},
		{"writing_lancedb", types.KBProgressInfo{Phase: "writing_lancedb"}, 85},
		{"uploading_to_s3", types.KBProgressInfo{Phase: "uploading_to_s3"}, 90},
		{"upload_complete", types.KBProgressInfo{Phase: "upload_complete"}, 95},
		{"finalizing", types.KBProgressInfo{Phase: "finalizing"}, 97},
		{"completed", types.KBProgressInfo{Phase: "completed"}, 100},
		{"failed", types.KBProgressInfo{Phase: "failed"}, 0},
		{"unknown", types.KBProgressInfo{Phase: "mystery"}, 0},
		{"pct_caps_at_100", types.KBProgressInfo{Phase: "finalizing", Percentage: 200}, 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, calculateProgressPercentage(tc.in))
		})
	}
}

func TestReadKBProgressActivity_Success(t *testing.T) {
	body, _ := json.Marshal(types.KBProgressInfo{
		Phase: "processing_documents", Status: "in_progress", TotalDocuments: 4,
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.Contains(r.URL.Path, "progress.json") {
			_, _ = w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadKBProgressActivity)
	val, err := env.ExecuteActivity(ReadKBProgressActivity, "b", "kb1", "projects/p1")
	require.NoError(t, err)
	var got types.KBProgressInfo
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "processing_documents", got.Phase)
}

func TestReadKBProgressActivity_InvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "not-json")
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ReadKBProgressActivity)
	_, err := env.ExecuteActivity(ReadKBProgressActivity, "b", "kb1", "")
	require.Error(t, err)
}

func TestPostWorkflowProgressActivity_FullPayload(t *testing.T) {
	var received map[string]interface{}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = ln.Close() })

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/workflows/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/progress") {
			_ = json.NewDecoder(r.Body).Decode(&received)
			w.WriteHeader(http.StatusOK)
		}
	})
	go func() { _ = http.Serve(ln, mux) }()

	t.Setenv("PORT", strings.TrimPrefix(ln.Addr().String(), "127.0.0.1:"))

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PostWorkflowProgressActivity)
	_, err = env.ExecuteActivity(PostWorkflowProgressActivity, PostWorkflowProgressInput{
		Phase: "copying", Percentage: 42, Message: "halfway", Replace: true,
		TotalUnits: 3,
		Units: []UnitProgressSeed{
			{UnitID: "u1", Status: "completed"},
			{UnitID: "u2"},
		},
		UnitID: "u1", UnitStatus: "completed",
		UnitMetrics: map[string]interface{}{"fileCount": float64(5)},
		Extra:       map[string]interface{}{"filesCopied": float64(9)},
	})
	require.NoError(t, err)
	assert.Equal(t, "copying", received["phase"])
	assert.Equal(t, true, received["replace"])
	assert.NotNil(t, received["units"])
}
