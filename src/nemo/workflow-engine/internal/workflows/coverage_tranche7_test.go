package workflows

import (
	"os"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestDataAcquisitionWorkflow_FetchDatasetFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return nil, assert.AnError
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "failed to fetch dataset")
}

func TestDataAcquisitionWorkflow_FetchConnectorFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return nil, assert.AnError
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "failed to fetch connector")
}

func TestDataAcquisitionWorkflow_NoConnectorConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{"credentialId": "cred"}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "connectorConfig")
}

func TestDataAcquisitionWorkflow_NoCredentialId(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"connectorConfig": map[string]interface{}{"connector_type": "api"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "credentialId")
}

func TestDataAcquisitionWorkflow_ResourceSelectorSnakeCase(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "kind": "files", "bucketName": "dest",
				"originConnector": "conn",
				"resource_selector": []interface{}{
					map[string]interface{}{"bucket": "sel-bucket", "prefix": "sel/prefix/"},
				},
				"acquisition_config": map[string]interface{}{"writeMode": "append"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connector_config": map[string]interface{}{
					"connector_type": "objectstore", "provider": "s3",
				},
				"credential_id": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"fileListKey": "k", "filesCopied": float64(1)}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromObjectStore"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.NoError(t, env.GetWorkflowError())
}

func TestDataAcquisitionWorkflow_FilterSpecSnakeCase(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "kind": "files", "bucketName": "dest",
				"originConnector":   "conn",
				"filter_spec":       map[string]interface{}{"source_path": "src-bucket/data/"},
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
			return map[string]interface{}{"fileListKey": "k", "filesCopied": float64(2)}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromObjectStore"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.NoError(t, env.GetWorkflowError())
}

func TestDataAcquisitionWorkflow_CloudNonGCPRejected(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "cloud",
				"connectorConfig": map[string]interface{}{
					"connector_type": "cloud", "provider": "azure",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "provider=gcp")
}

func TestDataAcquisitionWorkflow_AcquireAPIFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "api-ds", "kind": "metrics", "bucketName": "b",
				"originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "api",
				"connectorConfig": map[string]interface{}{
					"connector_type": "api", "provider": "prometheus",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return nil, assert.AnError
		},
		activity.RegisterOptions{Name: "AcquireFromAPI"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "acquisition activity failed")
}

func TestDataAcquisitionWorkflow_ImportChildFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "kind": "files", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "api",
				"connectorConfig": map[string]interface{}{
					"connector_type": "api", "provider": "prometheus",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"fileListKey": "k"}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromAPI"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{}, assert.AnError)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "dataset import workflow failed")
}

func TestDataAcquisitionWorkflow_DatabaseWithWatermark(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "db", "kind": "table", "bucketName": "b", "originConnector": "conn",
				"sqlQuery": "SELECT 1",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "database",
				"connectorConfig": map[string]interface{}{
					"connector_type": "database", "database": "db1",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "k", "rowCount": float64(10),
				"newWatermarkValue": "wm-2026",
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromDatabase"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectInitWorkflow_ReportStatusWarnOnFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "", Found: false}, nil)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).
		Return(assert.AnError)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestProjectInitWorkflow_MembersResolveFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "UpdateProjectMetadataActivity",
		"CreateNamespaceActivity", "CreateProjectServiceAccountActivity",
		"ResolveOrCreateMembersActivity", "ReportProjectInitStatusActivity",
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
		Return(nil, assert.AnError)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
		Members: []types.ProjectMemberInvite{{Email: "x@y.com", Role: "member"}},
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "ResolveOrCreateMembersActivity")
}
