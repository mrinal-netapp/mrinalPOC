package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestGrantProjectRoleActivity_MergeIntoExistingPermission(t *testing.T) {
	fake := &fakeGrantServer{
		t:                t,
		existingPolicies: []clients.PolicyInfo{},
		permissionExists: true,
		existingPermPols: []string{"usr-other-proj-proj1-member"},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: "proj1", UserId: "user1", Role: "member",
	})
	require.NoError(t, err)
	assert.True(t, fake.createPolicyCalled)
	assert.True(t, fake.updatePermCalled)
}

func TestGrantProjectRoleActivity_PolicyAlreadyInPermissionNoOp(t *testing.T) {
	policyName := "usr-user1-proj-proj1-member"
	fake := &fakeGrantServer{
		t:                t,
		existingPolicies: []clients.PolicyInfo{},
		permissionExists: true,
		existingPermPols: []string{policyName},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: "proj1", UserId: "user1", Role: "member",
	})
	require.NoError(t, err)
	assert.False(t, fake.updatePermCalled)
}

func TestRevokeProjectRoleActivity_OrphanPolicyWhenPermissionMissing(t *testing.T) {
	fake := &fakeRevokeServer{
		t: t,
		policyByName: map[string]string{
			"usr-user1-proj-proj1-admin": "pol-1",
		},
		permissionExists: false,
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RevokeProjectRoleActivity)
	_, err := env.ExecuteActivity(RevokeProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: "proj1", UserId: "user1", Role: "admin",
	})
	require.NoError(t, err)
	assert.True(t, fake.deletePolicyCalled)
}

func TestRevokeProjectRoleActivity_KeepsPermissionWithOtherPolicies(t *testing.T) {
	policyName := "usr-user1-proj-proj1-admin"
	fake := &fakeRevokeServer{
		t:            t,
		policyByName: map[string]string{policyName: "pol-1"},
		permissionByName: map[string]string{
			"perm-proj-proj1-admin": "perm-1",
		},
		permPolicies: map[string][]string{
			"perm-1": {policyName, "usr-other-proj-proj1-admin"},
		},
	}
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RevokeProjectRoleActivity)
	_, err := env.ExecuteActivity(RevokeProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: "proj1", UserId: "user1", Role: "admin",
	})
	require.NoError(t, err)
	assert.True(t, fake.updatePermCalled)
	assert.True(t, fake.deletePolicyCalled)
	assert.False(t, fake.deletePermCalled)
}

func TestCreateBucketInS3Activity_InvalidEndpoint(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "://bad")
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateBucketInS3Activity)
	_, err := env.ExecuteActivity(CreateBucketInS3Activity, "bucket-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid S3 endpoint URL")
}

func TestWaitForBucketReadyActivity_InvalidEndpointURL(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "://bad-url")
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForBucketReadyActivity)
	_, err := env.ExecuteActivity(WaitForBucketReadyActivity, "p1", "bucket-1", 1)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "invalid S3 endpoint URL")
}

func TestTeardownProjectLLMGatewayActivity_WithMeta(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "gateway-teardown") {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(TeardownProjectLLMGatewayActivity)
	_, err := env.ExecuteActivity(TeardownProjectLLMGatewayActivity, types.TeardownProjectLLMGatewayInput{
		ProjectId: "p1",
		Gateway:   &types.ProjectGatewayMeta{TeamId: "team-1", VirtualKeyId: "vk-1"},
	})
	require.NoError(t, err)
}

func TestReportProjectInitStatusActivity_Error(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	env.RegisterActivity(ReportProjectInitStatusActivity)
	_, err := env.ExecuteActivity(ReportProjectInitStatusActivity, types.ReportProjectInitStatusInput{
		ProjectId: "p1", Status: "failed", Error: "boom",
	})
	require.Error(t, err)
}

func TestUpdateKBProgressActivity_WarnsWhenProgressStoreUnreachable(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateKBProgressActivity)
	_, err := env.ExecuteActivity(UpdateKBProgressActivity, "p1", "kb1", types.KBProgressInfo{
		Phase: "processing_documents", TotalFiles: 5, ChunksCreated: 2,
		CurrentFile: "doc.pdf", DocumentsProcessed: 1, TotalDocuments: 5,
		ReplaceProgress: true,
	})
	require.NoError(t, err)
}

