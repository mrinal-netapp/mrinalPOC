package workflows

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// testStreamingObjectStoreWorkflow exercises runStreamingObjectStoreAcquisition
// with mocked connector activities (DiscoverSourceItems, AcquireBatch, FinalizeAcquisition).
func testStreamingObjectStoreWorkflow(ctx workflow.Context) (map[string]interface{}, error) {
	localCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: time.Minute})
	connCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: time.Minute,
	})

	input := DataAcquisitionWorkflowInput{
		ProjectID:        "proj-1",
		DatasetID:        "ds-1",
		ConfigServiceURL: "http://config-service:3000",
	}
	connectorConfig := map[string]interface{}{
		"connector_type": "objectstore",
		"provider":       "s3",
		"bucket":         "source-bucket",
		"prefix":         "incoming/",
		"endpoint":       "http://minio:9000",
	}
	pipelineInput := map[string]interface{}{
		"projectID":        "proj-1",
		"datasetID":        "ds-1",
		"credentialID":     "cred-1",
		"connectorConfig":  connectorConfig,
		"outputPath":       "/projects/proj-1/datasets/ds-1/data_files",
		"outputBucket":     "dest-bucket",
		"fileGlob":         "*.csv",
		"configServiceURL": "http://config-service:3000",
	}
	cfg := types.AcquisitionPipelineConfig{
		MaxAcquireConsumers:    8,
		BatchSize:              64,
		MaxBatchesPerActivity:  8,
		UnboundedConsumers:     6,
		ScheduleToStartTimeout: 15 * time.Minute,
	}
	return runStreamingObjectStoreAcquisition(
		ctx, connCtx, localCtx,
		input, "wf-stream-test",
		connectorConfig, pipelineInput,
		"/projects/proj-1/datasets/ds-1/data_files",
		"2026-01-15T12:00:00Z",
		cfg,
	)
}

func mockDiscoverSourceItems(map[string]interface{}) (map[string]interface{}, error) {
	return map[string]interface{}{
		"streamKey":       "acq:wf:run:items",
		"totalDiscovered": 2,
		"filesFiltered":   1,
		"filesListed":     3,
		"eof":             true,
	}, nil
}

func mockDiscoverSourceItemsLarge(map[string]interface{}) (map[string]interface{}, error) {
	return map[string]interface{}{
		"totalDiscovered": float64(2000),
		"filesFiltered":   0,
		"filesListed":     2000,
		"eof":             true,
	}, nil
}

func mockDiscoverSourceItemsFail(map[string]interface{}) (map[string]interface{}, error) {
	return nil, errors.New("S3 list failed")
}

func mockPostWorkflowProgress(activities.PostWorkflowProgressInput) error {
	return nil
}

var acquireBatchInvocations int32

func mockAcquireBatchSuccess(input map[string]interface{}) (types.WorkUnitResult, error) {
	atomic.AddInt32(&acquireBatchInvocations, 1)
	setID, _ := input["setId"].(string)
	return types.WorkUnitResult{
		SetID:     setID,
		Status:    "success",
		FileCount: 5,
		Extra: map[string]interface{}{
			"bytesCopied": float64(500),
		},
	}, nil
}

func mockFinalizeAcquisitionSuccess(map[string]interface{}) (map[string]interface{}, error) {
	return map[string]interface{}{
		"fileListKey":    "projects/proj-1/datasets/ds-1/_acquisition/filelist.json",
		"totalBytes":     float64(500),
		"throughputMBps": 1.2,
		"facetState":     "ready",
	}, nil
}

func registerStreamingMocks(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(mockDiscoverSourceItems, activity.RegisterOptions{Name: "DiscoverSourceItems"})
	env.RegisterActivityWithOptions(mockPostWorkflowProgress, activity.RegisterOptions{Name: "PostWorkflowProgressActivity"})
	env.RegisterActivityWithOptions(mockAcquireBatchSuccess, activity.RegisterOptions{Name: "AcquireBatch"})
	env.RegisterActivityWithOptions(mockFinalizeAcquisitionSuccess, activity.RegisterOptions{Name: "FinalizeAcquisition"})
}

func TestRunStreamingObjectStoreAcquisition_HappyPath(t *testing.T) {
	atomic.StoreInt32(&acquireBatchInvocations, 0)
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()
	registerStreamingMocks(env)

	env.RegisterWorkflow(testStreamingObjectStoreWorkflow)
	env.ExecuteWorkflow(testStreamingObjectStoreWorkflow)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var out map[string]interface{}
	require.NoError(t, env.GetWorkflowResult(&out))
	assert.Equal(t, float64(5), out["filesCopied"])
	assert.Equal(t, "projects/proj-1/datasets/ds-1/_acquisition/filelist.json", out["fileListKey"])
	// 2 discovered -> 1 consumer (ceil(2/512))
	assert.Equal(t, int32(1), atomic.LoadInt32(&acquireBatchInvocations))
}

