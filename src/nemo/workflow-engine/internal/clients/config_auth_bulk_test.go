package clients

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/require"
)

// clientWithBrokenAuth attaches a service-account client that always fails
// AddAuthHeader, exercising the warning log path while the HTTP call still succeeds.
func clientWithBrokenAuth(t *testing.T, stub *stubServer) *ConfigClient {
	t.Helper()
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	sa, err := NewServiceAccountClientWithCredentials(dead.URL, "id", "secret")
	require.NoError(t, err)
	cc := stub.client()
	cc.serviceAccountAuth = sa
	return cc
}

func TestConfigClient_AuthWarning_AllReadMethods(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions/e", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.PipelineExecution{ExecutionId: "e"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe/executions", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]*types.PipelineExecution{})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/buckets/b", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "b"})
	})
	s.on(http.MethodGet, "/api/v1/buckets/p/b", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(BucketRoutingResponse{ProjectId: "p", BucketName: "b"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/service-account", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(ProjectServiceAccountResponse{ClientId: "c"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/datasets/d", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "d"})
	})
	s.on(http.MethodGet, "/api/v1/projects/p/datasources/ds", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "ds"})
	})
	s.on(http.MethodGet, "/api/v1/internal/mcp-servers", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]types.MCPServerHealthInfo{})
	})
	s.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/projects/p/knowledgebases/kb" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"bucketName": "kb-b"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": "b/pfx"})
	})
	s.on(http.MethodGet, "/api/v1/internal/projects/gateway-rotation-targets", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.ListProjectsForVKRotationResult{})
	})

	cc := clientWithBrokenAuth(t, s)
	_, err := cc.GetPipeline("p", "pipe")
	require.NoError(t, err)
	_, err = cc.GetExecution("p", "pipe", "e")
	require.NoError(t, err)
	_, err = cc.ListExecutions("p", "pipe")
	require.NoError(t, err)
	_, err = cc.GetBucket("p", "b")
	require.NoError(t, err)
	_, err = cc.GetBucketRouting("p", "b")
	require.NoError(t, err)
	_, err = cc.GetProjectServiceAccount("p")
	require.NoError(t, err)
	_, err = cc.GetDataset("p", "d")
	require.NoError(t, err)
	_, err = cc.GetDataSource("p", "ds")
	require.NoError(t, err)
	_, err = cc.GetHealthEligibleMCPServers()
	require.NoError(t, err)
	_, _, err = cc.GetKBStorageRoot("p", "kb")
	require.NoError(t, err)
	_, err = cc.ListProjectsForVKRotation()
	require.NoError(t, err)
}

