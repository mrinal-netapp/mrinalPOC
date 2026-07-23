package clients

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// withKeycloakStub spins up an httptest server that issues tokens at /protocol/openid-connect/token
// and points env vars at it so NewServiceAccountClient + clients pick it up.
func withKeycloakStub(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/protocol/openid-connect/token") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":3600}`))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestNewLakekeeperClient_PicksUpLakekeeperCredentials(t *testing.T) {
	issuer := withKeycloakStub(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_CLIENT_ID", "wf")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "wf-secret")
	t.Setenv("LAKEKEEPER_CLIENT_ID", "lk")
	t.Setenv("LAKEKEEPER_CLIENT_SECRET", "lk-secret")

	c := NewLakekeeperClient("http://example")
	require.NotNil(t, c)
	require.NotNil(t, c.serviceAccountAuth, "primary auth must be wired with lakekeeper credentials")
	require.NotNil(t, c.fallbackAuth, "workflow-engine fallback must also be wired")
}

func TestNewLakekeeperClient_OnlyWorkflowEngineCreds_FallsBackToWFE(t *testing.T) {
	issuer := withKeycloakStub(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_CLIENT_ID", "wf")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "wf-secret")
	t.Setenv("LAKEKEEPER_CLIENT_ID", "")
	t.Setenv("LAKEKEEPER_CLIENT_SECRET", "")

	c := NewLakekeeperClient("http://example")
	require.NotNil(t, c)
	require.NotNil(t, c.serviceAccountAuth)
	require.Nil(t, c.fallbackAuth, "without lakekeeper-specific creds, primary IS workflow-engine")
}

func TestNewLakekeeperClient_PartialLakekeeperCreds_LogsAndContinuesWithoutAuth(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")
	t.Setenv("LAKEKEEPER_CLIENT_ID", "lk")
	t.Setenv("LAKEKEEPER_CLIENT_SECRET", "")

	c := NewLakekeeperClient("http://example")
	require.NotNil(t, c)
	require.Nil(t, c.serviceAccountAuth, "partial creds + no internal issuer => no auth")
}

func TestLakekeeperClient_AddAuthHeader_PrimarySucceeds(t *testing.T) {
	issuer := withKeycloakStub(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_CLIENT_ID", "wf")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	t.Setenv("LAKEKEEPER_CLIENT_ID", "lk")
	t.Setenv("LAKEKEEPER_CLIENT_SECRET", "secret")

	c := NewLakekeeperClient("http://example")
	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.NoError(t, c.addAuthHeader(req))
	require.NotEmpty(t, req.Header.Get("Authorization"))
}

func TestLakekeeperClient_AddAuthHeader_FallbackKicksIn(t *testing.T) {
	// Primary issuer points at a non-existent server (refused), fallback points
	// at a working one. Auth header must end up populated via fallback path.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close() // closed -> connection refused on primary

	good := withKeycloakStub(t)

	// primary uses dead issuer, fallback uses live KEYCLOAK_INTERNAL_ISSUER via NewServiceAccountClient
	primary, err := NewServiceAccountClientWithCredentials(dead.URL, "primary", "secret")
	require.NoError(t, err)
	fallback, err := NewServiceAccountClientWithCredentials(good, "fallback", "secret")
	require.NoError(t, err)

	c := &LakekeeperClient{
		baseURL:            "http://example",
		httpClient:         &http.Client{},
		serviceAccountAuth: primary,
		fallbackAuth:       fallback,
	}
	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.NoError(t, c.addAuthHeader(req))
	require.NotEmpty(t, req.Header.Get("Authorization"))
}

func TestLakekeeperClient_AddAuthHeader_BothFail(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()

	primary, err := NewServiceAccountClientWithCredentials(dead.URL, "id", "secret")
	require.NoError(t, err)
	fallback, err := NewServiceAccountClientWithCredentials(dead.URL, "id", "secret")
	require.NoError(t, err)

	c := &LakekeeperClient{
		baseURL:            "http://example",
		httpClient:         &http.Client{},
		serviceAccountAuth: primary,
		fallbackAuth:       fallback,
	}
	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.Error(t, c.addAuthHeader(req))
}

func TestConfigClient_AddAuthHeader_WithSAClient(t *testing.T) {
	issuer := withKeycloakStub(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_CLIENT_ID", "id")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	cc := NewConfigClient("http://example")
	require.NotNil(t, cc.serviceAccountAuth)

	req, _ := http.NewRequest(http.MethodGet, "http://example/", nil)
	require.NoError(t, cc.addAuthHeader(req))
	require.NotEmpty(t, req.Header.Get("Authorization"))
}