func TestRunStreamingObjectStoreAcquisition_ScalesAcquireBatchUnits(t *testing.T) {
	atomic.StoreInt32(&acquireBatchInvocations, 0)
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockDiscoverSourceItemsLarge, activity.RegisterOptions{Name: "DiscoverSourceItems"})
	env.RegisterActivityWithOptions(mockPostWorkflowProgress, activity.RegisterOptions{Name: "PostWorkflowProgressActivity"})
	env.RegisterActivityWithOptions(mockAcquireBatchSuccess, activity.RegisterOptions{Name: "AcquireBatch"})
	env.RegisterActivityWithOptions(mockFinalizeAcquisitionSuccess, activity.RegisterOptions{Name: "FinalizeAcquisition"})

	wf := func(ctx workflow.Context) (map[string]interface{}, error) {
		localCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: time.Minute})
		connCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			TaskQueue: connectorOperationsQueue, StartToCloseTimeout: time.Minute,
		})
		input := DataAcquisitionWorkflowInput{ProjectID: "p", DatasetID: "d", ConfigServiceURL: "http://cfg"}
		connectorConfig := map[string]interface{}{"bucket": "b", "prefix": "p/"}
		pipelineInput := map[string]interface{}{
			"projectID": "p", "datasetID": "d", "connectorConfig": connectorConfig,
			"outputPath": "/projects/p/datasets/d/data_files", "outputBucket": "dest",
		}
		cfg := types.AcquisitionPipelineConfig{
			MaxAcquireConsumers: 8, BatchSize: 64, MaxBatchesPerActivity: 8,
			ScheduleToStartTimeout: time.Minute,
		}
		return runStreamingObjectStoreAcquisition(
			ctx, connCtx, localCtx, input, "wf", connectorConfig, pipelineInput,
			"/projects/p/datasets/d/data_files", "2026-01-15T12:00:00Z", cfg,
		)
	}
	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	// ceil(2000 / (64*8)) = 4 parallel AcquireBatch activities
	assert.Equal(t, int32(4), atomic.LoadInt32(&acquireBatchInvocations))
}

func TestRunStreamingObjectStoreAcquisition_DiscoverFailureFinalizes(t *testing.T) {
	atomic.StoreInt32(&acquireBatchInvocations, 0)
	var finalizeInvocations int32
	var finalizeScatterError bool

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockDiscoverSourceItemsFail, activity.RegisterOptions{Name: "DiscoverSourceItems"})
	env.RegisterActivityWithOptions(mockPostWorkflowProgress, activity.RegisterOptions{Name: "PostWorkflowProgressActivity"})
	env.RegisterActivityWithOptions(
		func(input map[string]interface{}) (map[string]interface{}, error) {
			atomic.AddInt32(&finalizeInvocations, 1)
			if v, ok := input["scatterError"].(bool); ok {
				finalizeScatterError = v
			}
			return map[string]interface{}{"facetState": "failed"}, nil
		},
		activity.RegisterOptions{Name: "FinalizeAcquisition"},
	)

	wf := func(ctx workflow.Context) (map[string]interface{}, error) {
		localCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: time.Minute})
		connCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			TaskQueue: connectorOperationsQueue, StartToCloseTimeout: time.Minute,
		})
		input := DataAcquisitionWorkflowInput{ProjectID: "p", DatasetID: "d", ConfigServiceURL: "http://cfg"}
		connectorConfig := map[string]interface{}{"bucket": "b"}
		pipelineInput := map[string]interface{}{
			"connectorConfig": connectorConfig,
			"outputPath":      "/projects/p/datasets/d/data_files",
			"outputBucket":    "dest",
		}
		cfg := types.AcquisitionPipelineConfig{MaxAcquireConsumers: 4, BatchSize: 64, MaxBatchesPerActivity: 8}
		_, err := runStreamingObjectStoreAcquisition(
			ctx, connCtx, localCtx, input, "wf", connectorConfig, pipelineInput,
			"/projects/p/datasets/d/data_files", "2026-01-15T12:00:00Z", cfg,
		)
		return nil, err
	}
	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "DiscoverSourceItems failed")
	assert.Equal(t, int32(1), atomic.LoadInt32(&finalizeInvocations))
	assert.True(t, finalizeScatterError, "finalize should run with scatterError on discover failure")
	assert.Equal(t, int32(0), atomic.LoadInt32(&acquireBatchInvocations))
}
