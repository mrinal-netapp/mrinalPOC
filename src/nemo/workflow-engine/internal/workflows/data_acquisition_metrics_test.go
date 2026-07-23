package workflows

import (
	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"os"
	"sync/atomic"
	"testing"
)

var (
	acquireMetricsCalls     int32
	lastAcquireMetricsInput map[string]interface{}
	watermarkUpdateCalls    int32
	lastWatermarkValue      string
	datasetImportChildCalls int32
	lastDatasetImportInput  types.DatasetImportWorkflowInput
)

func resetMetricsTestCounters() {
	atomic.StoreInt32(&acquireMetricsCalls, 0)
	atomic.StoreInt32(&watermarkUpdateCalls, 0)
	atomic.StoreInt32(&datasetImportChildCalls, 0)
	lastAcquireMetricsInput = nil
	lastWatermarkValue = ""
	lastDatasetImportInput = types.DatasetImportWorkflowInput{}
}

func mockFetchDatasetConfigGcpMetrics(_, _ string) (map[string]interface{}, error) {
	return map[string]interface{}{
		"name":            "gcnv-volume-metrics",
		"kind":            "structured",
		"bucketName":      "proj-bucket",
		"namespace":       "default",
		"originConnector": "conn-gcp-1",
		"resourceSelector": []interface{}{
			map[string]interface{}{"category": "volume_metrics"},
		},
		"acquisitionConfig": map[string]interface{}{
			"writeMode": "append",
		},
	}, nil
}

func mockFetchDatasetConfigGcpMetricsOverwrite(_, _ string) (map[string]interface{}, error) {
	ds, _ := mockFetchDatasetConfigGcpMetrics("", "")
	acq := ds["acquisitionConfig"].(map[string]interface{})
	acq["writeMode"] = "overwrite"
	return ds, nil
}

func mockFetchDataSourceConfigGcp(_, _ string) (map[string]interface{}, error) {
	return map[string]interface{}{
		"connectorConfig": map[string]interface{}{
			"connector_type": "cloud",
			"provider":       "gcp",
			"project_id":     "test-gcp-project",
		},
		"credentialId": "cred-gcp-1",
	}, nil
}

func mockAcquireMetricsGcp(input map[string]interface{}) (map[string]interface{}, error) {
	atomic.AddInt32(&acquireMetricsCalls, 1)
	lastAcquireMetricsInput = input
	return map[string]interface{}{
		"fileListKey":       "projects/proj-1/datasets/ds-metrics/_acquisition/filelist.json",
		"newWatermarkValue": "2026-06-01T12:00:00+00:00",
		"rowCount":          float64(12),
		"filesCopied":       float64(1),
	}, nil
}

func mockUpdateDatasetWatermark(_, _, wm string) error {
	atomic.AddInt32(&watermarkUpdateCalls, 1)
	lastWatermarkValue = wm
	return nil
}

func registerGcpMetricsAcquisitionMocks(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(
		mockFetchDatasetConfigGcpMetrics,
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		mockFetchDataSourceConfigGcp,
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		mockAcquireMetricsGcp,
		activity.RegisterOptions{Name: "AcquireMetrics"},
	)
	env.RegisterActivityWithOptions(
		mockUpdateDatasetWatermark,
		activity.RegisterOptions{Name: "UpdateDatasetWatermarkActivity"},
	)
	env.RegisterActivityWithOptions(
		func(string, string, string, string) error { return nil },
		activity.RegisterOptions{Name: "UpdateDatasetStatusActivity"},
	)
	env.RegisterActivityWithOptions(
		func(activities.UpdateAcquisitionFacetInput) error { return nil },
		activity.RegisterOptions{Name: "UpdateAcquisitionFacetActivity"},
	)
}

func TestDataAcquisitionWorkflow_GcpMetricsHappyPath(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	resetMetricsTestCounters()
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()
	registerGcpMetricsAcquisitionMocks(env)

	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Run(func(args mock.Arguments) {
			atomic.AddInt32(&datasetImportChildCalls, 1)
			if len(args) >= 2 {
				if in, ok := args[1].(types.DatasetImportWorkflowInput); ok {
					lastDatasetImportInput = in
				}
			}
		}).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID:        "proj-1",
		DatasetID:        "ds-metrics",
		ConfigServiceURL: "http://config-service:3000",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result DataAcquisitionWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&result))
	assert.Equal(t, "completed", result.Status)
	assert.Equal(t, 12, result.RowCount)
	assert.Equal(t, 1, result.FilesCopied)
	assert.Equal(t, int32(1), atomic.LoadInt32(&acquireMetricsCalls))
	assert.Equal(t, int32(1), atomic.LoadInt32(&watermarkUpdateCalls))
	assert.Equal(t, "2026-06-01T12:00:00+00:00", lastWatermarkValue)

	require.NotNil(t, lastAcquireMetricsInput)
	assert.Equal(t, "gcp", lastAcquireMetricsInput["provider"])
	assert.Equal(t, "proj-1", lastAcquireMetricsInput["projectID"])
	assert.Equal(t, "ds-metrics", lastAcquireMetricsInput["datasetID"])

	assert.Equal(t, int32(1), atomic.LoadInt32(&datasetImportChildCalls))
	assert.Equal(t, "projects/proj-1/datasets/ds-metrics/_acquisition/filelist.json", lastDatasetImportInput.FileListKey)
	assert.Equal(t, "gcnv-volume-metrics", lastDatasetImportInput.DatasetName)
}

func TestDataAcquisitionWorkflow_GcpMetricsRejectsOverwrite(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	resetMetricsTestCounters()
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(
		mockFetchDatasetConfigGcpMetricsOverwrite,
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		mockFetchDataSourceConfigGcp,
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		mockAcquireMetricsGcp,
		activity.RegisterOptions{Name: "AcquireMetrics"},
	)
	env.RegisterActivityWithOptions(
		func(string, string, string, string) error { return nil },
		activity.RegisterOptions{Name: "UpdateDatasetStatusActivity"},
	)
	env.RegisterActivityWithOptions(
		func(activities.UpdateAcquisitionFacetInput) error { return nil },
		activity.RegisterOptions{Name: "UpdateAcquisitionFacetActivity"},
	)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID:        "proj-1",
		DatasetID:        "ds-metrics",
		ConfigServiceURL: "http://config-service:3000",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "writeMode=overwrite")
	assert.Equal(t, int32(0), atomic.LoadInt32(&acquireMetricsCalls))
}
