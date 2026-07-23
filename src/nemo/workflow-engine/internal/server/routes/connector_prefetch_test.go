package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

type prefetchWorkflowRun struct {
	getOut interface{}
}

func (f *prefetchWorkflowRun) GetID() string    { return "explorer-list-p-c-x" }
func (f *prefetchWorkflowRun) GetRunID() string { return "run-1" }
func (f *prefetchWorkflowRun) Get(_ context.Context, valuePtr interface{}) error {
	if valuePtr == nil || f.getOut == nil {
		return nil
	}
	data, err := json.Marshal(f.getOut)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, valuePtr)
}
func (f *prefetchWorkflowRun) GetWithOptions(_ context.Context, _ interface{}, _ client.WorkflowRunGetOptions) error {
	return nil
}

func TestPrefetchListPathChildren_HappyPath(t *testing.T) {
	mt := &mocks.Client{}
	stub := newConfigStub(t)
	stub.on(http.MethodGet, "/api/v1/projects/p/datasources/c", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"connector_config": map[string]interface{}{"provider": "ontap", "scope": "resource"},
			"credential_id":    "cred",
		})
	})
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	ex := services.NewExecutorServiceWithDeps(mt, cc, hs)

	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })
	ec, err := cache.NewExplorerListCache("redis://"+s.Addr()+"/0", 100, 60)
	require.NoError(t, err)

	resp := &workflows.ExplorerResponse{
		Nodes: []workflows.ExplorerNode{{ID: "child", Label: "sub", Type: "volume"}},
	}
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&prefetchWorkflowRun{getOut: resp}, nil).Once()

	prefetchListPathChildren("p", "c", map[string]interface{}{"prefix": "/"},
		[]workflows.ExplorerNode{
			{Type: "folder", Resource: map[string]interface{}{"prefix": "sub/"}},
			{Type: "file", Resource: map[string]interface{}{"prefix": "x/"}},
		}, ex, ec)

	key := cache.CacheKey("p", "c", "listPath", map[string]interface{}{"prefix": "sub/"})
	cached, err := ec.Get(context.Background(), key)
	require.NoError(t, err)
	require.NotNil(t, cached)
	assert.Equal(t, "child", cached.Nodes[0].ID)
	mt.AssertExpectations(t)
}

func TestPrefetchListPathChildren_NilCacheNoOp(t *testing.T) {
	prefetchListPathChildren("p", "c", nil, []workflows.ExplorerNode{
		{Type: "folder", Resource: map[string]interface{}{"prefix": "a/"}},
	}, nil, nil)
}
