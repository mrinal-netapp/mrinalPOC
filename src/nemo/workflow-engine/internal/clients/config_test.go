package clients

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// route is a (method, path-prefix) -> handler entry.
type route struct {
	method  string
	prefix  string
	handler http.HandlerFunc
}

// stubServer is a small, longest-prefix-match HTTP test server used by the
// httptest-based config-client tests.
type stubServer struct {
	mu       sync.Mutex
	server   *httptest.Server
	routes   []route
	requests []recordedRequest
}

type recordedRequest struct {
	Method string
	Path   string
	Body   string
}

func newStub(t *testing.T) *stubServer {
	t.Helper()
	s := &stubServer{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		// Restore the body so handlers can re-read it.
		r.Body = io.NopCloser(bytes.NewReader(body))
		s.mu.Lock()
		s.requests = append(s.requests, recordedRequest{Method: r.Method, Path: r.URL.Path, Body: string(body)})
		var match http.HandlerFunc
		var matchLen int
		for _, route := range s.routes {
			if route.method != "" && route.method != r.Method {
				continue
			}
			if strings.HasPrefix(r.URL.Path, route.prefix) && len(route.prefix) > matchLen {
				match = route.handler
				matchLen = len(route.prefix)
			}
		}
		s.mu.Unlock()
		if match != nil {
			match(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("no route for " + r.Method + " " + r.URL.Path))
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *stubServer) on(method, prefix string, h http.HandlerFunc) {
	s.routes = append(s.routes, route{method: method, prefix: prefix, handler: h})
}

func (s *stubServer) client() *ConfigClient {
	return NewConfigClientWithHTTPClient(s.server.URL, http.DefaultClient)
}

func TestConfigClient_GetBaseURL(t *testing.T) {
	cc := NewConfigClientWithHTTPClient("http://x", nil)
	assert.Equal(t, "http://x", cc.GetBaseURL())
}

func TestConfigClient_NewConfigClient_DefaultsAndAuthLoggingPath(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")
	cc := NewConfigClient("http://example")
	require.NotNil(t, cc)
	assert.Equal(t, "http://example", cc.GetBaseURL())
}

// --- Pipeline / Execution -----------------------------------------------------

func TestConfigClient_GetPipeline_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe", ProjectId: "p"})
	})
	got, err := s.client().GetPipeline("p", "pipe")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "pipe", got.ID)
}

func TestConfigClient_GetPipeline_NotOK(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().GetPipeline("p", "pipe")
	require.Error(t, err)
}

func TestConfigClient_GetPipeline_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().GetPipeline("p", "pipe")
	require.Error(t, err)
}

func TestConfigClient_CreateExecution_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) })
	require.NoError(t, s.client().CreateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
}

func TestConfigClient_CreateExecution_NonCreated(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().CreateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
}

func TestConfigClient_GetExecution_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.PipelineExecution{ExecutionId: "e"})
	})
	got, err := s.client().GetExecution("p", "pipe", "e")
	require.NoError(t, err)
	assert.Equal(t, "e", got.ExecutionId)
}

func TestConfigClient_GetExecution_NotFound(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	_, err := s.client().GetExecution("p", "pipe", "e")
	require.Error(t, err)
}

func TestConfigClient_ListExecutions_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]*types.PipelineExecution{{ExecutionId: "a"}, {ExecutionId: "b"}})
	})
	got, err := s.client().ListExecutions("p", "pipe")
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestConfigClient_ListExecutions_Errors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().ListExecutions("p", "pipe")
	require.Error(t, err)
}

func TestConfigClient_UpdateExecution_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().UpdateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
}

func TestConfigClient_UpdateExecution_Errors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	require.Error(t, s.client().UpdateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
}

// --- Buckets -----------------------------------------------------------------

func TestConfigClient_CreateBucket_HappyPath(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects/p/buckets", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	require.NoError(t, s.client().CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
}

func TestConfigClient_CreateBucket_409Idempotent(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	require.NoError(t, s.client().CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
}

func TestConfigClient_CreateBucket_OtherErrorPropagates(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
}

func TestConfigClient_GetBucket_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "b"})
	})
	got, err := s.client().GetBucket("p", "b")
	require.NoError(t, err)
	assert.Equal(t, "b", got["name"])
}

