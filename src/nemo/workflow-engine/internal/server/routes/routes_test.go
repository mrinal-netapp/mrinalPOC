package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// --- shared test infrastructure --------------------------------------------

type configStub struct {
	mu       sync.Mutex
	server   *httptest.Server
	routes   map[string]http.HandlerFunc // key = METHOD + " " + prefix
	requests []recordedReq
}

type recordedReq struct {
	Method string
	Path   string
	Body   string
}

func newConfigStub(t *testing.T) *configStub {
	t.Helper()
	s := &configStub{routes: map[string]http.HandlerFunc{}}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		s.mu.Lock()
		s.requests = append(s.requests, recordedReq{Method: r.Method, Path: r.URL.Path, Body: string(body)})
		var match http.HandlerFunc
		var matchLen int
		for k, h := range s.routes {
			parts := strings.SplitN(k, " ", 2)
			if len(parts) != 2 {
				continue
			}
			if parts[0] != r.Method {
				continue
			}
			if strings.HasPrefix(r.URL.Path, parts[1]) && len(parts[1]) > matchLen {
				match = h
				matchLen = len(parts[1])
			}
		}
		s.mu.Unlock()
		if match != nil {
			match(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *configStub) on(method, prefix string, h http.HandlerFunc) {
	s.routes[method+" "+prefix] = h
}

// fakeWorkflowRun mimics the SDK's WorkflowRun for ExecuteWorkflow returns.
type fakeWorkflowRun struct {
	id     string
	runID  string
	getOut interface{}
	getErr error
}

func (f *fakeWorkflowRun) GetID() string    { return f.id }
func (f *fakeWorkflowRun) GetRunID() string { return f.runID }
func (f *fakeWorkflowRun) Get(_ context.Context, valuePtr interface{}) error {
	if f.getErr != nil {
		return f.getErr
	}
	if f.getOut != nil && valuePtr != nil {
		b, err := json.Marshal(f.getOut)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, valuePtr)
	}
	return nil
}
func (f *fakeWorkflowRun) GetWithOptions(_ context.Context, valuePtr interface{}, _ client.WorkflowRunGetOptions) error {
	return f.Get(nil, valuePtr)
}

func newExecutorRouter(t *testing.T) (*gin.Engine, *mocks.Client, *configStub) {
	t.Helper()
	mt := &mocks.Client{}
	stub := newConfigStub(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)

	r := gin.New()
	api := r.Group("/api/v1")
	SetupRoutes(api, executor, hs)
	SetupProjectInitRoutes(api, executor)
	SetupProjectDeleteRoutes(api, executor)
	SetupTableProcessingRoutes(api, executor)
	SetupDatasetDeleteRoutes(api, executor)
	SetupDatasetImportRoutes(api, executor)
	SetupKBCreationRoutes(api, executor)
	SetupKBDeleteRoutes(api, executor)
	SetupKBScheduleRoutes(api, executor)
	SetupKBVersionsRoutes(api, cc)
	SetupWorkflowStatusRoutes(api, executor)
	SetupMCPHealthRoutes(api, executor)
	SetupReferenceEdgeRoutes(api, executor)
	t.Cleanup(func() { mt.AssertExpectations(t) })
	return r, mt, stub
}

// newExecutorRouterWithUserClaims is the same as newExecutorRouter but installs a
// leading middleware that injects test user claims into the gin context. Routes
// that read middleware.GetUserClaims (e.g. project init) require this; routes
// that don't will simply ignore the injected value.
func newExecutorRouterWithUserClaims(t *testing.T, claims *middleware.UserClaims) (*gin.Engine, *mocks.Client, *configStub) {
	t.Helper()
	mt := &mocks.Client{}
	stub := newConfigStub(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("userClaims", claims)
		c.Next()
	})
	api := r.Group("/api/v1")
	SetupRoutes(api, executor, hs)
	SetupProjectInitRoutes(api, executor)
	SetupProjectDeleteRoutes(api, executor)
	SetupTableProcessingRoutes(api, executor)
	SetupDatasetDeleteRoutes(api, executor)
	SetupDatasetImportRoutes(api, executor)
	SetupKBCreationRoutes(api, executor)
	SetupKBDeleteRoutes(api, executor)
	SetupKBScheduleRoutes(api, executor)
	SetupKBVersionsRoutes(api, cc)
	SetupWorkflowStatusRoutes(api, executor)
	SetupMCPHealthRoutes(api, executor)
	SetupReferenceEdgeRoutes(api, executor)
	t.Cleanup(func() { mt.AssertExpectations(t) })
	return r, mt, stub
}

// testUserClaims returns a generic non-service-account UserClaims value that
// passes the project_init handler's "must be a real user" guard.
func testUserClaims() *middleware.UserClaims {
	return &middleware.UserClaims{
		UserID:   "00000000-0000-0000-0000-000000000001",
		Username: "test-user",
		Email:    "test-user@example.test",
		Name:     "Test User",
	}
}

