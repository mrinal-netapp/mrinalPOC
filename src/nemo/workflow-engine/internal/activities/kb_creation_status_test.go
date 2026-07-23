package activities

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestUpdateKBStatusWithStatsActivity_PersistsZeroChunkOverlap(t *testing.T) {
	var kbUpdate map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			switch {
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1":
				require.NoError(t, json.Unmarshal(body, &kbUpdate))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"id":"kb1","status":"ready"}`))
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1/facets/embedding":
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{}`))
			default:
				t.Fatalf("unexpected PUT path: %s", r.URL.Path)
			}
		default:
			t.Fatalf("unexpected method: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateKBStatusWithStatsActivity)

	_, err := env.ExecuteActivity(UpdateKBStatusWithStatsActivity, UpdateKBStatusInput{
		ProjectId:     "p1",
		KbId:          "kb1",
		Status:        "ready",
		ChunkSize:     512,
		ChunkStrategy: "sentence",
		ChunkOverlap:  0,
	})
	require.NoError(t, err)
	require.Equal(t, "sentence", kbUpdate["chunkStrategy"])
	require.EqualValues(t, 0, kbUpdate["chunkOverlap"])
}

func TestUpdateKBStatusWithStatsActivity_PersistsDeferredProcessingFields(t *testing.T) {
	var kbUpdate map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			switch {
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1":
				require.NoError(t, json.Unmarshal(body, &kbUpdate))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"id":"kb1","status":"ready"}`))
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1/facets/embedding":
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{}`))
			default:
				t.Fatalf("unexpected PUT path: %s", r.URL.Path)
			}
		default:
			t.Fatalf("unexpected method: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateKBStatusWithStatsActivity)

	_, err := env.ExecuteActivity(UpdateKBStatusWithStatsActivity, UpdateKBStatusInput{
		ProjectId:        "p1",
		KbId:             "kb1",
		Status:           "ready",
		SourceDataset:    "ds-new1234",
		EmbeddingModelId: "11111111-1111-4111-8111-111111111111",
		DataType:         "structured",
		TextColumns:      "title,body",
		ChunkSize:        512,
		ChunkStrategy:    "fixed",
	})
	require.NoError(t, err)
	require.Equal(t, "ds-new1234", kbUpdate["sourceDataset"])
	require.Equal(t, "11111111-1111-4111-8111-111111111111", kbUpdate["embeddingModelId"])
	require.Equal(t, "structured", kbUpdate["dataType"])
	require.Equal(t, "title,body", kbUpdate["textColumns"])
}

func TestUpdateKBStatusWithStatsActivity_PersistsEmptyTextColumns(t *testing.T) {
	var kbUpdate map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			require.NoError(t, err)
			switch {
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1":
				require.NoError(t, json.Unmarshal(body, &kbUpdate))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"id":"kb1","status":"ready"}`))
			case r.URL.Path == "/api/v1/projects/p1/knowledgebases/kb1/facets/embedding":
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{}`))
			default:
				t.Fatalf("unexpected PUT path: %s", r.URL.Path)
			}
		default:
			t.Fatalf("unexpected method: %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateKBStatusWithStatsActivity)

	_, err := env.ExecuteActivity(UpdateKBStatusWithStatsActivity, UpdateKBStatusInput{
		ProjectId: "p1",
		KbId:      "kb1",
		Status:    "ready",
		DataType:  "unstructured",
	})
	require.NoError(t, err)
	require.Equal(t, "unstructured", kbUpdate["dataType"])
	require.Equal(t, "", kbUpdate["textColumns"])
}
