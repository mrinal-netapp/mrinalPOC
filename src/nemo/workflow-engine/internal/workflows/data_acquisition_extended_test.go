package workflows

import (
	"os"
	"sync/atomic"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func registerDataAcquisitionStatusMocks(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(
		func(string, string, string, string) error { return nil },
		activity.RegisterOptions{Name: "UpdateDatasetStatusActivity"},
	)
	env.RegisterActivityWithOptions(
		func(activities.UpdateAcquisitionFacetInput) error { return nil },
		activity.RegisterOptions{Name: "UpdateAcquisitionFacetActivity"},
	)
	env.RegisterActivityWithOptions(
		func(string, string, string) error { return nil },
		activity.RegisterOptions{Name: "UpdateDatasetWatermarkActivity"},
	)
}

func TestDataAcquisitionWorkflow_DatabaseHappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "db-dataset", "kind": "table", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-db",
				"sqlQuery": "SELECT id FROM users",
				"acquisitionConfig": map[string]interface{}{
					"writeMode": "append", "maxRows": float64(100),
				},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "database",
				"connectorConfig": map[string]interface{}{
					"connector_type": "database", "database": "analytics", "schema": "public",
				},
				"credentialId": "cred-db",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey":       "projects/p1/datasets/d1/_acquisition/filelist.json",
				"rowCount":          float64(42),
				"newWatermarkValue": "wm-99",
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
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result DataAcquisitionWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
	assert.Equal(t, 42, result.RowCount)
}

func TestDataAcquisitionWorkflow_APIHappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "api-dataset", "kind": "metrics", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-api",
				"acquisitionConfig": map[string]interface{}{"writeMode": "append"},
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
				"credentialId": "cred-api",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/api.json",
				"filesCopied": float64(5),
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromAPI"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result DataAcquisitionWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
	assert.Equal(t, 5, result.FilesCopied)
}

func TestDataAcquisitionWorkflow_S3LegacyObjectStore(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "s3-dataset", "kind": "files", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-s3",
				"filterSpec":        map[string]interface{}{"sourcePath": "src-bucket/incoming/"},
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
					"bucket": "src-bucket", "prefix": "incoming/",
				},
				"credentialId": "cred-s3",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/filelist.json",
				"filesCopied": float64(7),
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromObjectStore"},
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

func TestDataAcquisitionWorkflow_OverwriteClearsPaths(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	var clearCalls int32
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ow-dataset", "kind": "files", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-s3",
				"acquisitionConfig": map[string]interface{}{"writeMode": "overwrite"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connectorConfig": map[string]interface{}{
					"connector_type": "objectstore", "provider": "s3", "bucket": "b", "prefix": "",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) error {
			atomic.AddInt32(&clearCalls, 1)
			return nil
		},
		activity.RegisterOptions{Name: "ClearDatasetPath"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"fileListKey": "k"}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromObjectStore"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	assert.Equal(t, int32(2), clearCalls, "overwrite should clear data_files and _acquisition paths")
}

func TestDataAcquisitionWorkflow_MissingBucketName(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{"name": "no-bucket", "originConnector": "c1"}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "bucketName")
}

func TestDataAcquisitionWorkflow_MissingOriginConnector(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{"name": "no-conn", "bucketName": "b1"}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "originConnector")
}

func TestDataAcquisitionWorkflow_DatabaseMissingDatabaseConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "db-bad", "bucketName": "b", "originConnector": "conn",
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
					"connector_type": "database",
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
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "database connector requires a database")
}

func TestDataAcquisitionWorkflow_UnsupportedConnectorType(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "x", "bucketName": "b", "originConnector": "conn",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "weird",
				"connectorConfig": map[string]interface{}{
					"connector_type": "ftp",
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
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "unsupported connector type")
}
