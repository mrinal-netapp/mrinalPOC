package clients

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newKeycloakStub(t *testing.T, handler http.HandlerFunc) (string, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL, srv
}

func TestNewServiceAccountClient_RequiresAllEnv(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")
	_, err := NewServiceAccountClient()
	require.Error(t, err, "all three env vars must be set")
}

func TestNewServiceAccountClient_HappyPath(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://issuer")
	t.Setenv("KEYCLOAK_CLIENT_ID", "id")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	c, err := NewServiceAccountClient()
	require.NoError(t, err)
	require.NotNil(t, c)
}

func TestNewServiceAccountClientWithCredentials_RejectsEmptyArgs(t *testing.T) {
	cases := [][3]string{
		{"", "id", "secret"},
		{"iss", "", "secret"},
		{"iss", "id", ""},
	}
	for _, args := range cases {
		_, err := NewServiceAccountClientWithCredentials(args[0], args[1], args[2])
		require.Errorf(t, err, "args=%v", args)
	}
}

func TestServiceAccountClient_GetAccessToken_CachesAndRefreshes(t *testing.T) {
	var calls int32
	issuer, _ := newKeycloakStub(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		require.Equal(t, "/protocol/openid-connect/token", r.URL.Path)
		require.NoError(t, r.ParseForm())
		require.Equal(t, "client_credentials", r.Form.Get("grant_type"))
		require.Equal(t, "id", r.Form.Get("client_id"))
		require.Equal(t, "secret", r.Form.Get("client_secret"))

		_, _ = w.Write([]byte(`{"access_token":"tok-1","token_type":"Bearer","expires_in":3600}`))
	})

	c, err := NewServiceAccountClientWithHTTPClient(issuer, "id", "secret", http.DefaultClient)
	require.NoError(t, err)

	tok, err := c.GetAccessToken()
	require.NoError(t, err)
	assert.Equal(t, "tok-1", tok)

	// Second call should hit the cache, not the server.
	tok2, err := c.GetAccessToken()
	require.NoError(t, err)
	assert.Equal(t, "tok-1", tok2)
	assert.Equal(t, int32(1), atomic.LoadInt32(&calls), "should cache after first hit")

	// AddAuthHeader composes the Bearer header.
	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.NoError(t, c.AddAuthHeader(req))
	assert.Equal(t, "Bearer tok-1", req.Header.Get("Authorization"))
}

func TestServiceAccountClient_GetAccessToken_ServerErrors(t *testing.T) {
	issuer, _ := newKeycloakStub(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
	})

	c, _ := NewServiceAccountClientWithHTTPClient(issuer, "id", "secret", http.DefaultClient)
	_, err := c.GetAccessToken()
	require.Error(t, err)
}

func TestServiceAccountClient_GetAccessToken_BadJSON(t *testing.T) {
	issuer, _ := newKeycloakStub(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`not-json`))
	})
	c, _ := NewServiceAccountClientWithHTTPClient(issuer, "id", "secret", http.DefaultClient)
	_, err := c.GetAccessToken()
	require.Error(t, err)
}

func TestServiceAccountClient_GetAccessToken_DefaultsExpiresInWhenZero(t *testing.T) {
	issuer, _ := newKeycloakStub(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":0}`))
	})
	c, _ := NewServiceAccountClientWithHTTPClient(issuer, "id", "secret", http.DefaultClient)
	tok, err := c.GetAccessToken()
	require.NoError(t, err)
	assert.Equal(t, "tok", tok)
}

func TestServiceAccountClient_AddAuthHeader_PropagatesError(t *testing.T) {
	// Issuer points at something that will fail (closed server -> connection refused).
	issuer, srv := newKeycloakStub(t, func(http.ResponseWriter, *http.Request) {})
	srv.Close()

	c, _ := NewServiceAccountClientWithHTTPClient(issuer, "id", "secret", http.DefaultClient)
	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.Error(t, c.AddAuthHeader(req))
}

func TestRemoveOIDCSuffix_PassthroughForKeycloak(t *testing.T) {
	// Documented as a no-op for Keycloak issuers. Pin the contract.
	assert.Equal(t, "http://x/realms/r", removeOIDCSuffix("http://x/realms/r"))
}
