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

func newTestServer(handler http.HandlerFunc) *httptest.Server {
	return httptest.NewServer(handler)
}

func newTestClient(t *testing.T, srvURL string) *KeycloakAuthzClient {
	t.Helper()
	client, err := NewKeycloakAuthzClient(
		srvURL+"/realms/nemo",
		"test-client",
		"test-secret",
		"client-uuid-123",
	)
	require.NoError(t, err)
	return client
}

// tokenHandler returns a standard token response
func tokenHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"access_token": "test-token",
		"expires_in":   3600,
		"token_type":   "Bearer",
	})
}

func TestCreateResource_Success(t *testing.T) {
	resourceId := "new-resource-id"
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "POST" && r.URL.Path == resourcePath {
			var resource types.KeycloakResource
			json.NewDecoder(r.Body).Decode(&resource)
			assert.Equal(t, "project:test-proj", resource.Name)
			assert.Equal(t, "urn:agent-studio:resource-types:project", resource.Type)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"_id": resourceId})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	resource := types.KeycloakResource{
		Name: "project:test-proj",
		Type: "urn:agent-studio:resource-types:project",
		URIs: []string{"/projects/test-proj"},
		Scopes: []types.KeycloakScope{
			{Name: "admin"}, {Name: "member"}, {Name: "viewer"},
		},
	}

	id, err := client.CreateResource(resource)
	require.NoError(t, err)
	assert.Equal(t, resourceId, id)
}

