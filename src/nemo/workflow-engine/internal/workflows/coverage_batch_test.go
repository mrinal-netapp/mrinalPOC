package workflows

import (
	"os"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestProjectVirtualKeyRotationWorkflow_HappyPathShortGrace(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RotateProjectVirtualKeyActivity", "DeleteRetiredProjectVirtualKeyActivity")

	env.OnActivity("RotateProjectVirtualKeyActivity", mock.Anything, mock.Anything).
		Return(types.RotateProjectVirtualKeyResult{ProjectId: "p1"}, nil)
	env.OnActivity("DeleteRetiredProjectVirtualKeyActivity", mock.Anything, mock.Anything).
		Return(types.DeleteRetiredProjectVirtualKeyResult{ProjectId: "p1", Deleted: true}, nil)

	env.ExecuteWorkflow(ProjectVirtualKeyRotationWorkflow, types.ProjectVKRotationInput{
		ProjectId: "p1", GracePeriod: time.Millisecond,
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestScheduledProjectVirtualKeyRotationWorkflow_FanOut(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "ListProjectsForVKRotationActivity")

	env.OnActivity("ListProjectsForVKRotationActivity", mock.Anything, mock.Anything).
		Return(types.ListProjectsForVKRotationResult{ProjectIds: []string{"p1", "p2"}}, nil)
	env.OnWorkflow(ProjectVirtualKeyRotationWorkflow, mock.Anything, mock.Anything).
		Return(nil).Times(2)

	env.ExecuteWorkflow(ScheduledProjectVirtualKeyRotationWorkflow, types.ScheduledProjectVKRotationInput{
		GracePeriod: time.Millisecond,
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.ScheduledProjectVKRotationResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, 2, got.ProjectsFound)
	assert.Equal(t, 2, got.RotationsStarted)
}

func TestGetConfigServiceURL_Default(t *testing.T) {
	t.Setenv("CONFIG_SERVICE_URL", "")
	assert.Equal(t, "http://config-service:3000", getConfigServiceURL())
}

func TestDataAcquisitionWorkflow_GCSLegacyPath(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "gcs-ds", "kind": "files", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-gcs",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connectorConfig": map[string]interface{}{
					"connector_type": "objectstore", "provider": "gcs", "bucket": "src-bucket",
				},
				"credentialId": "cred-1",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/filelist.json",
				"filesCopied": float64(3),
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromGCS"},
	)
	env.RegisterActivityWithOptions(
		func(string, string, string, string) error { return nil },
		activity.RegisterOptions{Name: "UpdateDatasetStatusActivity"},
	)
	env.RegisterActivityWithOptions(
		func(activities.UpdateAcquisitionFacetInput) error { return nil },
		activity.RegisterOptions{Name: "UpdateAcquisitionFacetActivity"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectInitWorkflow_HappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "UpdateProjectMetadataActivity",
		"CreateNamespaceActivity", "CreateProjectServiceAccountActivity",
		"ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "wh-1", Found: true}, nil)
	env.OnActivity("UpdateProjectMetadataActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateNamespaceActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateProjectServiceAccountActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.ProjectInitWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestProjectInitWorkflow_WithMembers(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "UpdateProjectMetadataActivity",
		"CreateNamespaceActivity", "CreateProjectServiceAccountActivity",
		"ResolveOrCreateMembersActivity", "GrantProjectRoleActivity",
		"ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "wh-1", Found: true}, nil)
	env.OnActivity("UpdateProjectMetadataActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateNamespaceActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateProjectServiceAccountActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("ResolveOrCreateMembersActivity", mock.Anything, mock.Anything).
		Return([]types.ResolvedMember{{Email: "bob@example.com", UserId: "u2"}}, nil)
	env.OnActivity("GrantProjectRoleActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
		Members: []types.ProjectMemberInvite{{Email: "bob@example.com", Role: "member"}},
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}
