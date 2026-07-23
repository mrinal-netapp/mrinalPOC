package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

// newConnectorRouter wires the connector routes (separate from the bigger
// router used by other tests because connectors take an explorerCache arg).
func newConnectorRouter(t *testing.T, withCache bool) (*gin.Engine, *mocks.Client, *configStub, *cache.ExplorerListCache) {
	t.Helper()
	mt := &mocks.Client{}
	stub := newConfigStub(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)

	var ec *cache.ExplorerListCache
	if withCache {
		s := miniredis.RunT(t)
		t.Cleanup(func() { s.Close() })
		c, err := cache.NewExplorerListCache("redis://"+s.Addr()+"/0", 100, 60)
		require.NoError(t, err)
		ec = c
	}
	r := gin.New()
	api := r.Group("/api/v1")
	SetupConnectorRoutes(api, executor, ec)
	t.Cleanup(func() { mt.AssertExpectations(t) })
	return r, mt, stub, ec
}

func TestConnectorRoute_AcquireDataset_Success(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "data-acquire-p-d" }),
		"DataAcquisitionWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "data-acquire-p-d", runID: "r1"}, nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/acquire", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

func TestConnectorRoute_CreateAcquisitionSchedule(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	// Create-replace: the handler best-effort deletes the deterministic schedule
	// id ("acq-p-d") before creating, even when no temporalScheduleId is supplied.
	sc.On("GetHandle", mock.Anything, "acq-p-d").Return(sh).Once()
	sh.On("Delete", mock.Anything).Return(nil).Once()
	sc.On("Create", mock.Anything, mock.Anything).Return(sh, nil).Once()
	sh.On("GetID").Return("acq-p-d").Once()

	body := map[string]interface{}{"cronExpression": "*/5 * * * *", "enabled": true}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestConnectorRoute_CreateAcquisitionSchedule_DisableTearsDown(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	// enabled=false with no temporalScheduleId: the handler tears down the
	// deterministic schedule id ("acq-p-d") and returns 200 without creating one.
	sc.On("GetHandle", mock.Anything, "acq-p-d").Return(sh).Once()
	sh.On("Delete", mock.Anything).Return(nil).Once()

	body := map[string]interface{}{"enabled": false}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	// No Create expectation set: AssertExpectations (via t.Cleanup) fails if the
	// handler unexpectedly created a schedule.
}

func TestConnectorRoute_CreateAcquisitionSchedule_EnableRequiresCron(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	// enabled=true with an empty cronExpression must 400 *before* touching any
	// existing schedule. No ScheduleClient expectations are registered, so the
	// strict mock would panic if the handler deleted/created a schedule first —
	// guarding against the delete-before-validate regression.
	body := map[string]interface{}{"enabled": true}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_CreateAcquisitionSchedule_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/schedule",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_DeleteAcquisitionSchedule(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("GetHandle", mock.Anything, "acq-x").Return(sh).Once()
	sh.On("Delete", mock.Anything).Return(nil).Once()

	body := map[string]string{"temporalScheduleId": "acq-x"}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d/schedule", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_DeleteAcquisitionSchedule_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d/schedule",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_GetAcquisitionSchedule_RequiresQuery(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/datasets/d/schedule", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_GetAcquisitionSchedule_Success(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("GetHandle", mock.Anything, "acq-x").Return(sh).Once()
	sh.On("Describe", mock.Anything).Return(&client.ScheduleDescription{}, nil).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/datasets/d/schedule?temporalScheduleId=acq-x", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_TestConnector_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/connectors/c/test",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_TestConnector_Success(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ConnectorInteractiveWorkflow", mock.Anything).
		Return(&fakeWorkflowRun{id: "connector-test-p-c-1"}, nil).Once()

	body := map[string]interface{}{
		"connectorConfig": map[string]interface{}{"connector_type": "objectstore", "provider": "s3"},
		"credentialId":    "cred",
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/connectors/c/test", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_TestConnector_UnsupportedConnectorType(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	body := map[string]interface{}{
		"connectorConfig": map[string]interface{}{"connector_type": "weird", "provider": "weird"},
		"credentialId":    "cred",
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/connectors/c/test", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestConnectorRoute_DiscoverAndPreview_Smoke(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)

	dreq := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/connectors/c/discover", nil)
	dw := httptest.NewRecorder()
	r.ServeHTTP(dw, dreq)
	require.Equal(t, http.StatusOK, dw.Code)

	preq := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/connectors/c/preview", nil)
	pw := httptest.NewRecorder()
	r.ServeHTTP(pw, preq)
	require.Equal(t, http.StatusOK, pw.Code)
}

func TestConnectorRoute_TerminateConnectorWorkflows(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	// All three list calls (test/explorer/explorer-list) return empty.
	mt.On("ListWorkflow", mock.Anything, mock.Anything).
		Return(&workflowservice.ListWorkflowExecutionsResponse{}, nil).Times(3)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/connectors/c/terminate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_StartExplorerSession_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_StartExplorerSession_Success(t *testing.T) {
	r, mt, stub, _ := newConnectorRouter(t, false)
	stub.on(http.MethodGet, "/api/v1/projects/p/datasources/c", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"connector_config": map[string]interface{}{"provider": "ontap", "scope": "resource"},
			"credential_id":    "cred",
		})
	})
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeWorkflowRun{id: "explorer-x", runID: "r"}, nil).Once()

	body := map[string]string{"projectId": "p", "connectorId": "c"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestConnectorRoute_VolumeBrowse_Success(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeWorkflowRun{id: "volume-browse-x"}, nil).Once()

	body := map[string]string{"projectId": "p", "volumeId": "v", "subPath": ""}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/connectors/volume-browse", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	// The handler dispatches a workflow whose Get returns nil result, then JSON-encodes.
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_VolumeBrowse_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/connectors/volume-browse",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_VolumeScan_Success(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeWorkflowRun{id: "volume-scan-x"}, nil).Once()

	body := map[string]interface{}{
		"projectId": "p", "dataSourceId": "ds", "scanConfig": map[string]interface{}{"depth": 3},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/connectors/volume-scan", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

func TestConnectorRoute_ExplorerCacheInvalidate(t *testing.T) {
	r, _, _, ec := newConnectorRouter(t, true)
	require.NotNil(t, ec)

	body := map[string]string{"projectId": "p", "connectorId": "c"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/cache/invalidate", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_ExplorerCacheInvalidate_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, true)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/cache/invalidate",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_ExplorerList_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session/s1/list",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestConnectorRoute_ExplorerList_DirectPath_Success(t *testing.T) {
	r, mt, stub, _ := newConnectorRouter(t, false)
	stub.on(http.MethodGet, "/api/v1/projects/p/datasources/c", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"connector_config": map[string]interface{}{"provider": "ontap", "scope": "resource"},
			"credential_id":    "cred",
		})
	})
	resp := &workflows.ExplorerResponse{
		Nodes: []workflows.ExplorerNode{{ID: "n1", Label: "vol", Type: "volume"}},
	}
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeWorkflowRun{getOut: resp}, nil).Once()

	body := map[string]interface{}{
		"action": "list", "projectId": "p", "connectorId": "c", "payload": map[string]interface{}{},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session/s1/list", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_ExplorerList_DirectPath_Error(t *testing.T) {
	r, mt, stub, _ := newConnectorRouter(t, false)
	stub.on(http.MethodGet, "/api/v1/projects/p/datasources/c", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"connector_config": map[string]interface{}{"provider": "ontap"},
			"credential_id":    "cred",
		})
	})
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("workflow down")).Once()

	body := map[string]interface{}{"action": "list", "projectId": "p", "connectorId": "c"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session/s1/list", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestConnectorRoute_ExplorerList_CacheHit(t *testing.T) {
	r, _, _, ec := newConnectorRouter(t, true)
	require.NotNil(t, ec)
	cached := &workflows.ExplorerResponse{
		Nodes: []workflows.ExplorerNode{{ID: "cached", Label: "cached", Type: "volume"}},
	}
	key := cache.CacheKey("p", "c", "list", map[string]interface{}{})
	ec.Set(context.Background(), key, cached)

	body := map[string]interface{}{
		"action": "list", "projectId": "p", "connectorId": "c", "payload": map[string]interface{}{},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session/s1/list", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestConnectorRoute_ExplorerList_SessionPath_Error(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("UpdateWorkflow", mock.Anything, "sess-1", "List", mock.Anything).
		Return(nil, errors.New("session gone")).Once()

	body := map[string]interface{}{"action": "list", "payload": map[string]interface{}{}}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/explore/session/sess-1/list", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestPrefetchListPathChildren_SkipsNonFolders(t *testing.T) {
	prefetchListPathChildren("p", "c", map[string]interface{}{"prefix": "/"},
		[]workflows.ExplorerNode{
			{Type: "file", Resource: map[string]interface{}{"prefix": "x/"}},
		}, nil, nil)
}

func TestConnectorRoute_AcquireDataset_Error(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("start failed")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/acquire", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestConnectorRoute_VolumeScan_BadJSON(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/connectors/volume-scan",
		bytes.NewBufferString("not-json"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

// Sanity: silence unused
var (
	_ = redis.NewClient
	_ = assert.Equal
)
