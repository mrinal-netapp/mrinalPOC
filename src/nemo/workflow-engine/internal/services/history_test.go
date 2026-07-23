package services

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubConfigService stands in for the config-service. It records the requests
// it sees so tests can pin the URL/method/body shape produced by the various
// Config / History methods.
//
// Note: tests run handlers single-threaded via httptest, so no mutex is
// needed around `requests`. Add a sync.Mutex if you ever start exercising
// concurrent client calls.
type stubConfigService struct {
	server   *httptest.Server
	requests []recordedRequest
	router   map[string]http.HandlerFunc // key = METHOD + " " + path-prefix
}

type recordedRequest struct {
	Method string
	Path   string
	Body   string
}

func newStubConfigService(t *testing.T) *stubConfigService {
	t.Helper()
	s := &stubConfigService{router: map[string]http.HandlerFunc{}}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := readAll(t, r)
		s.requests = append(s.requests, recordedRequest{Method: r.Method, Path: r.URL.Path, Body: body})
		// Try exact-match (METHOD + path) first to avoid one short prefix from
		// stealing routes registered for a longer path.
		exactKey := r.Method + " " + r.URL.Path
		if h, ok := s.router[exactKey]; ok {
			h(w, r)
			return
		}
		// Fallback: longest prefix match per method, deterministic order.
		var bestPrefix string
		var bestHandler http.HandlerFunc
		for prefix, h := range s.router {
			parts := strings.SplitN(prefix, " ", 2)
			if len(parts) != 2 {
				continue
			}
			if r.Method != parts[0] {
				continue
			}
			if strings.HasPrefix(r.URL.Path, parts[1]) && len(parts[1]) > len(bestPrefix) {
				bestPrefix = parts[1]
				bestHandler = h
			}
		}
		if bestHandler != nil {
			bestHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("no route for " + exactKey))
	}))
	t.Cleanup(s.server.Close)
	return s
}

func readAll(t *testing.T, r *http.Request) string {
	t.Helper()
	if r.Body == nil {
		return ""
	}
	defer r.Body.Close()
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 256)
	for {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
	}
	return string(buf)
}

func (s *stubConfigService) handle(method, prefix string, handler http.HandlerFunc) {
	s.router[method+" "+prefix] = handler
}

func newHistoryServiceWithStub(t *testing.T, stub *stubConfigService) *HistoryService {
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, stub.server.Client())
	return NewHistoryServiceWithClient(cc)
}

func TestHistoryService_CreateExecution_Success(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodPost, "/api/v1/projects/p1/pipelines/pipe-1/executions",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusCreated)
		})

	hs := newHistoryServiceWithStub(t, stub)
	exec := &types.PipelineExecution{
		ProjectId:   "p1",
		PipelineId:  "pipe-1",
		ExecutionId: "exec-1",
	}
	require.NoError(t, hs.CreateExecution(exec))
	require.Len(t, stub.requests, 1)
	assert.Equal(t, http.MethodPost, stub.requests[0].Method)
	assert.Contains(t, stub.requests[0].Body, `"executionId":"exec-1"`)
}

func TestHistoryService_CreateExecution_PropagatesError(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodPost, "/api/v1/projects/p1/pipelines/p/executions",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})
	hs := newHistoryServiceWithStub(t, stub)
	err := hs.CreateExecution(&types.PipelineExecution{ProjectId: "p1", PipelineId: "p", ExecutionId: "e"})
	require.Error(t, err)
}

func TestHistoryService_GetExecution_Success(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p1/pipelines/p/executions/e",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(types.PipelineExecution{ExecutionId: "e", Status: "running"})
		})
	hs := newHistoryServiceWithStub(t, stub)
	got, err := hs.GetExecution("p1", "p", "e")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, "e", got.ExecutionId)
}

func TestHistoryService_GetExecution_NotFound(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodGet, "/api/v1/projects",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		})
	hs := newHistoryServiceWithStub(t, stub)
	_, err := hs.GetExecution("p", "pipe", "missing")
	require.Error(t, err)
}

func TestHistoryService_ListExecutions_Success(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodGet, "/api/v1/projects",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode([]*types.PipelineExecution{
				{ExecutionId: "e1"},
				{ExecutionId: "e2"},
			})
		})
	hs := newHistoryServiceWithStub(t, stub)
	got, err := hs.ListExecutions("p", "pipe")
	require.NoError(t, err)
	assert.Len(t, got, 2)
}

func TestHistoryService_UpdateExecution_Success(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodPut, "/api/v1/projects",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
	hs := newHistoryServiceWithStub(t, stub)
	require.NoError(t, hs.UpdateExecution(&types.PipelineExecution{
		ProjectId: "p", PipelineId: "pipe", ExecutionId: "e",
	}))
	require.Len(t, stub.requests, 1)
	assert.Equal(t, http.MethodPut, stub.requests[0].Method)
}

func TestHistoryService_UpdateExecution_PropagatesError(t *testing.T) {
	stub := newStubConfigService(t)
	stub.handle(http.MethodPut, "/api/v1/projects",
		func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		})
	hs := newHistoryServiceWithStub(t, stub)
	err := hs.UpdateExecution(&types.PipelineExecution{ProjectId: "p", PipelineId: "pipe", ExecutionId: "e"})
	require.Error(t, err)
}
