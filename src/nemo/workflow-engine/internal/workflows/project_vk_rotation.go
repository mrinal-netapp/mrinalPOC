package workflows

import (
	"fmt"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const defaultProjectVKRotationGrace = 30 * time.Minute

// ProjectVirtualKeyRotationWorkflow rotates one project's Bifrost virtual key:
// POST .../rotate (secondary sk-bf-* → K8s), grace sleep, promote-secondary.
func ProjectVirtualKeyRotationWorkflow(ctx workflow.Context, input types.ProjectVKRotationInput) error {
	grace := input.GracePeriod
	if grace <= 0 {
		grace = defaultProjectVKRotationGrace
	}

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	actx := workflow.WithActivityOptions(ctx, ao)

	var rotateResult types.RotateProjectVirtualKeyResult
	err := workflow.ExecuteActivity(actx, "RotateProjectVirtualKeyActivity", input).Get(ctx, &rotateResult)
	if err != nil {
		return err
	}
	if rotateResult.Skipped {
		workflow.GetLogger(ctx).Info("VK rotation skipped",
			"projectId", input.ProjectId,
			"reason", rotateResult.SkipReason,
		)
		return nil
	}

	if err := workflow.Sleep(ctx, grace); err != nil {
		return err
	}

	var completeResult types.DeleteRetiredProjectVirtualKeyResult
	if err := workflow.ExecuteActivity(actx, "DeleteRetiredProjectVirtualKeyActivity", input).Get(ctx, &completeResult); err != nil {
		return err
	}
	workflow.GetLogger(ctx).Info("VK rotation complete",
		"projectId", input.ProjectId,
		"retiredDeleted", completeResult.Deleted,
		"retiredId", completeResult.RetiredVirtualKeyId,
	)
	return nil
}

// ScheduledProjectVirtualKeyRotationWorkflow is the Temporal schedule target.
// It lists projects with active gateway VKs and starts a child rotation workflow
// per project so grace-period sleeps do not block the entire fleet.
func ScheduledProjectVirtualKeyRotationWorkflow(
	ctx workflow.Context,
	input types.ScheduledProjectVKRotationInput,
) (types.ScheduledProjectVKRotationResult, error) {
	grace := input.GracePeriod
	if grace <= 0 {
		grace = defaultProjectVKRotationGrace
	}

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	actx := workflow.WithActivityOptions(ctx, ao)

	var listResult types.ListProjectsForVKRotationResult
	if err := workflow.ExecuteActivity(actx, "ListProjectsForVKRotationActivity", input).Get(ctx, &listResult); err != nil {
		return types.ScheduledProjectVKRotationResult{}, err
	}

	result := types.ScheduledProjectVKRotationResult{
		ProjectsFound: len(listResult.ProjectIds),
	}

	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	// Start one child per project and return immediately. Each child runs
	// rotate → grace sleep → delete on its own timeline; waiting here would
	// serialize fleet-wide rotation behind every project's grace period.
	for _, projectId := range listResult.ProjectIds {
		childInput := types.ProjectVKRotationInput{
			ProjectId:        projectId,
			ConfigServiceURL: input.ConfigServiceURL,
			GracePeriod:      grace,
		}
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID:          fmt.Sprintf("project-vk-rotation-%s-%s", projectId, runID),
			TaskQueue:           workflow.GetInfo(ctx).TaskQueueName,
			WorkflowRunTimeout:  grace + 15*time.Minute,
			WorkflowTaskTimeout: time.Minute,
			ParentClosePolicy:   enumspb.PARENT_CLOSE_POLICY_ABANDON,
		})

		workflow.ExecuteChildWorkflow(childCtx, ProjectVirtualKeyRotationWorkflow, childInput)
		result.RotationsStarted++
	}

	return result, nil
}
