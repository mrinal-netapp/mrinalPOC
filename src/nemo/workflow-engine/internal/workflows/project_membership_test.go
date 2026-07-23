package workflows

import (
	"context"
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

// --- Mock activities for membership workflows ---

func mockGrantProjectRoleSuccess(_ context.Context, _ types.ProjectMembershipInput) error {
	return nil
}

func mockGrantProjectRoleFail(_ context.Context, _ types.ProjectMembershipInput) error {
	return errors.New("keycloak unavailable")
}

func mockRevokeProjectRoleSuccess(_ context.Context, _ types.ProjectMembershipInput) error {
	return nil
}

func mockRevokeProjectRoleFail(_ context.Context, _ types.ProjectMembershipInput) error {
	return errors.New("revoke failed")
}

// --- Mock activities for ProjectInitWorkflow Keycloak steps ---

func mockRegisterProjectResourceSuccess(_ context.Context, _ types.RegisterProjectResourceInput) (types.RegisterProjectResourceResult, error) {
	return types.RegisterProjectResourceResult{ResourceId: "kc-res-id"}, nil
}

func mockRegisterProjectResourceFail(_ context.Context, _ types.RegisterProjectResourceInput) (types.RegisterProjectResourceResult, error) {
	return types.RegisterProjectResourceResult{}, errors.New("keycloak unavailable")
}

func mockPersistKeycloakResourceIdSuccess(_ context.Context, _ types.PersistKeycloakResourceIdInput) error {
	return nil
}

func mockPersistKeycloakResourceIdFail(_ context.Context, _ types.PersistKeycloakResourceIdInput) error {
	return errors.New("config-service error")
}

func mockGrantInitialAdminSuccess(_ context.Context, _ types.GrantInitialAdminInput) error {
	return nil
}

func mockDeleteProjectResourceSuccess(_ context.Context, _ types.DeleteProjectResourceInput) error {
	return nil
}

func mockLookupWarehouseSuccess(_ context.Context, _ types.LookupWarehouseRequest) (types.LookupWarehouseResult, error) {
	return types.LookupWarehouseResult{WarehouseId: "wh-id-1", WarehouseName: "nemo", Found: true}, nil
}

func mockUpdateProjectMetadataSuccess(_ context.Context, _ string, _ string) error {
	return nil
}

func mockCreateNamespaceSuccess(_ context.Context, _ types.CreateNamespaceRequest) error {
	return nil
}

func mockCreateProjectServiceAccountSuccess(_ context.Context, _ string) error {
	return nil
}

func mockSetupProjectLLMGatewaySuccess(_ context.Context, _ string) error {
	return nil
}

func mockReportProjectInitStatusSuccess(_ context.Context, _ types.ReportProjectInitStatusInput) error {
	return nil
}

// --- ProjectAddUserWorkflow tests ---

func TestProjectAddUserWorkflow_Success(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockGrantProjectRoleSuccess, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-alice",
		Role:      "member",
	}

	env.ExecuteWorkflow(ProjectAddUserWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectAddUserWorkflow_ActivityFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockGrantProjectRoleFail, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-bob",
		Role:      "viewer",
	}

	env.ExecuteWorkflow(ProjectAddUserWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "keycloak unavailable")
}

// --- ProjectRemoveUserWorkflow tests ---

func TestProjectRemoveUserWorkflow_Success(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockRevokeProjectRoleSuccess, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-bob",
	}

	env.ExecuteWorkflow(ProjectRemoveUserWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectRemoveUserWorkflow_PartialFailureFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	// If one role revoke fails, the workflow should report the failure
	callCount := 0
	mockRevokeWithOneFailure := func(_ context.Context, input types.ProjectMembershipInput) error {
		callCount++
		if input.Role == "admin" {
			return errors.New("transient failure")
		}
		return nil
	}
	env.RegisterActivityWithOptions(mockRevokeWithOneFailure, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-bob",
	}

	env.ExecuteWorkflow(ProjectRemoveUserWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	require.Contains(t, env.GetWorkflowError().Error(), "failed to revoke one or more roles")
}

// --- ProjectChangeRoleWorkflow tests ---

func TestProjectChangeRoleWorkflow_Success(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockRevokeProjectRoleSuccess, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})
	env.RegisterActivityWithOptions(mockGrantProjectRoleSuccess, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-carol",
		Role:      "admin",
	}

	env.ExecuteWorkflow(ProjectChangeRoleWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectChangeRoleWorkflow_GrantFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockRevokeProjectRoleSuccess, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})
	env.RegisterActivityWithOptions(mockGrantProjectRoleFail, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-carol",
		Role:      "viewer",
	}

	env.ExecuteWorkflow(ProjectChangeRoleWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "keycloak unavailable")
}

