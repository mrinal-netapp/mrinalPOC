package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

// --- Helper to set/restore env vars for Keycloak authz ---

type envSnapshot struct {
	keys   []string
	values map[string]string
}

func saveEnv(keys []string) *envSnapshot {
	snap := &envSnapshot{keys: keys, values: make(map[string]string)}
	for _, k := range keys {
		snap.values[k] = os.Getenv(k)
	}
	return snap
}

func (s *envSnapshot) restore() {
	for _, k := range s.keys {
		if v := s.values[k]; v != "" {
			os.Setenv(k, v)
		} else {
			os.Unsetenv(k)
		}
	}
}

var keycloakEnvKeys = []string{
	"KEYCLOAK_INTERNAL_ISSUER",
	"KEYCLOAK_CLIENT_ID",
	"KEYCLOAK_CLIENT_SECRET",
	"KEYCLOAK_RESOURCE_SERVER_UUID",
	"CONFIG_SERVICE_URL",
}

// --- RegisterProjectResourceActivity tests ---

func TestRegisterProjectResourceActivity_MissingEnv(t *testing.T) {
	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
	os.Unsetenv("KEYCLOAK_CLIENT_ID")
	os.Unsetenv("KEYCLOAK_CLIENT_SECRET")
	os.Unsetenv("KEYCLOAK_RESOURCE_SERVER_UUID")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(RegisterProjectResourceActivity)

	input := types.RegisterProjectResourceInput{
		ProjectId:   "proj-1",
		OwnerUserId: "user-1",
	}
	_, err := env.ExecuteActivity(RegisterProjectResourceActivity, input)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "KEYCLOAK_INTERNAL_ISSUER")
}

func TestRegisterProjectResourceActivity_Success(t *testing.T) {
	// Mock Keycloak Admin Authz API: token endpoint + resource-server/resource
	resourceId := "kc-resource-uuid-123"
	tokenCalls := 0
	resourceCalls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			tokenCalls++
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
				"token_type":   "Bearer",
			})
		case strings.Contains(r.URL.Path, "/authz/resource-server/resource"):
			resourceCalls++
			assert.Equal(t, "POST", r.Method)

			var resource types.KeycloakResource
			err := json.NewDecoder(r.Body).Decode(&resource)
			require.NoError(t, err)
			assert.Equal(t, "project:proj-1", resource.Name)
			assert.Equal(t, "urn:agent-studio:resource-types:project", resource.Type)
			assert.Equal(t, []string{"/projects/proj-1"}, resource.URIs)
			assert.Len(t, resource.Scopes, 3)

			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"_id": resourceId})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "agent-studio-svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "test-secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid-456")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(RegisterProjectResourceActivity)

	input := types.RegisterProjectResourceInput{
		ProjectId:   "proj-1",
		OwnerUserId: "user-1",
	}
	val, err := env.ExecuteActivity(RegisterProjectResourceActivity, input)
	require.NoError(t, err)

	var result types.RegisterProjectResourceResult
	require.NoError(t, val.Get(&result))
	assert.Equal(t, resourceId, result.ResourceId)
	assert.Equal(t, 1, tokenCalls)
	assert.Equal(t, 1, resourceCalls)
}

func TestRegisterProjectResourceActivity_Idempotent409(t *testing.T) {
	resourceId := "existing-resource-id"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})
		case strings.Contains(r.URL.Path, "/authz/resource-server/resource"):
			if r.Method == "POST" {
				w.WriteHeader(http.StatusConflict)
				return
			}
			// GET by name returns the existing resource (Admin API shape)
			if r.Method == "GET" {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode([]map[string]string{
					{"_id": resourceId, "name": "project:proj-dup"},
				})
				return
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "uuid")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(RegisterProjectResourceActivity)

	input := types.RegisterProjectResourceInput{
		ProjectId:   "proj-dup",
		OwnerUserId: "user-1",
	}
	val, err := env.ExecuteActivity(RegisterProjectResourceActivity, input)
	require.NoError(t, err, "409 should be treated as success")

	var result types.RegisterProjectResourceResult
	require.NoError(t, val.Get(&result))
	assert.Equal(t, resourceId, result.ResourceId)
}

// --- PersistKeycloakResourceIdActivity tests ---