func TestConfigClient_GetBucket_Errors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	_, err := s.client().GetBucket("p", "b")
	require.Error(t, err)
}

func TestConfigClient_DeleteBucket_404Idempotent(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodDelete, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	require.NoError(t, s.client().DeleteBucket("p", "b"))
}

func TestConfigClient_DeleteBucket_NoContentSuccess(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodDelete, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	require.NoError(t, s.client().DeleteBucket("p", "b"))
}

func TestConfigClient_DeleteBucket_OtherError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodDelete, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().DeleteBucket("p", "b"))
}

// --- Bucket routing / project metadata / SA ---------------------------------

func TestConfigClient_GetBucketRouting_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/buckets", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(BucketRoutingResponse{
			ProjectId: "p", BucketName: "b",
			Deployments: []RoutingDeploymentInfo{{DeploymentId: "d1"}},
		})
	})
	got, err := s.client().GetBucketRouting("p", "b")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Len(t, got.Deployments, 1)
}

func TestConfigClient_GetBucketRouting_Errors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/buckets", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().GetBucketRouting("p", "b")
	require.Error(t, err)
}

func TestConfigClient_UpdateProjectMetadata_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().UpdateProjectMetadata("p", map[string]interface{}{"k": "v"}))
}

func TestConfigClient_UpdateProjectMetadata_Errors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().UpdateProjectMetadata("p", map[string]interface{}{}))
}

func TestConfigClient_CreateProjectServiceAccount_HappyAndConflict(t *testing.T) {
	s := newStub(t)
	state := 0
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		if state == 0 {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusConflict)
		}
	})
	require.NoError(t, s.client().CreateProjectServiceAccount("p"))
	state = 1
	require.NoError(t, s.client().CreateProjectServiceAccount("p"), "409 must be treated as success")
}

func TestConfigClient_CreateProjectServiceAccount_OtherError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	require.Error(t, s.client().CreateProjectServiceAccount("p"))
}

func TestConfigClient_GetProjectServiceAccount_HappyAndError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(ProjectServiceAccountResponse{
			ProjectId: "p", ClientId: "id", ClientSecret: "secret",
		})
	})
	got, err := s.client().GetProjectServiceAccount("p")
	require.NoError(t, err)
	assert.Equal(t, "id", got.ClientId)

	s2 := newStub(t)
	s2.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	_, err = s2.client().GetProjectServiceAccount("p")
	require.Error(t, err)
}

// --- Datasets / data sources -------------------------------------------------

func TestConfigClient_UpdateDatasetStatus_VariousStatuses(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		require.Contains(t, string(body), `"status":"failed"`)
		require.Contains(t, string(body), `"errorMessage":"oops"`)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().UpdateDatasetStatus("p", "d", "failed", "oops"))
}

func TestConfigClient_UpdateDatasetStatus_OmitsErrorMessage(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		require.NotContains(t, string(body), "errorMessage")
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().UpdateDatasetStatus("p", "d", "ready", ""))
}

func TestConfigClient_UpdateDatasetStatus_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().UpdateDatasetStatus("p", "d", "ready", ""))
}

func TestConfigClient_UpdateDatasetCatalogRef_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		require.Contains(t, string(body), "catalogTableRef")
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().UpdateDatasetCatalogRef("p", "d", "ref"))
}

func TestConfigClient_UpdateDatasetCatalogRef_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	require.Error(t, s.client().UpdateDatasetCatalogRef("p", "d", "ref"))
}

func TestConfigClient_GetDatasetAndDataSource(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p/datasets", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "d"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/datasources", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "ds"})
	})
	got, err := s.client().GetDataset("p", "d")
	require.NoError(t, err)
	assert.Equal(t, "d", got["id"])

	got2, err := s.client().GetDataSource("p", "ds")
	require.NoError(t, err)
	assert.Equal(t, "ds", got2["id"])
}

func TestConfigClient_GetDatasetErrors(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().GetDataset("p", "d")
	require.Error(t, err)
	_, err = s.client().GetDataSource("p", "ds")
	require.Error(t, err)
}

func TestConfigClient_UpdateDatasetWatermark(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/projects", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		require.Contains(t, string(body), `"lastWatermarkValue":"2024-01-01"`)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().UpdateDatasetWatermark("p", "d", "2024-01-01"))
}

func TestConfigClient_UpdateDatasetWatermark_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().UpdateDatasetWatermark("p", "d", "x"))
}

