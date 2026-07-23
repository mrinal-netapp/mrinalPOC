package activities

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

// fakeGrantServer stubs the Keycloak endpoints used by GrantProjectRoleActivity.
type fakeGrantServer struct {
	t                  *testing.T
	existingPolicies   []clients.PolicyInfo
	permissionExists   bool
	existingPermPols   []string
	createPolicyCalled bool
	createPermCalled   bool
	updatePermCalled   bool
}

func (f *fakeGrantServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
				"token_type":   "Bearer",
			})

		// ListPolicies: GET /policy?type=user&name=...&search=true
		case strings.Contains(r.URL.Path, "/authz/resource-server/policy") &&
			r.Method == "GET" &&
			r.URL.Query().Get("search") == "true":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(f.existingPolicies)

		// GetPolicyByName: GET /policy?name=... (no search=true)
		case strings.Contains(r.URL.Path, "/associatedPolicies") && r.Method == "GET":
			w.Header().Set("Content-Type", "application/json")
			assoc := make([]map[string]string, 0, len(f.existingPermPols))
			for _, name := range f.existingPermPols {
				assoc = append(assoc, map[string]string{"name": name})
			}
			json.NewEncoder(w).Encode(assoc)

		case strings.Contains(r.URL.Path, "/authz/resource-server/policy") &&
			r.Method == "GET" &&
			r.URL.Query().Get("name") != "":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(f.existingPolicies)

		// CreateUserPolicy: POST /policy/user
		case strings.Contains(r.URL.Path, "/policy/user") && r.Method == "POST":
			f.createPolicyCalled = true
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "new-policy-id"})

		// GetPermissionByName: GET /permission/scope?name=...
		case strings.Contains(r.URL.Path, "/permission/scope") &&
			r.Method == "GET" &&
			r.URL.Query().Get("name") != "":
			w.Header().Set("Content-Type", "application/json")
			if f.permissionExists {
				json.NewEncoder(w).Encode([]map[string]string{
					{"id": "perm-id-1", "name": r.URL.Query().Get("name")},
				})
			} else {
				w.WriteHeader(http.StatusNotFound)
			}

		// GetScopePermission: GET /permission/scope/{id} — Keycloak omits policies here.
		case strings.Contains(r.URL.Path, "/permission/scope/perm-id-1") && r.Method == "GET":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(types.KeycloakScopePermission{
				ID:   "perm-id-1",
				Name: "perm-existing",
			})

		// UpdateScopePermission: PUT /permission/scope/{id}
		case strings.Contains(r.URL.Path, "/permission/scope/perm-id-1") && r.Method == "PUT":
			f.updatePermCalled = true
			var perm types.KeycloakScopePermission
			json.NewDecoder(r.Body).Decode(&perm)
			f.existingPermPols = perm.Policies
			w.WriteHeader(http.StatusOK)

		// CreateScopePermission: POST /permission/scope
		case strings.Contains(r.URL.Path, "/permission/scope") && r.Method == "POST":
			f.createPermCalled = true
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "perm-id-new"})

		default:
			f.t.Logf("unhandled request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func setupKeycloakEnv(t *testing.T, srvURL string) {
	t.Helper()
	snap := saveEnv(keycloakEnvKeys)
	t.Cleanup(snap.restore)

	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", srvURL+"/realms/nemo")
	os.Setenv("KEYCLOAK_CLIENT_ID", "svc-config")
	os.Setenv("KEYCLOAK_CLIENT_SECRET", "secret")
	os.Setenv("KEYCLOAK_RESOURCE_SERVER_UUID", "client-uuid")
}

// --- parsePolicyRole unit tests ---

func TestParsePolicyRole(t *testing.T) {
	tests := []struct {
		name      string
		policy    string
		userId    string
		projectId string
		want      string
	}{
		{"admin role", "usr-u1-proj-p1-admin", "u1", "p1", "admin"},
		{"member role", "usr-u1-proj-p1-member", "u1", "p1", "member"},
		{"viewer role", "usr-u1-proj-p1-viewer", "u1", "p1", "viewer"},
		{"wrong user", "usr-u2-proj-p1-admin", "u1", "p1", ""},
		{"wrong project", "usr-u1-proj-p2-admin", "u1", "p1", ""},
		{"no match", "something-else", "u1", "p1", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParsePolicyRole(tt.policy, tt.userId, tt.projectId)
			assert.Equal(t, tt.want, got)
		})
	}
}

// --- GrantProjectRoleActivity conflict tests ---

func TestGrantProjectRoleActivity_ConflictDifferentRole(t *testing.T) {
	fake := &fakeGrantServer{
		t: t,
		existingPolicies: []clients.PolicyInfo{
			{ID: "pol-1", Name: "usr-user1-proj-proj1-viewer"},
		},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)

	input := types.ProjectMembershipInput{
		ProjectId: "proj1",
		UserId:    "user1",
		Role:      "admin",
	}
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, input)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "viewer")
	assert.Contains(t, err.Error(), "change-role endpoint")

	var appErr *temporal.ApplicationError
	require.True(t, errors.As(err, &appErr), "expected temporal.ApplicationError")
	assert.Equal(t, ErrAlreadyAssignedDifferentRole, appErr.Type())
	assert.True(t, appErr.NonRetryable())

	assert.False(t, fake.createPolicyCalled, "CreateUserPolicy should not be called on conflict")
}

func TestGrantProjectRoleActivity_SameRoleIdempotent(t *testing.T) {
	fake := &fakeGrantServer{
		t: t,
		existingPolicies: []clients.PolicyInfo{
			{ID: "pol-1", Name: "usr-user1-proj-proj1-admin"},
		},
		permissionExists: true,
		existingPermPols: []string{"usr-user1-proj-proj1-admin"},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)

	input := types.ProjectMembershipInput{
		ProjectId: "proj1",
		UserId:    "user1",
		Role:      "admin",
	}
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, input)
	require.NoError(t, err, "same role should be idempotent no-op")
}

func TestGrantProjectRoleActivity_NoPoliciesHappyPath(t *testing.T) {
	fake := &fakeGrantServer{
		t:                t,
		existingPolicies: []clients.PolicyInfo{},
		permissionExists: false,
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)

	input := types.ProjectMembershipInput{
		ProjectId: "proj1",
		UserId:    "user1",
		Role:      "member",
	}
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, input)
	require.NoError(t, err)
	assert.True(t, fake.createPolicyCalled, "should create policy")
	assert.True(t, fake.createPermCalled, "should create permission")
}

func TestGrantProjectRoleActivity_MergesSecondAdminIntoExistingPermission(t *testing.T) {
	fake := &fakeGrantServer{
		t: t,
		existingPolicies: []clients.PolicyInfo{
			{ID: "pol-1", Name: "usr-user1-proj-proj1-admin"},
		},
		permissionExists: true,
		existingPermPols: []string{"usr-user1-proj-proj1-admin"},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)

	input := types.ProjectMembershipInput{
		ProjectId: "proj1",
		UserId:    "user2",
		Role:      "admin",
	}
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, input)
	require.NoError(t, err)
	assert.True(t, fake.updatePermCalled, "should update existing permission")
	assert.Equal(t, []string{
		"usr-user1-proj-proj1-admin",
		"usr-user2-proj-proj1-admin",
	}, fake.existingPermPols)
}