func TestDeleteProjectCredentialSecretsActivity_NoNamespace(t *testing.T) {
	t.Setenv("NAMESPACE", "")
	t.Setenv("KUBERNETES_NAMESPACE", "")
	t.Setenv("POD_NAMESPACE", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteProjectCredentialSecretsActivity)
	_, err := env.ExecuteActivity(DeleteProjectCredentialSecretsActivity, "p1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "in-cluster config")
}

func TestRunMCPHealthCheckActivity_NoEligibleServers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode([]types.MCPServerHealthInfo{})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RunMCPHealthCheckActivity)
	val, err := env.ExecuteActivity(RunMCPHealthCheckActivity, types.MCPHealthCheckInput{
		ConfigServiceURL: srv.URL,
	})
	require.NoError(t, err)
	var got types.MCPHealthCheckResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, 0, got.Checked)
}

// fakeRevokeServer extends grant stubs with delete/update handlers for revoke paths.
type fakeRevokeServer struct {
	t                  *testing.T
	policyByName       map[string]string
	permissionByName   map[string]string
	permPolicies       map[string][]string
	permissionExists   bool
	deletePolicyCalled bool
	deletePermCalled   bool
	updatePermCalled   bool
}

// permIDFromAssociatedPoliciesPath extracts the permission id from
// GET .../policy/{id}/associatedPolicies.
func permIDFromAssociatedPoliciesPath(path string) (string, bool) {
	const suffix = "/associatedPolicies"
	if !strings.HasSuffix(path, suffix) {
		return "", false
	}
	base := strings.TrimSuffix(path, suffix)
	const marker = "/policy/"
	idx := strings.LastIndex(base, marker)
	if idx < 0 {
		return "", false
	}
	permID := base[idx+len(marker):]
	return permID, permID != ""
}

// permIDFromScopePath extracts the permission id from GET .../permission/scope/{id}.
func permIDFromScopePath(path string) (string, bool) {
	const marker = "/permission/scope/"
	idx := strings.LastIndex(path, marker)
	if idx < 0 {
		return "", false
	}
	permID := path[idx+len(marker):]
	if permID == "" || strings.Contains(permID, "/") {
		return "", false
	}
	return permID, true
}

func (f *fakeRevokeServer) permNameByID(permID string) string {
	for name, id := range f.permissionByName {
		if id == permID {
			return name
		}
	}
	return ""
}

func (f *fakeRevokeServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token", "expires_in": 3600, "token_type": "Bearer",
			})

		case strings.Contains(r.URL.Path, "/associatedPolicies") && r.Method == http.MethodGet:
			permID, ok := permIDFromAssociatedPoliciesPath(r.URL.Path)
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			pols, ok := f.permPolicies[permID]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			assoc := make([]map[string]string, 0, len(pols))
			for _, name := range pols {
				assoc = append(assoc, map[string]string{"name": name})
			}
			_ = json.NewEncoder(w).Encode(assoc)

		case strings.Contains(r.URL.Path, "/authz/resource-server/policy") &&
			r.Method == http.MethodGet && r.URL.Query().Get("search") != "true":
			name := r.URL.Query().Get("name")
			if id, ok := f.policyByName[name]; ok {
				_ = json.NewEncoder(w).Encode([]map[string]string{{"id": id, "name": name}})
				return
			}
			w.WriteHeader(http.StatusNotFound)

		case strings.Contains(r.URL.Path, "/permission/scope") &&
			r.Method == http.MethodGet && r.URL.Query().Get("name") != "":
			name := r.URL.Query().Get("name")
			if id, ok := f.permissionByName[name]; ok {
				_ = json.NewEncoder(w).Encode([]map[string]string{{"id": id, "name": name}})
				return
			}
			w.WriteHeader(http.StatusNotFound)

		case strings.Contains(r.URL.Path, "/permission/scope/") && r.Method == http.MethodGet && r.URL.Query().Get("name") == "":
			permID, ok := permIDFromScopePath(r.URL.Path)
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			// Keycloak omits policies on GET /permission/scope/{id}; revoke reads
			// the live list from /policy/{id}/associatedPolicies instead.
			_ = json.NewEncoder(w).Encode(types.KeycloakScopePermission{
				ID: permID, Name: f.permNameByID(permID),
			})

		case strings.Contains(r.URL.Path, "/permission/scope/") && r.Method == http.MethodPut:
			f.updatePermCalled = true
			w.WriteHeader(http.StatusOK)

		case strings.Contains(r.URL.Path, "/permission/scope/") && r.Method == http.MethodDelete:
			f.deletePermCalled = true
			w.WriteHeader(http.StatusNoContent)

		case strings.Contains(r.URL.Path, "/policy/") && r.Method == http.MethodDelete:
			f.deletePolicyCalled = true
			w.WriteHeader(http.StatusNoContent)

		default:
			f.t.Logf("unhandled revoke request: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
		}
	}
}
