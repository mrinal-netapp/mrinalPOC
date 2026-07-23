package routes

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetRouteConfigClient_CachesSingleton(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(stub.Close)

	origFactory := routeConfigClientFactory
	routeConfigClientMu.Lock()
	routeConfigClient = nil
	routeConfigClientMu.Unlock()
	routeConfigClientFactory = func() *clients.ConfigClient {
		return clients.NewConfigClientWithHTTPClient(stub.URL, stub.Client())
	}
	t.Cleanup(func() {
		routeConfigClientFactory = origFactory
		routeConfigClientMu.Lock()
		routeConfigClient = nil
		routeConfigClientMu.Unlock()
	})

	c1 := getRouteConfigClient()
	c2 := getRouteConfigClient()
	require.Same(t, c1, c2)
}

func TestNewRouteConfigClient_UsesDefaultURL(t *testing.T) {
	t.Setenv("CONFIG_SERVICE_URL", "")
	cc := newRouteConfigClient()
	require.NotNil(t, cc)
}

func TestRequireProjectAdmin_NilClaims(t *testing.T) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", nil)
	assert.False(t, ok)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestRequireProjectAdmin_EmptyUserID(t *testing.T) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", &middleware.UserClaims{UserID: ""})
	assert.False(t, ok)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestRequireProjectAdmin_KcFactoryError(t *testing.T) {
	origFactory := routeKcClientFactory
	routeKcClientMu.Lock()
	routeKcClient = nil
	routeKcClientMu.Unlock()
	routeKcClientFactory = func() (*clients.KeycloakAuthzClient, error) {
		return nil, errors.New("keycloak not configured")
	}
	t.Cleanup(func() {
		routeKcClientFactory = origFactory
		routeKcClientMu.Lock()
		routeKcClient = nil
		routeKcClientMu.Unlock()
	})

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", testUserClaims())
	assert.False(t, ok)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestRequireProjectAdmin_PermissionLookupError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/realms/nemo/protocol/openid-connect/token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
		case r.Method == "GET" && r.URL.Query().Get("name") == "usr-00000000-0000-0000-0000-000000000001-proj-p1-admin":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":"pol-1","name":"usr-00000000-0000-0000-0000-000000000001-proj-p1-admin"}]`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	t.Cleanup(srv.Close)
	overrideKcClient(t, srv)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", testUserClaims())
	assert.False(t, ok)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}
