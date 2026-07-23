package clients

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/require"
)

// closedServer returns the URL of a server that has already been closed, so
// any HTTP request to it fails with "connection refused" — exercising the
// `httpClient.Do` error branch on every method.
func closedServer(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()
	return url
}

func TestConfigClient_AllHTTPDoErrorsPropagate(t *testing.T) {
	url := closedServer(t)
	cc := NewConfigClientWithHTTPClient(url, http.DefaultClient)

	_, err := cc.GetPipeline("p", "pipe")
	require.Error(t, err)

	require.Error(t, cc.CreateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe"}))
	_, err = cc.GetExecution("p", "pipe", "e")
	require.Error(t, err)
	_, err = cc.ListExecutions("p", "pipe")
	require.Error(t, err)
	require.Error(t, cc.UpdateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"}))

	require.Error(t, cc.CreateBucket("p", "b", types.CreateBucketRequest{}))
	_, err = cc.GetBucket("p", "b")
	require.Error(t, err)
	require.Error(t, cc.DeleteBucket("p", "b"))
	_, err = cc.GetBucketRouting("p", "b")
	require.Error(t, err)
	require.Error(t, cc.UpdateProjectMetadata("p", nil))
	require.Error(t, cc.CreateProjectServiceAccount("p"))
	_, err = cc.GetProjectServiceAccount("p")
	require.Error(t, err)
	require.Error(t, cc.UpdateDatasetStatus("p", "d", "ready", ""))
	require.Error(t, cc.UpdateDatasetCatalogRef("p", "d", "ref"))
	_, err = cc.GetDataset("p", "d")
	require.Error(t, err)
	_, err = cc.GetDataSource("p", "ds")
	require.Error(t, err)
	require.Error(t, cc.UpdateDatasetWatermark("p", "d", "w"))
	require.Error(t, cc.PostDataSourceScanResult("p", "ds", map[string]interface{}{}, nil))
	require.Error(t, cc.UpdateKnowledgeBase("p", "kb", nil))
	require.Error(t, cc.UpdateFacet("p", "ent", "id", "facet", nil))
	_, err = cc.GetHealthEligibleMCPServers()
	require.Error(t, err)
	require.Error(t, cc.UpdateMCPServerStatus("a", "status"))
	_, _, err = cc.GetKBStorageRoot("p", "kb")
	require.Error(t, err)

	require.Error(t, cc.SetupProjectLLMGateway("p"))
	require.Error(t, cc.TeardownProjectLLMGateway("p", nil))
	require.Error(t, cc.ReportProjectInitStatus("p", "ready", ""))
	_, err = cc.ResolveOrCreateUsers([]string{"a@b.com"})
	require.Error(t, err)
	_, err = cc.ResolveUsers([]string{"a@b.com"})
	require.Error(t, err)
	_, err = cc.ListProjectsForVKRotation()
	require.Error(t, err)
	_, err = cc.RotateProjectVirtualKey("p")
	require.Error(t, err)
	_, err = cc.CompleteProjectVirtualKeyRotation("p")
	require.Error(t, err)
}

func TestLakekeeperClient_AllHTTPDoErrorsPropagate(t *testing.T) {
	url := closedServer(t)
	c := NewLakekeeperClientWithHTTPClient(url, http.DefaultClient)

	_, err := c.CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.Error(t, err)
	_, err = c.GetWarehouseByName("wh")
	require.Error(t, err)
	require.Error(t, c.DeleteWarehouse("wh"))
	require.Error(t, c.CreateNamespace(types.CreateNamespaceRequest{}))
	_, err = c.GetTable("wh", "ns", "t")
	require.Error(t, err)
	_, err = c.ListTables("wh", "ns")
	require.Error(t, err)
	require.Error(t, c.DeleteTable("wh", "ns", "t"))
	require.Error(t, c.DeleteNamespace("wh", "ns"))
	_, err = c.ListNamespaces("wh")
	require.Error(t, err)
	require.Error(t, c.EnsureNamespace("wh", "x"))
	require.Error(t, c.CreateTable("wh", "ns", CreateTableRequest{Schema: map[string]interface{}{}}))
}

func TestConfigClient_AddAuthHeader_NoOpWhenNoSAClient(t *testing.T) {
	cc := NewConfigClientWithHTTPClient("http://x", nil)
	req, _ := http.NewRequest(http.MethodGet, "http://x/", nil)
	require.NoError(t, cc.addAuthHeader(req))
}