func TestProjectChangeRoleWorkflow_RevokeFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockRevokeProjectRoleFail, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})
	env.RegisterActivityWithOptions(mockGrantProjectRoleSuccess, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-carol",
		Role:      "admin",
	}

	env.ExecuteWorkflow(ProjectChangeRoleWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "failed to revoke role")
}

// TestProjectChangeRoleWorkflow_ViewerToAdmin verifies that the revoke-then-grant
// pattern used by ChangeRole does not trigger the one-role-per-user invariant
// because the revoke runs first, clearing the old role before granting the new one.
func TestProjectChangeRoleWorkflow_ViewerToAdmin(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	revokedRoles := []string{}
	env.RegisterActivityWithOptions(func(_ context.Context, input types.ProjectMembershipInput) error {
		revokedRoles = append(revokedRoles, input.Role)
		return nil
	}, activity.RegisterOptions{Name: "RevokeProjectRoleActivity"})

	env.RegisterActivityWithOptions(func(_ context.Context, input types.ProjectMembershipInput) error {
		assert.Equal(t, "admin", input.Role, "grant should be called with the new role")
		return nil
	}, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-with-viewer",
		Role:      "admin",
	}

	env.ExecuteWorkflow(ProjectChangeRoleWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	assert.Contains(t, revokedRoles, "member", "should revoke member")
	assert.Contains(t, revokedRoles, "viewer", "should revoke viewer")
	assert.NotContains(t, revokedRoles, "admin", "should NOT revoke the target role")
}

// TestProjectAddUserWorkflow_ConflictNonRetryable verifies that a non-retryable
// AlreadyAssignedDifferentRole error from the activity surfaces correctly.
func TestProjectAddUserWorkflow_ConflictNonRetryable(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(func(_ context.Context, _ types.ProjectMembershipInput) error {
		return temporal.NewNonRetryableApplicationError(
			"user already has role \"viewer\" on this project",
			activities.ErrAlreadyAssignedDifferentRole,
			nil,
		)
	}, activity.RegisterOptions{Name: "GrantProjectRoleActivity"})

	input := types.ProjectMembershipInput{
		ProjectId: "proj-1",
		UserId:    "user-has-viewer",
		Role:      "admin",
	}

	env.ExecuteWorkflow(ProjectAddUserWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	err := env.GetWorkflowError()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "viewer")
	assert.Contains(t, err.Error(), activities.ErrAlreadyAssignedDifferentRole)
}

// --- ProjectInitWorkflow with Keycloak steps ---

func registerInitWorkflowMocks(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(mockSetupProjectLLMGatewaySuccess, activity.RegisterOptions{Name: "SetupProjectLLMGatewayActivity"})
	env.RegisterActivityWithOptions(mockLookupWarehouseSuccess, activity.RegisterOptions{Name: "LookupWarehouseActivity"})
	env.RegisterActivityWithOptions(mockUpdateProjectMetadataSuccess, activity.RegisterOptions{Name: "UpdateProjectMetadataActivity"})
	env.RegisterActivityWithOptions(mockCreateNamespaceSuccess, activity.RegisterOptions{Name: "CreateNamespaceActivity"})
	env.RegisterActivityWithOptions(mockCreateProjectServiceAccountSuccess, activity.RegisterOptions{Name: "CreateProjectServiceAccountActivity"})
	// The workflow always reports terminal init status at the end.
	env.RegisterActivityWithOptions(mockReportProjectInitStatusSuccess, activity.RegisterOptions{Name: "ReportProjectInitStatusActivity"})
}

func TestProjectInitWorkflow_WithKeycloakSteps(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	registerInitWorkflowMocks(env)
	env.RegisterActivityWithOptions(mockRegisterProjectResourceSuccess, activity.RegisterOptions{Name: "RegisterProjectResourceActivity"})
	env.RegisterActivityWithOptions(mockPersistKeycloakResourceIdSuccess, activity.RegisterOptions{Name: "PersistKeycloakResourceIdActivity"})
	env.RegisterActivityWithOptions(mockGrantInitialAdminSuccess, activity.RegisterOptions{Name: "GrantInitialAdminActivity"})

	input := types.ProjectInitWorkflowInput{
		ProjectId:   "proj-kc",
		Region:      "us-east-1",
		OwnerUserId: "owner-uuid-1",
	}

	env.ExecuteWorkflow(ProjectInitWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result types.ProjectInitWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
	assert.Equal(t, "proj-kc", result.ProjectId)
	assert.True(t, result.NamespaceCreated)
}

func TestProjectInitWorkflow_RejectsEmptyOwner(t *testing.T) {
	// Project init must fail (not silently skip Keycloak steps) when OwnerUserId
	// is empty. Empty owner used to be a "skip Keycloak" signal — that path
	// allowed service-account-authenticated callers to create projects with
	// no admin policy. The HTTP route now requires a user token and the
	// workflow re-checks the invariant.
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	registerInitWorkflowMocks(env)

	input := types.ProjectInitWorkflowInput{
		ProjectId:   "proj-no-owner",
		Region:      "us-east-1",
		OwnerUserId: "",
	}

	env.ExecuteWorkflow(ProjectInitWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	err := env.GetWorkflowError()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "OwnerUserId is required")
}

func TestProjectInitWorkflow_KeycloakRegisterFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	registerInitWorkflowMocks(env)
	env.RegisterActivityWithOptions(mockRegisterProjectResourceFail, activity.RegisterOptions{Name: "RegisterProjectResourceActivity"})

	input := types.ProjectInitWorkflowInput{
		ProjectId:   "proj-fail",
		Region:      "us-east-1",
		OwnerUserId: "owner-1",
	}

	env.ExecuteWorkflow(ProjectInitWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	err := env.GetWorkflowError()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "keycloak unavailable")
}

// Persisting the Keycloak resource id is now BEST-EFFORT and runs AFTER the
// owner admin grant. A persist failure must NOT fail the workflow or roll back
// the resource/admin grant — rolling back would strip the owner's admin and
// leave the creator without access to a partially initialized project. The
// stored id is informational (teardown resolves the resource by name).
func TestProjectInitWorkflow_PersistFailsIsNonFatal(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	registerInitWorkflowMocks(env)
	env.RegisterActivityWithOptions(mockRegisterProjectResourceSuccess, activity.RegisterOptions{Name: "RegisterProjectResourceActivity"})
	env.RegisterActivityWithOptions(mockPersistKeycloakResourceIdFail, activity.RegisterOptions{Name: "PersistKeycloakResourceIdActivity"})
	env.RegisterActivityWithOptions(mockGrantInitialAdminSuccess, activity.RegisterOptions{Name: "GrantInitialAdminActivity"})
	// DeleteProjectResourceActivity must NOT be needed anymore; register a
	// failing stub so the test breaks loudly if a rollback is ever attempted.
	env.RegisterActivityWithOptions(func(_ context.Context, _ types.DeleteProjectResourceInput) error {
		return errors.New("rollback must not be attempted on persist failure")
	}, activity.RegisterOptions{Name: "DeleteProjectResourceActivity"})

	input := types.ProjectInitWorkflowInput{
		ProjectId:   "proj-persist-fail",
		Region:      "us-east-1",
		OwnerUserId: "owner-1",
	}

	env.ExecuteWorkflow(ProjectInitWorkflow, input)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError(), "persist failure must be non-fatal")

	var result types.ProjectInitWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
}
