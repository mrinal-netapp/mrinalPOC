package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestResolveOrCreateMembersActivity_Empty(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ResolveOrCreateMembersActivity)
	val, err := env.ExecuteActivity(ResolveOrCreateMembersActivity, []string{})
	require.NoError(t, err)
	var got []types.ResolvedMember
	require.NoError(t, val.Get(&got))
	assert.Empty(t, got)
}

func TestResolveOrCreateMembersActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"resolved": []types.ResolvedMember{{Email: "a@b.com", UserId: "u1"}},
		})
	})
	env.RegisterActivity(ResolveOrCreateMembersActivity)
	val, err := env.ExecuteActivity(ResolveOrCreateMembersActivity, []string{"a@b.com"})
	require.NoError(t, err)
	var got []types.ResolvedMember
	require.NoError(t, val.Get(&got))
	require.Len(t, got, 1)
	assert.Equal(t, "u1", got[0].UserId)
}

func TestResolveOrCreateMembersActivity_Error(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	env.RegisterActivity(ResolveOrCreateMembersActivity)
	_, err := env.ExecuteActivity(ResolveOrCreateMembersActivity, []string{"a@b.com"})
	require.Error(t, err)
}

func TestRevokeProjectRoleActivity_PolicyNotFoundIdempotent(t *testing.T) {
	fake := &fakeGrantServer{t: t, existingPolicies: []clients.PolicyInfo{}}
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
}

func TestRevokeProjectRoleActivity_FullRevoke(t *testing.T) {
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

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RevokeProjectRoleActivity)
	_, err := env.ExecuteActivity(RevokeProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: "proj1", UserId: "user1", Role: "admin",
	})
	require.NoError(t, err)
}
