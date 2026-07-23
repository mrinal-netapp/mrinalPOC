package clients

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetResourceByName_Found(t *testing.T) {
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == resourcePath {
			_ = json.NewEncoder(w).Encode([]map[string]string{
				{"_id": "res-99", "name": "project:p1"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.GetResourceByName("project:p1")
	require.NoError(t, err)
	assert.Equal(t, "res-99", id)
}

func TestGetResourceByName_NotFoundInList(t *testing.T) {
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == resourcePath {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"_id": "x", "name": "other"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetResourceByName("project:missing")
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestGetResourceByName_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetResourceByName("project:p1")
	require.Error(t, err)
}

func TestCreateUserPolicy_409FetchesExisting(t *testing.T) {
	policyPath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/policy/user"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == policyPath {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if r.Method == http.MethodGet && r.URL.Query().Get("name") == "usr-u1-proj-p1-admin" {
			_ = json.NewEncoder(w).Encode([]PolicyInfo{{ID: "pol-existing", Name: "usr-u1-proj-p1-admin"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.CreateUserPolicy(types.KeycloakUserPolicy{Name: "usr-u1-proj-p1-admin", Users: []string{"u1"}})
	require.NoError(t, err)
	assert.Equal(t, "pol-existing", id)
}

func TestCreateScopePermission_409FetchesExisting(t *testing.T) {
	permPath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/permission/scope"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == permPath {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if r.Method == http.MethodGet && r.URL.Query().Get("name") == "perm-proj-p1-admin" {
			_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "perm-1", "name": "perm-proj-p1-admin"}})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.CreateScopePermission(types.KeycloakScopePermission{
		Name: "perm-proj-p1-admin", Scopes: []string{"admin"},
	})
	require.NoError(t, err)
	assert.Equal(t, "perm-1", id)
}

func TestGetPolicyByName_EmptyListNotFound(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode([]PolicyInfo{})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetPolicyByName("missing")
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestGetPolicyByName_BadJSON(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		_, _ = w.Write([]byte("not-json"))
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetPolicyByName("x")
	require.Error(t, err)
}

func TestDeletePolicy_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	require.Error(t, client.DeletePolicy("pol-1"))
}

func TestSplitOnSlashAndPathHelpers(t *testing.T) {
	assert.Equal(t, []string{"a", "b", "c"}, splitOnSlash("a/b/c"))
	assert.Equal(t, []string{"x"}, splitOnSlash("x"))
	assert.Nil(t, splitPath(""))
	assert.Equal(t, []string{"admin", "realms", "nemo"}, splitPath("/admin/realms/nemo"))
}

func TestConfigClient_AuthHeaderWarningStillSucceeds(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	sa, err := NewServiceAccountClientWithCredentials(dead.URL, "id", "secret")
	require.NoError(t, err)

	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects/p/pipelines/pipe", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.Pipeline{ID: "pipe", Name: "p"})
	})
	cc := s.client()
	cc.serviceAccountAuth = sa
	p, err := cc.GetPipeline("p", "pipe")
	require.NoError(t, err)
	require.NotNil(t, p)
}
