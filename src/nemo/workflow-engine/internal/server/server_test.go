package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/mocks"
)

// TestServer_HealthEndpoint exercises the bootstrap path of NewServer +
// the unauthenticated /health and /metrics endpoints.
func TestServer_HealthEndpoint(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	mt := &mocks.Client{}
	cc := clients.NewConfigClientWithHTTPClient("http://127.0.0.1:1", http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)

	mr := miniredis.RunT(t)
	t.Cleanup(func() { mr.Close() })
	ec, err := cache.NewExplorerListCache("redis://"+mr.Addr()+"/0", 100, 60)
	require.NoError(t, err)

	progress := services.NewProgressStore()

	srv := NewServer("0", executor, hs, ec, progress)
	require.NotNil(t, srv)

	// Use the server's underlying http.Handler against httptest. We do not
	// call srv.Start() (which would block on ListenAndServe).
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	srv.httpServer.Handler.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	// /metrics should be accessible without auth too.
	mw := httptest.NewRecorder()
	mreq := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	srv.httpServer.Handler.ServeHTTP(mw, mreq)
	assert.Equal(t, http.StatusOK, mw.Code)
}

func TestServer_Shutdown(t *testing.T) {
	mt := &mocks.Client{}
	cc := clients.NewConfigClientWithHTTPClient("http://127.0.0.1:1", http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)
	progress := services.NewProgressStore()

	srv := NewServer("0", executor, hs, nil, progress)

	// http.Server.Shutdown is safe to call even when Serve / ListenAndServe
	// was never invoked — no goroutine + sleep dance required (avoids a
	// flaky race against the OS bind step under load).
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	require.NoError(t, srv.Shutdown(ctx))
}