// jsonReader is a small helper.
func jsonReader(t *testing.T, v interface{}) io.Reader {
	t.Helper()
	body, err := json.Marshal(v)
	require.NoError(t, err)
	return bytes.NewReader(body)
}

// --- ProjectInit ------------------------------------------------------------

func TestRoute_ProjectInit_Success(t *testing.T) {
	r, mt, _ := newExecutorRouterWithUserClaims(t, testUserClaims())
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "project-init-p" }),
		"ProjectInitWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	body := map[string]string{"region": "us-east-1"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/init", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestRoute_ProjectInit_DefaultsWhenBodyEmpty(t *testing.T) {
	r, mt, _ := newExecutorRouterWithUserClaims(t, testUserClaims())
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectInitWorkflow", mock.Anything).
		Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/init", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code)
}

func TestRoute_ProjectInit_TemporalErrorPropagates(t *testing.T) {
	r, mt, _ := newExecutorRouterWithUserClaims(t, testUserClaims())
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectInitWorkflow", mock.Anything).
		Return(nil, errors.New("nope")).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/init", jsonReader(t, map[string]string{"region": "us-east-1"}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- ProjectDelete ----------------------------------------------------------

func TestRoute_ProjectDelete_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "project-delete-p" }),
		"ProjectDeleteWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/delete", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

func TestRoute_ProjectDelete_TemporalError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectDeleteWorkflow", mock.Anything).
		Return(nil, errors.New("boom")).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/delete", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- DatasetDelete + Terminate ----------------------------------------------

func TestRoute_DatasetDelete_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "dataset-delete-p-d" }),
		"DatasetDeleteWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	body := map[string]string{"tableName": "t"}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

func TestRoute_DatasetDelete_MissingTableName(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d",
		jsonReader(t, map[string]string{}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_DatasetDelete_BadJSONBody(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d",
		bytes.NewBufferString(`{not-json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_DatasetTerminate(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	// Schedule delete + four cancel calls (best-effort: may all succeed or 404).
	sc := &mocks.ScheduleClient{}
	sh := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(sc)
	sc.On("GetHandle", mock.Anything, "acq-p-d").Return(sh).Once()
	sh.On("Delete", mock.Anything).Return(nil).Once()
	mt.On("CancelWorkflow", mock.Anything, mock.AnythingOfType("string"), "").
		Return(nil).Times(4)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/terminate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

// --- KB Creation -----------------------------------------------------------

func TestRoute_KBCreation_RequiresKBName(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/create",
		jsonReader(t, map[string]interface{}{"sourceDatasetId": "d"}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_KBCreation_RequiresSourceDataset(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/create",
		jsonReader(t, map[string]interface{}{"kbName": "n"}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_KBCreation_RequiresBucket(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/create",
		jsonReader(t, map[string]interface{}{"kbName": "n", "sourceDatasetId": "d"}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_KBCreation_BadJSONBody(t *testing.T) {
	r, _, _ := newExecutorRouter(t)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/create",
		bytes.NewBufferString(`not-json`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRoute_KBCreation_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "facet-knowledge_base-kb-embedding"
		}),
		"KnowledgeBaseCreationWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/create",
		jsonReader(t, map[string]interface{}{
			"kbName": "n", "sourceDatasetId": "d", "bucketName": "b",
		}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

// --- KB Delete + Terminate -------------------------------------------------

func TestRoute_KBDelete_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "kb-delete-p-kb"
		}),
		"KnowledgeBaseDeleteWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/knowledgebases/kb", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusAccepted, w.Code)
}

func TestRoute_KBDelete_TemporalError(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "KnowledgeBaseDeleteWorkflow", mock.Anything).
		Return(nil, errors.New("nope")).Once()

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/knowledgebases/kb", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_KBTerminate(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "facet-knowledge_base-kb-embedding", "").Return(nil).Once()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/knowledgebases/kb/terminate", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	var got map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	assert.NotNil(t, got["cancelled"])
}

// --- TableProcessing ------------------------------------------------------

func TestRoute_TableProcessing_Success(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool { return o.ID == "table-processing-p-d" }),
		"TableProcessingWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-1", runID: "r1"}, nil).Once()

	body := types.TableProcessingWorkflowInput{TableName: "t", Namespace: "ns"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/datasets/d/process",
		jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	// TableProcessing returns 201 Created (not 202 Accepted).
	require.Equal(t, http.StatusCreated, w.Code)
}

// --- workflow_status ------------------------------------------------------

func TestRoute_WorkflowStatus_Cancel(t *testing.T) {
	r, mt, _ := newExecutorRouter(t)
	mt.On("CancelWorkflow", mock.Anything, "wf-1", "run-1").Return(nil).Once()

	body := map[string]string{"runId": "run-1"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/cancel", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}
