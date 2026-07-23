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

func mockFetchDatasetConfigVolume(_, _ string) (map[string]interface{}, error) {
	return map[string]interface{}{
		"name":         "vol-dataset",
		"kind":         "files",
		"bucketName":   "proj-bucket",
		"namespace":    "default",
		"originVolume": "vol-abc12345",
		"filterSpec": map[string]interface{}{
			"sourcePath": "/incoming",
		},
		"acquisitionConfig": map[string]interface{}{
			"writeMode": "append",
		},
	}, nil
}

func mockFetchDataSourceConfigVolume(_, _ string) (map[string]interface{}, error) {
	return map[string]interface{}{
		"type": "volume",
		"name": "my-vol",
	}, nil
}

func registerVolumeAcquisitionMocks(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(
		mockFetchDatasetConfigVolume,
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		mockFetchDataSourceConfigVolume,
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
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
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"filesDiscovered": float64(3),
				"filesFiltered":   float64(1),
				"dirsScanned":     float64(2),
			}, nil
		},
		activity.RegisterOptions{Name: "DiscoverVolumeFiles"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileCount": float64(2),
				"maxMtime":  "2026-06-01T12:00:00Z",
			}, nil
		},
		activity.RegisterOptions{Name: "RegisterBatch"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"manifestKey": "projects/p1/datasets/d1/_acquisition/manifest.json",
				"fileCount":   float64(2),
			}, nil
		},
		activity.RegisterOptions{Name: "FinalizeRegistration"},
	)
}

func TestDataAcquisitionWorkflow_VolumeHappyPath(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_MAX_DISCOVER_WORKERS", "1"))
	require.NoError(t, os.Setenv("ACQ_MAX_REGISTER_CONSUMERS", "1"))
	t.Cleanup(func() {
		_ = os.Unsetenv("ACQ_MAX_DISCOVER_WORKERS")
		_ = os.Unsetenv("ACQ_MAX_REGISTER_CONSUMERS")
	})

	var childCalls int32
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerVolumeAcquisitionMocks(env)

	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Run(func(args mock.Arguments) {
			atomic.AddInt32(&childCalls, 1)
		}).
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
	assert.Equal(t, int32(1), atomic.LoadInt32(&childCalls))
}

func TestDataAcquisitionWorkflow_VolumeNotVolumeType(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(
		mockFetchDatasetConfigVolume,
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{"type": "s3"}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
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
		ProjectID: "p1", DatasetID: "d1",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "not a volume")
}
