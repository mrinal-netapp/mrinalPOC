package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewRouteKeycloakClient_MissingEnv(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")
	t.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "")
	_, err := newRouteKeycloakClient()
	require.Error(t, err)
}

func TestNewRouteKeycloakClient_UsesAuthzCredentials(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "t", "expires_in": 3600, "token_type": "Bearer",
			})
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	t.Setenv("KEYCLOAK_AUTHZ_CLIENT_ID", "authz-id")
	t.Setenv("KEYCLOAK_AUTHZ_CLIENT_SECRET", "authz-secret")
	t.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid-test")

	kc, err := newRouteKeycloakClient()
	require.NoError(t, err)
	require.NotNil(t, kc)
}

func TestGetRouteKeycloakClient_CachesSingleton(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	c1, err := getRouteKeycloakClient()
	require.NoError(t, err)
	c2, err := getRouteKeycloakClient()
	require.NoError(t, err)
	require.Same(t, c1, c2)
}

func TestCheckExistingRoleConflict_AllowsWhenNoConflict(t *testing.T) {
	srv := fakeKeycloakServerWithOpts(t, fakeKCServerOpts{adminPolicyExists: true})
	defer srv.Close()
	overrideKcClient(t, srv)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := checkExistingRoleConflict(c, "p1", "u2", "member")
	assert.True(t, ok)
}

func TestCheckExistingRoleConflict_Returns409OnDifferentRole(t *testing.T) {
	srv := fakeKeycloakServerWithOpts(t, fakeKCServerOpts{
		adminPolicyExists: true,
		memberPolicies: []map[string]string{
			{"id": "pol-viewer", "name": "usr-u2-proj-p1-viewer"},
		},
	})
	defer srv.Close()
	overrideKcClient(t, srv)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := checkExistingRoleConflict(c, "p1", "u2", "member")
	assert.False(t, ok)
	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestCheckExistingRoleConflict_KcClientError(t *testing.T) {
	origFactory := routeKcClientFactory
	routeKcClientMu.Lock()
	routeKcClient = nil
	routeKcClientMu.Unlock()
	routeKcClientFactory = func() (*clients.KeycloakAuthzClient, error) {
		return nil, errors.New("kc down")
	}
	t.Cleanup(func() {
		routeKcClientFactory = origFactory
		routeKcClientMu.Lock()
		routeKcClient = nil
		routeKcClientMu.Unlock()
	})

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := checkExistingRoleConflict(c, "p1", "u1", "admin")
	assert.False(t, ok)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestResolveMemberEmail_DefaultResolveOnly(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/internal/users/resolve" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"resolved": []map[string]interface{}{{"email": "a@b.com", "userId": "u-res"}},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
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

	uid, created, err := resolveMemberEmail("a@b.com", false)
	require.NoError(t, err)
	assert.Equal(t, "u-res", uid)
	assert.False(t, created)
}

func TestRequireProjectAdmin_Success(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", testUserClaims())
	assert.True(t, ok)
}

func TestRequireProjectAdmin_NotAdmin(t *testing.T) {
	srv := fakeKeycloakServer(t, false)
	defer srv.Close()
	overrideKcClient(t, srv)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ok := requireProjectAdmin(c, "p1", testUserClaims())
	assert.False(t, ok)
	assert.Equal(t, http.StatusForbidden, w.Code)
}
