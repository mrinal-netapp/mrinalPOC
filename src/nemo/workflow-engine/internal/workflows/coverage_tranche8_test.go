package workflows

import (
	"os"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestDataAcquisitionWorkflow_StreamingPipelineFullPath(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "true"))
	require.NoError(t, os.Setenv("ACQ_MAX_CONSUMERS", "2"))
	t.Cleanup(func() {
		_ = os.Unsetenv("ACQ_USE_PIPELINE")
		_ = os.Unsetenv("ACQ_MAX_CONSUMERS")
	})

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "pipe-ds", "kind": "files", "bucketName": "dest",
				"originConnector": "conn",
				"resourceSelector": []interface{}{
					map[string]interface{}{"bucket": "src", "prefix": "data/"},
				},
				"acquisitionConfig": map[string]interface{}{"writeMode": "append"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connectorConfig": map[string]interface{}{
					"connector_type": "objectstore", "provider": "s3",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"totalDiscovered": float64(2)}, nil
		},
		activity.RegisterOptions{Name: "DiscoverSourceItems"},
	)
	env.RegisterActivityWithOptions(
		func(activities.PostWorkflowProgressInput) error { return nil },
		activity.RegisterOptions{Name: "PostWorkflowProgressActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (types.WorkUnitResult, error) {
			return types.WorkUnitResult{Status: "success", FileCount: 1}, nil
		},
		activity.RegisterOptions{Name: "AcquireBatch"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "k", "filesCopied": float64(2),
			}, nil
		},
		activity.RegisterOptions{Name: "FinalizeAcquisition"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectInitWorkflow_CreateNamespaceFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "UpdateProjectMetadataActivity",
		"CreateNamespaceActivity", "ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "wh-1", Found: true}, nil)
	env.OnActivity("UpdateProjectMetadataActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateNamespaceActivity", mock.Anything, mock.Anything).Return(assert.AnError)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "CreateNamespaceActivity")
}

func TestProjectInitWorkflow_ServiceAccountFails(t *testing.T) {
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
	env.OnActivity("CreateProjectServiceAccountActivity", mock.Anything, mock.Anything).Return(assert.AnError)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.Error(t, env.GetWorkflowError())
}
