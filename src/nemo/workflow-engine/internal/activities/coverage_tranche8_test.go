package activities

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestRevokeProjectRoleActivity_DeletesEmptyPermission(t *testing.T) {
	policyName := "usr-user1-proj-proj1-admin"
	fake := &fakeRevokeServer{
		t:            t,
		policyByName: map[string]string{policyName: "pol-1"},
		permissionByName: map[string]string{
			"perm-proj-proj1-admin": "perm-1",
		},
		permPolicies: map[string][]string{
			"perm-1": {policyName},
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
	assert.True(t, fake.deletePermCalled)
}

func TestUpdateDatasetProgressActivity_AllExtraFields(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateDatasetProgressActivity)
	_, err := env.ExecuteActivity(UpdateDatasetProgressActivity, "p1", "d1", types.DatasetProgressInfo{
		Phase: "processing", Percentage: 50, Current: 5, Total: 10,
		TotalFiles: 3, ProcessedFiles: 2, CurrentFile: "f.csv",
	})
	require.NoError(t, err)
}

func TestUpdateKBStatusWithStatsActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	env.RegisterActivity(UpdateKBStatusWithStatsActivity)
	_, err := env.ExecuteActivity(UpdateKBStatusWithStatsActivity, UpdateKBStatusInput{
		ProjectId: "p1", KbId: "kb1", Status: "ready",
		DocumentCount: 1, Stats: &types.KBStats{StorageBytes: 100},
	})
	require.NoError(t, err)
}

func TestRegisterTableWithCatalogActivity_WarehouseLookupFails(t *testing.T) {
	env := lakekeeperActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	env.RegisterActivity(RegisterTableWithCatalogActivity)
	_, err := env.ExecuteActivity(RegisterTableWithCatalogActivity, types.RegisterTableRequest{
		ProjectId: "p1", DatasetId: "d1", DatasetName: "ds", Namespace: "default",
	})
	require.Error(t, err)
}

func TestProbeMCPServer_MissingServerName(t *testing.T) {
	ok, reason := probeMCPServer(context.Background(), &http.Client{}, "http://x", "", "  ")
	require.False(t, ok)
	require.Equal(t, "missing_server_name", reason)
}