func TestConfigClient_PostDataSourceScanResult(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/internal/datasources", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().PostDataSourceScanResult("p", "ds",
		map[string]interface{}{"state": "ok"},
		map[string]interface{}{"items": 1}))

	require.NoError(t, s.client().PostDataSourceScanResult("p", "ds",
		map[string]interface{}{"state": "ok"}, nil))
}

func TestConfigClient_PostDataSourceScanResult_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/internal/datasources", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().PostDataSourceScanResult("p", "ds", map[string]interface{}{}, nil))
}

// --- KB / Facets / MCP -------------------------------------------------------

func TestConfigClient_UpdateKnowledgeBase(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().UpdateKnowledgeBase("p", "kb", map[string]interface{}{"x": 1}))
}

func TestConfigClient_UpdateKnowledgeBase_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	require.Error(t, s.client().UpdateKnowledgeBase("p", "kb", map[string]interface{}{"x": 1}))
}

func TestConfigClient_UpdateFacet(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().UpdateFacet("p", "knowledgebases", "kb", "embedding", map[string]interface{}{"k": "v"}))
}

func TestConfigClient_UpdateFacet_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadRequest) })
	require.Error(t, s.client().UpdateFacet("p", "knowledgebases", "kb", "embedding", nil))
}

func TestConfigClient_GetHealthEligibleMCPServers(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/internal/mcp-servers", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]types.MCPServerHealthInfo{{ID: "a"}, {ID: "b"}})
	})
	got, err := s.client().GetHealthEligibleMCPServers()
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestConfigClient_GetHealthEligibleMCPServers_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/internal/mcp-servers", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().GetHealthEligibleMCPServers()
	require.Error(t, err)
}

func TestConfigClient_UpdateMCPServerStatus(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/internal/mcp-servers", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	require.NoError(t, s.client().UpdateMCPServerStatus("a", "healthy"))
}

func TestConfigClient_UpdateMCPServerStatus_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPatch, "/api/v1/internal/mcp-servers", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	require.Error(t, s.client().UpdateMCPServerStatus("a", "healthy"))
}

// --- KB storage root ---------------------------------------------------------

func TestConfigClient_GetKBStorageRoot_UsesKBBucket(t *testing.T) {
	s := newStub(t)
	// project-level lookup returns home_dir
	s.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/knowledgebases/kb") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"bucketName": "kb-bucket"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": "default-bucket/kbs"})
	})

	bucket, prefix, err := s.client().GetKBStorageRoot("p", "kb")
	require.NoError(t, err)
	assert.Equal(t, "kb-bucket", bucket)
	assert.Equal(t, "kbs", prefix)
}

func TestConfigClient_GetKBStorageRoot_FallsBackToProjectBucket(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/knowledgebases/kb") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{}) // no bucketName
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": ""})
	})
	bucket, prefix, err := s.client().GetKBStorageRoot("p", "kb")
	require.NoError(t, err)
	assert.Equal(t, "p", bucket)
	assert.Equal(t, "", prefix)
}

func TestConfigClient_GetKBStorageRoot_KBMissing(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/knowledgebases/kb") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": "b"})
	})
	_, _, err := s.client().GetKBStorageRoot("p", "kb")
	require.Error(t, err)
}

func TestConfigClient_GetKBStorageRoot_ProjectError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	_, _, err := s.client().GetKBStorageRoot("p", "kb")
	require.Error(t, err)
}

func TestSplitHomeDir(t *testing.T) {
	cases := []struct {
		homeDir   string
		projectId string
		bucket    string
		prefix    string
	}{
		{"", "proj", "proj", ""},
		{"  ", "proj", "proj", ""},
		{"/bucket", "proj", "bucket", ""},
		{"bucket/", "proj", "bucket", ""},
		{"bucket/path", "proj", "bucket", "path"},
		{"bucket/path/sub", "proj", "bucket", "path/sub"},
		{"/", "proj", "proj", ""},
	}
	for _, tc := range cases {
		bucket, prefix := splitHomeDir(tc.homeDir, tc.projectId)
		assert.Equalf(t, tc.bucket, bucket, "bucket for %q", tc.homeDir)
		assert.Equalf(t, tc.prefix, prefix, "prefix for %q", tc.homeDir)
	}
}
