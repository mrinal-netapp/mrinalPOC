package workflows

import (
	"errors"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

func TestRunScatterGather(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	// Register mock activities with names used by ExecuteActivity in RunScatterGather
	env.RegisterActivityWithOptions(mockProcessActivity, activity.RegisterOptions{Name: "ProcessActivity"})
	env.RegisterActivityWithOptions(mockMergeActivity, activity.RegisterOptions{Name: "MergeActivity"})

	// Workflow that runs ScatterGather with 2 units
	wf := func(ctx workflow.Context) (types.ScatterGatherResult, error) {
		params := ScatterGatherParams{
			ProcessActivityName: "ProcessActivity",
			MergeActivityName:   "MergeActivity",
			TaskQueue:           "test-queue",
			ProcessTimeout:      time.Minute,
			HeartbeatTimeout:    30 * time.Second,
			MergeTimeout:        time.Minute,
			WorkUnits:           []interface{}{"unit0", "unit1"},
			MergeInput:          map[string]string{"jobId": "job-1"},
		}
		return RunScatterGather(ctx, params)
	}

	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var result types.ScatterGatherResult
	require.NoError(t, env.GetWorkflowResult(&result))
	require.Equal(t, 2, result.Succeeded)
	require.Equal(t, 0, result.Failed)
	require.Len(t, result.UnitResults, 2)
	require.NotNil(t, result.MergeOutput)
}

func TestRunScatterGather_EmptyUnitsFails(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	wf := func(ctx workflow.Context) (types.ScatterGatherResult, error) {
		params := ScatterGatherParams{
			ProcessActivityName: "ProcessActivity",
			TaskQueue:           "test-queue",
			ProcessTimeout:      time.Minute,
			HeartbeatTimeout:    30 * time.Second,
			WorkUnits:           []interface{}{},
		}
		return RunScatterGather(ctx, params)
	}

	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

// mockProcessActivity is used by OnActivity; signature must match activity.
func mockProcessActivity(input interface{}) (types.WorkUnitResult, error) {
	return types.WorkUnitResult{SetID: "set-0", Status: "success"}, nil
}

func mockMergeActivity(input interface{}) (interface{}, error) {
	return map[string]int{"merged": 1}, nil
}

func TestRunScatterGather_OneUnitFails_NoMerge(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockProcessActivityFailSecond, activity.RegisterOptions{Name: "ProcessActivity"})

	wf := func(ctx workflow.Context) (types.ScatterGatherResult, error) {
		params := ScatterGatherParams{
			ProcessActivityName: "ProcessActivity",
			MergeActivityName:   "MergeActivity",
			TaskQueue:           "test-queue",
			ProcessTimeout:      time.Minute,
			HeartbeatTimeout:    30 * time.Second,
			MergeTimeout:        time.Minute,
			WorkUnits:           []interface{}{"unit0", "unit1"},
			MergeInput:          map[string]string{"jobId": "job-1"},
		}
		return RunScatterGather(ctx, params)
	}

	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

func mockProcessActivityFailSecond(input interface{}) (types.WorkUnitResult, error) {
	if s, ok := input.(string); ok && s == "unit1" {
		return types.WorkUnitResult{}, errors.New("unit1 failed")
	}
	return types.WorkUnitResult{SetID: "set-0", Status: "success"}, nil
}

func TestRunScatterGather_MergeFailsAfterAllUnitsSucceed(t *testing.T) {
	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(mockProcessActivity, activity.RegisterOptions{Name: "ProcessActivity"})
	env.RegisterActivityWithOptions(mockMergeActivityAlwaysFail, activity.RegisterOptions{Name: "MergeActivity"})

	wf := func(ctx workflow.Context) (types.ScatterGatherResult, error) {
		params := ScatterGatherParams{
			ProcessActivityName: "ProcessActivity",
			MergeActivityName:   "MergeActivity",
			TaskQueue:           "test-queue",
			ProcessTimeout:      time.Minute,
			HeartbeatTimeout:    30 * time.Second,
			MergeTimeout:        time.Minute,
			WorkUnits:           []interface{}{"a"},
			MergeInput:          map[string]string{"jobId": "job-1"},
		}
		return RunScatterGather(ctx, params)
	}

	env.RegisterWorkflow(wf)
	env.ExecuteWorkflow(wf)

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

func mockMergeActivityAlwaysFail(input interface{}) (interface{}, error) {
	return nil, errors.New("merge failed")
}
