package activities

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestCollectMetricsActivity_ReturnsPlaceholder(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CollectMetricsActivity)

	val, err := env.ExecuteActivity(CollectMetricsActivity, "ns", "pod", "my-pod")
	require.NoError(t, err)

	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "Metrics collection not implemented", got["message"])
}

func TestUpdateReplicasActivity_UnsupportedKind(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateReplicasActivity)

	_, err := env.ExecuteActivity(UpdateReplicasActivity, "ns", "name", "CronJob", int32(1))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported kind: CronJob")
}

func TestCheckPodStatusActivity_OutOfClusterConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)

	_, err := env.ExecuteActivity(CheckPodStatusActivity, "default", "pod-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}

func TestCheckServiceStatusActivity_OutOfClusterConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckServiceStatusActivity)

	_, err := env.ExecuteActivity(CheckServiceStatusActivity, "default", "svc-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}

func TestCollectLogsActivity_OutOfClusterConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CollectLogsActivity)

	_, err := env.ExecuteActivity(CollectLogsActivity, "default", "pod-1", "main")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}

func TestWaitForPodReadyActivity_OutOfClusterConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForPodReadyActivity)

	_, err := env.ExecuteActivity(WaitForPodReadyActivity, "default", "pod-1", time.Second)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}

func TestWaitForServiceReadyActivity_OutOfClusterConfig(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForServiceReadyActivity)

	_, err := env.ExecuteActivity(WaitForServiceReadyActivity, "default", "svc-1", time.Second)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}