func TestCreateResource_409_FetchesByName(t *testing.T) {
	existingId := "existing-id"
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "POST" && r.URL.Path == resourcePath {
			w.WriteHeader(http.StatusConflict)
			return
		}
		if r.Method == "GET" && r.URL.Path == resourcePath {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]map[string]string{
				{"_id": existingId, "name": "project:dup"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.CreateResource(types.KeycloakResource{Name: "project:dup"})
	require.NoError(t, err)
	assert.Equal(t, existingId, id)
}

func TestDeleteResource_Success(t *testing.T) {
	deleted := false
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "DELETE" {
			deleted = true
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	err := client.DeleteResource("resource-to-delete")
	require.NoError(t, err)
	assert.True(t, deleted)
}

func TestDeleteResource_404_Idempotent(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	err := client.DeleteResource("already-deleted")
	require.NoError(t, err) // 404 is success for delete
}

func TestCreateUserPolicy_Success(t *testing.T) {
	policyId := "policy-uuid-1"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/policy/user" {
			var policy types.KeycloakUserPolicy
			json.NewDecoder(r.Body).Decode(&policy)
			assert.Equal(t, "usr-user1-proj-p1-admin", policy.Name)
			assert.Equal(t, []string{"user1"}, policy.Users)
			assert.Equal(t, "POSITIVE", policy.Logic)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": policyId})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	policy := types.KeycloakUserPolicy{
		Name:  "usr-user1-proj-p1-admin",
		Users: []string{"user1"},
	}

	id, err := client.CreateUserPolicy(policy)
	require.NoError(t, err)
	assert.Equal(t, policyId, id)
}

func TestCreateScopePermission_Success(t *testing.T) {
	permId := "perm-uuid-1"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/permission/scope" {
			var perm types.KeycloakScopePermission
			json.NewDecoder(r.Body).Decode(&perm)
			assert.Equal(t, "perm-proj-p1-admin", perm.Name)
			assert.Equal(t, []string{"admin"}, perm.Scopes)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": permId})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	perm := types.KeycloakScopePermission{
		Name:     "perm-proj-p1-admin",
		Scopes:   []string{"admin"},
		Policies: []string{"usr-user1-proj-p1-admin"},
	}

	id, err := client.CreateScopePermission(perm)
	require.NoError(t, err)
	assert.Equal(t, permId, id)
}

func TestGetScopePermission_Success(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/permission/scope/perm-id-1" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(types.KeycloakScopePermission{
				ID:       "perm-id-1",
				Name:     "perm-proj-p1-admin",
				Scopes:   []string{"admin"},
				Policies: []string{"policy-1", "policy-2"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	perm, err := client.GetScopePermission("perm-id-1")
	require.NoError(t, err)
	assert.Equal(t, "perm-proj-p1-admin", perm.Name)
	assert.Equal(t, []string{"policy-1", "policy-2"}, perm.Policies)
}

func TestUpdateScopePermission_Success(t *testing.T) {
	updated := false
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "PUT" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/permission/scope/perm-id-1" {
			updated = true
			var perm types.KeycloakScopePermission
			json.NewDecoder(r.Body).Decode(&perm)
			assert.Contains(t, perm.Policies, "policy-1")
			assert.Contains(t, perm.Policies, "policy-new")
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	perm := types.KeycloakScopePermission{
		Name:     "perm-proj-p1-admin",
		Policies: []string{"policy-1", "policy-new"},
	}
	err := client.UpdateScopePermission("perm-id-1", perm)
	require.NoError(t, err)
	assert.True(t, updated)
}

func TestDeletePermission_Success(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	err := client.DeletePermission("perm-to-delete")
	require.NoError(t, err)
}

func TestDeletePermission_404_Idempotent(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	err := client.DeletePermission("already-gone")
	require.NoError(t, err)
}

// --- Helper function tests ---

func TestExtractRealmFromIssuer(t *testing.T) {
	tests := []struct {
		issuer string
		want   string
	}{
		{"http://keycloak:8080/realms/nemo", "nemo"},
		{"http://keycloak:8080/realms/agent-studio", "agent-studio"},
		{"http://keycloak:8080/realms/test/extra", "test"},
		{"invalid", "nemo"}, // fallback
	}

	for _, tt := range tests {
		t.Run(tt.issuer, func(t *testing.T) {
			got := extractRealmFromIssuer(tt.issuer)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestExtractBaseFromIssuer(t *testing.T) {
	tests := []struct {
		issuer string
		want   string
	}{
		{"http://keycloak:8080/realms/nemo", "http://keycloak:8080"},
		{"https://auth.example.com/realms/prod", "https://auth.example.com"},
	}

	for _, tt := range tests {
		t.Run(tt.issuer, func(t *testing.T) {
			got := extractBaseFromIssuer(tt.issuer)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestListPolicies_Success(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/policy" {
			assert.Equal(t, "user", r.URL.Query().Get("type"))
			assert.Equal(t, "true", r.URL.Query().Get("search"))
			assert.Contains(t, r.URL.Query().Get("name"), "usr-")

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]PolicyInfo{
				{ID: "pol-1", Name: "usr-user1-proj-p1-admin", Type: "user"},
				{ID: "pol-2", Name: "usr-user2-proj-p1-member", Type: "user"},
				{ID: "pol-3", Name: "usr-user1-proj-p2-viewer", Type: "user"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	policies, err := client.ListPolicies("usr-", 200)
	require.NoError(t, err)
	assert.Len(t, policies, 3)
	assert.Equal(t, "usr-user1-proj-p1-admin", policies[0].Name)
	assert.Equal(t, "pol-1", policies[0].ID)
}

func TestListPolicies_NarrowPrefix(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/policy" {
			nameParam := r.URL.Query().Get("name")
			assert.Equal(t, "usr-user1-proj-", nameParam)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]PolicyInfo{
				{ID: "pol-1", Name: "usr-user1-proj-p1-admin", Type: "user"},
				{ID: "pol-3", Name: "usr-user1-proj-p2-viewer", Type: "user"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	policies, err := client.ListPolicies("usr-user1-proj-", 500)
	require.NoError(t, err)
	assert.Len(t, policies, 2)
}

func TestListPolicies_EmptyResult(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/policy" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]PolicyInfo{})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	policies, err := client.ListPolicies("usr-nobody-proj-", 200)
	require.NoError(t, err)
	assert.Len(t, policies, 0)
}

func TestListPolicies_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.ListPolicies("usr-", 200)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "status 500")
}
