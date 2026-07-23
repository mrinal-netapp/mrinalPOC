package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

// ScatterGatherParams configures a ScatterGather execution.
type ScatterGatherParams struct {
	ProcessActivityName    string
	MergeActivityName      string
	TaskQueue              string
	ProcessTimeout         time.Duration
	HeartbeatTimeout       time.Duration
	ScheduleToStartTimeout time.Duration // 0 means server default (infinite)
	MergeTimeout           time.Duration
	WorkUnits              []interface{}
	MergeInput             interface{}
	RetryPolicy            *temporal.RetryPolicy
	OnUnitComplete         func(completed, total int)
	// OnUnitCompleteWithResult is called when a unit completes, with its result (e.g. for job-level completed-only stats).
	OnUnitCompleteWithResult func(completed, total int, result *types.WorkUnitResult)
}

// RunScatterGather executes the fan-out/collect/merge pattern. It dispatches
// WorkUnits as activities on the given TaskQueue, collects results via a
// Selector, and runs a merge activity at the end. The merge step always runs
// even if some units failed (subject to MaxFailureRate).
func RunScatterGather(ctx workflow.Context, params ScatterGatherParams) (types.ScatterGatherResult, error) {
	logger := workflow.GetLogger(ctx)

	total := len(params.WorkUnits)
	if total == 0 {
		return types.ScatterGatherResult{}, fmt.Errorf("no work units to scatter")
	}

	retryPolicy := params.RetryPolicy
	if retryPolicy == nil {
		retryPolicy = &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    5 * time.Minute,
			MaximumAttempts:    3,
		}
	}

	activityOpts := workflow.ActivityOptions{
		TaskQueue:           params.TaskQueue,
		StartToCloseTimeout: params.ProcessTimeout,
		HeartbeatTimeout:    params.HeartbeatTimeout,
		RetryPolicy:         retryPolicy,
		WaitForCancellation: true,
	}
	if params.ScheduleToStartTimeout > 0 {
		activityOpts.ScheduleToStartTimeout = params.ScheduleToStartTimeout
	}
	actCtx := workflow.WithActivityOptions(ctx, activityOpts)

	// Fan out: dispatch all work units
	selector := workflow.NewSelector(ctx)
	unitResults := make([]types.WorkUnitResult, total)
	completed := 0

	for i, unit := range params.WorkUnits {
		idx := i
		future := workflow.ExecuteActivity(actCtx, params.ProcessActivityName, unit)
		selector.AddFuture(future, func(f workflow.Future) {
			var result types.WorkUnitResult
			if err := f.Get(ctx, &result); err != nil {
				logger.Warn("Work unit failed", "index", idx, "error", err)
				unitResults[idx] = types.WorkUnitResult{
					Status: "error",
					Error:  err.Error(),
				}
				result = unitResults[idx]
			} else {
				unitResults[idx] = result
			}
			completed++
			if params.OnUnitComplete != nil {
				params.OnUnitComplete(completed, total)
			}
			if params.OnUnitCompleteWithResult != nil {
				params.OnUnitCompleteWithResult(completed, total, &result)
			}
		})
	}

	// Collect all results
	for i := 0; i < total; i++ {
		selector.Select(ctx)
	}

	// Count successes and failures
	succeeded := 0
	failed := 0
	for _, r := range unitResults {
		if r.Status == "success" {
			succeeded++
		} else {
			failed++
		}
	}

	result := types.ScatterGatherResult{
		UnitResults: unitResults,
		Succeeded:   succeeded,
		Failed:      failed,
	}

	// Fail immediately if any work unit failed — no partial success.
	if failed > 0 {
		return result, fmt.Errorf(
			"%d of %d work units failed", failed, total,
		)
	}

	// Run merge activity (only when all units succeeded)
	if params.MergeActivityName != "" && params.MergeInput != nil {
		mergeOpts := workflow.ActivityOptions{
			TaskQueue:           params.TaskQueue,
			StartToCloseTimeout: params.MergeTimeout,
			HeartbeatTimeout:    params.HeartbeatTimeout,
			RetryPolicy:         retryPolicy,
		}
		if params.ScheduleToStartTimeout > 0 {
			mergeOpts.ScheduleToStartTimeout = params.ScheduleToStartTimeout
		}
		mergeCtx := workflow.WithActivityOptions(ctx, mergeOpts)

		var mergeOutput interface{}
		err := workflow.ExecuteActivity(mergeCtx, params.MergeActivityName, params.MergeInput).Get(ctx, &mergeOutput)
		if err != nil {
			return result, fmt.Errorf("merge activity failed: %w", err)
		}
		result.MergeOutput = mergeOutput
	}

	logger.Info("ScatterGather completed", "succeeded", succeeded, "failed", failed, "total", total)
	return result, nil
}
