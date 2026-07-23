package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newKBVersionsRouter(t *testing.T) (*gin.Engine, *configStub) {
	t.Helper()
	stub := newConfigStub(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	r := gin.New()
	api := r.Group("/api/v1")
	SetupKBVersionsRoutes(api, cc)
	return r, stub
}

func TestContainsCaseInsensitive(t *testing.T) {
	assert.True(t, containsCaseInsensitive("Error: NOT FOUND", "not found"))
	assert.True(t, containsCaseInsensitive("plain", ""))
	assert.False(t, containsCaseInsensitive("short", "longer"))
	assert.False(t, containsCaseInsensitive("", "x"))
}

func TestIsNotFoundError(t *testing.T) {
	assert.False(t, isNotFoundError(nil))
	assert.True(t, isNotFoundError(errString("target version not found")))
	assert.False(t, isNotFoundError(errString("permission denied")))
}

type errString string

func (e errString) Error() string { return string(e) }

func stubKBStorageRoutes(stub *configStub) {
	stub.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/projects/p/knowledgebases/kb1" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"bucketName": "kb-bucket"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": "projects/p"})
	})
}

func TestRoute_ListKBVersions_ConfigResolveFails(t *testing.T) {
	r, stub := newKBVersionsRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/projects/p/knowledgebases/missing" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"home_dir": "b"})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/knowledgebases/missing/versions", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadGateway, w.Code)
}

func TestRoute_ListKBVersions_S3CredentialsMissing(t *testing.T) {
	r, stub := newKBVersionsRouter(t)
	stubKBStorageRoutes(stub)
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/knowledgebases/kb1/versions", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRoute_RollbackKBVersion_ConfigResolveFails(t *testing.T) {
	r, stub := newKBVersionsRouter(t)
	stub.on(http.MethodGet, "/api/v1/projects/p", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/p/knowledgebases/kb1/versions/lancedb-run-abc/rollback", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadGateway, w.Code)
}

func TestRoute_RollbackKBVersion_S3CredentialsMissing(t *testing.T) {
	r, stub := newKBVersionsRouter(t)
	stubKBStorageRoutes(stub)
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/projects/p/knowledgebases/kb1/versions/lancedb-run-abc/rollback", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}