func TestConfigClient_AuthWarning_AllWriteMethods(t *testing.T) {
	s := newStub(t)
	ok := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }
	created := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) }
	s.on(http.MethodPost, "/api/v1/projects/p/pipelines/pipe/executions", created)
	s.on(http.MethodPut, "/api/v1/projects/p/pipelines/pipe/executions/e", ok)
	s.on(http.MethodPost, "/api/v1/projects/p/buckets", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
		w.WriteHeader(http.StatusCreated)
	})
	s.on(http.MethodDelete, "/api/v1/projects/p/buckets/b", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	s.on(http.MethodPut, "/api/v1/projects/p", ok)
	s.on(http.MethodPost, "/api/v1/projects/p/service-account", created)
	s.on(http.MethodPut, "/api/v1/projects/p/datasets/d/status", ok)
	s.on(http.MethodPut, "/api/v1/projects/p/datasets/d/catalog-ref", ok)
	s.on(http.MethodPatch, "/api/v1/projects/p/datasets/d", ok)
	s.on(http.MethodPatch, "/api/v1/internal/datasources/p/ds/scan-result", ok)
	s.on(http.MethodPut, "/api/v1/projects/p/knowledgebases/kb", ok)
	s.on(http.MethodPut, "/api/v1/projects/p/knowledgebases/kb/facets/embedding", ok)
	s.on(http.MethodPatch, "/api/v1/internal/mcp-servers/a/status", ok)
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-setup", ok)
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-teardown", ok)
	s.on(http.MethodPost, "/api/v1/internal/projects/p/init-status", ok)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve-or-create", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"resolved": []types.ResolvedMember{}})
	})
	s.on(http.MethodPost, "/api/v1/internal/users/resolve", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"resolved": []types.ResolvedMember{}})
	})
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-rotate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.RotateProjectVirtualKeyResult{ProjectId: "p"})
	})
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-rotate-complete", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.DeleteRetiredProjectVirtualKeyResult{ProjectId: "p"})
	})

	cc := clientWithBrokenAuth(t, s)
	require.NoError(t, cc.CreateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
	require.NoError(t, cc.UpdateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))
	require.NoError(t, cc.CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
	require.NoError(t, cc.DeleteBucket("p", "b"))
	require.NoError(t, cc.UpdateProjectMetadata("p", map[string]interface{}{"k": "v"}))
	require.NoError(t, cc.CreateProjectServiceAccount("p"))
	require.NoError(t, cc.UpdateDatasetStatus("p", "d", "ready", ""))
	require.NoError(t, cc.UpdateDatasetCatalogRef("p", "d", "ref"))
	require.NoError(t, cc.UpdateDatasetWatermark("p", "d", "w"))
	require.NoError(t, cc.PostDataSourceScanResult("p", "ds", map[string]interface{}{}, nil))
	require.NoError(t, cc.UpdateKnowledgeBase("p", "kb", map[string]interface{}{"x": 1}))
	require.NoError(t, cc.UpdateFacet("p", "knowledgebases", "kb", "embedding", map[string]interface{}{}))
	require.NoError(t, cc.UpdateMCPServerStatus("a", "healthy"))
	require.NoError(t, cc.SetupProjectLLMGateway("p"))
	require.NoError(t, cc.TeardownProjectLLMGateway("p", &types.ProjectGatewayMeta{TeamId: "t"}))
	// ReportProjectInitStatus propagates auth-header failures (unlike most CRUD methods).
	_, err := cc.ResolveOrCreateUsers([]string{"a@b.com"})
	require.NoError(t, err)
	_, err = cc.ResolveUsers([]string{"a@b.com"})
	require.NoError(t, err)
	_, err = cc.RotateProjectVirtualKey("p")
	require.NoError(t, err)
	_, err = cc.CompleteProjectVirtualKeyRotation("p")
	require.NoError(t, err)
}

func TestConfigClient_CreateBucket_ConflictWithBody(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects/p/buckets", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"detail":"exists"}`)
	})
	require.NoError(t, s.client().CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
}

func TestConfigClient_CreateBucket_SuccessReadsBody(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects/p/buckets", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"name":"b"}`)
	})
	require.NoError(t, s.client().CreateBucket("p", "b", types.CreateBucketRequest{Name: "b"}))
}

func TestConfigClient_DeleteBucket_SuccessWithBody(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodDelete, "/api/v1/projects/p/buckets/b", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"deleted":true}`)
	})
	require.NoError(t, s.client().DeleteBucket("p", "b"))
}

func TestConfigClient_UpdateProjectMetadata_ReadsResponseBody(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPut, "/api/v1/projects/p", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().UpdateProjectMetadata("p", map[string]interface{}{"wh": "id"}))
}

func TestConfigClient_SetupProjectLLMGateway_CreatedStatus(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-setup", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"teamId":"t"}`)
	})
	require.NoError(t, s.client().SetupProjectLLMGateway("p"))
}

func TestConfigClient_TeardownProjectLLMGateway_CreatedStatus(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p/gateway-teardown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{}`)
	})
	require.NoError(t, s.client().TeardownProjectLLMGateway("p", nil))
}

func TestConfigClient_CreateProjectServiceAccount_ReadsConflictBody(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/projects/p/service-account", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"exists":true}`)
	})
	require.NoError(t, s.client().CreateProjectServiceAccount("p"))
}

func TestConfigClient_GetBucketRouting_SuccessWithDeployments(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/buckets/p/b", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(BucketRoutingResponse{
			ProjectId: "p", BucketName: "b",
			Deployments: []RoutingDeploymentInfo{{DeploymentId: "d1"}, {DeploymentId: "d2"}},
		})
	})
	got, err := s.client().GetBucketRouting("p", "b")
	require.NoError(t, err)
	require.Len(t, got.Deployments, 2)
}
