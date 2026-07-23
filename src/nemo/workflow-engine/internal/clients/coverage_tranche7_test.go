package clients

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateResource_409LookupFails(t *testing.T) {
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == resourcePath {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == resourcePath {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.CreateResource(types.KeycloakResource{Name: "project:p1"})
	require.Error(t, err)
}

func TestGetScopePermission_NotFound(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetScopePermission("missing")
	require.Error(t, err)
}

func TestGetScopePermission_BadJSON(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		_, _ = w.Write([]byte("not-json"))
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetScopePermission("perm-1")
	require.Error(t, err)
}

func TestUpdateScopePermission_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	err := client.UpdateScopePermission("perm-1", types.KeycloakScopePermission{Name: "x"})
	require.Error(t, err)
}

func TestCreateUserPolicy_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.CreateUserPolicy(types.KeycloakUserPolicy{Name: "pol"})
	require.Error(t, err)
}

func TestCreateScopePermission_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.CreateScopePermission(types.KeycloakScopePermission{Name: "perm"})
	require.Error(t, err)
}

func TestGetPolicyByName_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetPolicyByName("pol")
	require.Error(t, err)
}

func TestConfigClient_ResolveUsers_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().ResolveUsers([]string{"a@b.com"})
	require.Error(t, err)
}

func TestConfigClient_ListProjectsForVKRotation_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/internal/projects/gateway-rotation-targets", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().ListProjectsForVKRotation()
	require.Error(t, err)
}

func TestConfigClient_RotateProjectVirtualKey_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().RotateProjectVirtualKey("p1")
	require.Error(t, err)
}

func TestConfigClient_CompleteProjectVirtualKeyRotation_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate-complete", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().CompleteProjectVirtualKeyRotation("p1")
	require.Error(t, err)
}

func TestConfigClient_GetBucketRouting_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/buckets", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().GetBucketRouting("p", "b")
	require.Error(t, err)
}

func TestConfigClient_GetProjectServiceAccount_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/projects", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().GetProjectServiceAccount("p")
	require.Error(t, err)
}

func TestLakekeeperClient_CreateNamespace_Error(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	require.Error(t, s.client().CreateNamespace(types.CreateNamespaceRequest{
		WarehouseId: "wh-1", Namespace: []string{"ns"},
	}))
}

func TestLakekeeperClient_GetTable_NotFound(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"tables": []interface{}{}})
	})
	_, err := s.client().GetTable("wh-1", "ns", "missing")
	require.Error(t, err)
}

func TestLakekeeperClient_ListTables_BadJSON(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().ListTables("wh-1", "ns")
	require.Error(t, err)
}

func TestLakekeeperClient_DeleteTable_Error(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodDelete, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().DeleteTable("wh-1", "ns", "tbl"))
}

func TestLakekeeperClient_DeleteNamespace_Error(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodDelete, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().DeleteNamespace("wh-1", "ns"))
}

func TestNewKeycloakAuthzClient_InvalidIssuer(t *testing.T) {
	_, err := NewKeycloakAuthzClient("", "id", "secret", "uuid")
	require.Error(t, err)
}

func TestExtractBaseFromIssuer_Invalid(t *testing.T) {
	assert.Equal(t, "://", extractBaseFromIssuer("invalid"))
}
