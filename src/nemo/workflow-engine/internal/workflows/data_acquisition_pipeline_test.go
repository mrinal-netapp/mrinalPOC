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

func TestDataAcquisitionWorkflow_StreamingPipelineHappyPath(t *testing.T) {
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
				"name": "stream-ds", "kind": "files", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-s3",
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
					"connector_type": "objectstore", "provider": "s3", "bucket": "src", "prefix": "",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"totalDiscovered": float64(4),
				"filesFiltered":   float64(1),
				"filesListed":     float64(5),
			}, nil
		},
		activity.RegisterOptions{Name: "DiscoverSourceItems"},
	)
	env.RegisterActivityWithOptions(
		func(activities.PostWorkflowProgressInput) error { return nil },
		activity.RegisterOptions{Name: "PostWorkflowProgressActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (types.WorkUnitResult, error) {
			return types.WorkUnitResult{Status: "success", FileCount: 2}, nil
		},
		activity.RegisterOptions{Name: "AcquireBatch"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/filelist.json",
				"filesCopied": float64(4),
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
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result DataAcquisitionWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
	assert.Equal(t, 2, result.FilesCopied)
}

func TestDataAcquisitionWorkflow_MetricsRoutingONTAP(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "metrics-ds", "kind": "metrics", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-ontap",
				"resourceSelector": []interface{}{
					map[string]interface{}{"category": "latency"},
				},
				"acquisitionConfig": map[string]interface{}{"writeMode": "append"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "cloud",
				"connectorConfig": map[string]interface{}{
					"connector_type": "cloud", "provider": "ontap",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/metrics.parquet",
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireMetrics"},
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