func TestPersistKeycloakResourceIdActivity_Success(t *testing.T) {
	var receivedBody map[string]interface{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})
		case strings.Contains(r.URL.Path, "/api/v1/projects/proj-1"):
			assert.Equal(t, "PUT", r.Method)
			json.NewDecoder(r.Body).Decode(&receivedBody)
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("CONFIG_SERVICE_URL", srv.URL)
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(PersistKeycloakResourceIdActivity)

	input := types.PersistKeycloakResourceIdInput{
		ProjectId:  "proj-1",
		ResourceId: "res-abc",
	}
	_, err := env.ExecuteActivity(PersistKeycloakResourceIdActivity, input)
	require.NoError(t, err)

	// Verify the metadata payload
	metadata, ok := receivedBody["metadata"].(map[string]interface{})
	require.True(t, ok, "expected metadata key in body")
	assert.Equal(t, "res-abc", metadata["keycloakResourceId"])
}

// --- GrantInitialAdminActivity tests ---

func TestGrantInitialAdminActivity_Success(t *testing.T) {
	policyCreated := false
	permissionCreated := false

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})
		case strings.Contains(r.URL.Path, "/policy/user") && r.Method == "POST":
			policyCreated = true
			var policy types.KeycloakUserPolicy
			json.NewDecoder(r.Body).Decode(&policy)
			assert.Equal(t, "usr-owner-1-proj-proj-1-admin", policy.Name)
			assert.Equal(t, []string{"owner-1"}, policy.Users)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "policy-id-1"})
		case strings.Contains(r.URL.Path, "/permission/scope") && r.Method == "POST":
			permissionCreated = true
			var perm types.KeycloakScopePermission
			json.NewDecoder(r.Body).Decode(&perm)
			assert.Equal(t, "perm-proj-proj-1-admin", perm.Name)
			assert.Equal(t, []string{"admin"}, perm.Scopes)
			assert.Contains(t, perm.Policies, "usr-owner-1-proj-proj-1-admin")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "perm-id-1"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantInitialAdminActivity)

	input := types.GrantInitialAdminInput{
		ProjectId:   "proj-1",
		OwnerUserId: "owner-1",
	}
	_, err := env.ExecuteActivity(GrantInitialAdminActivity, input)
	require.NoError(t, err)
	assert.True(t, policyCreated, "user policy should have been created")
	assert.True(t, permissionCreated, "scope permission should have been created")
}

// --- DeleteProjectResourceActivity tests ---

func TestDeleteProjectResourceActivity_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})
		case strings.Contains(r.URL.Path, "/authz/resource-server/resource"):
			// Resource not found by name (Admin API returns empty array of objects)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]map[string]string{})
		case strings.Contains(r.URL.Path, "/policy"):
			// No policies exist for a non-existent project
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]interface{}{})
		case strings.Contains(r.URL.Path, "/permission"):
			// No permissions exist for a non-existent project
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]interface{}{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteProjectResourceActivity)

	input := types.DeleteProjectResourceInput{ProjectId: "nonexistent-proj"}
	_, err := env.ExecuteActivity(DeleteProjectResourceActivity, input)
	// Should succeed (idempotent: resource not found = already deleted)
	require.NoError(t, err)
}

func TestDeleteProjectResourceActivity_FullCleanup(t *testing.T) {
	deletedPermissions := []string{}
	deletedResource := ""

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})
		case strings.Contains(r.URL.Path, "/authz/resource-server/resource"):
			if r.Method == "GET" && strings.Contains(r.URL.RawQuery, "name=") {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode([]map[string]string{
					{"_id": "res-id-1", "name": "project:test-proj"},
				})
				return
			}
			if r.Method == "DELETE" {
				deletedResource = "res-id-1"
				w.WriteHeader(http.StatusNoContent)
				return
			}
		case strings.Contains(r.URL.Path, "/permission") && r.Method == "GET":
			// Return a permission for admin scope
			if strings.Contains(r.URL.RawQuery, "admin") {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode([]map[string]string{
					{"id": "perm-admin-id", "name": "perm-proj-test-proj-admin"},
				})
				return
			}
			// No permissions for member/viewer
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]map[string]string{})
		case strings.Contains(r.URL.Path, "/permission/scope/") && r.Method == "DELETE":
			permId := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			deletedPermissions = append(deletedPermissions, permId)
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(r.URL.Path, "/policy") && r.Method == "GET":
			// No policies found (simplified)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]map[string]string{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	snap := saveEnv(keycloakEnvKeys)
	defer snap.restore()

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srv.URL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid")

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteProjectResourceActivity)

	input := types.DeleteProjectResourceInput{ProjectId: "test-proj"}
	_, err := env.ExecuteActivity(DeleteProjectResourceActivity, input)
	require.NoError(t, err)
	assert.Contains(t, deletedPermissions, "perm-admin-id")
	assert.Equal(t, "res-id-1", deletedResource)
}
