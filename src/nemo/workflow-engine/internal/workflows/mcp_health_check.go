package workflows

import (
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

func MCPHealthCheckWorkflow(ctx workflow.Context, input types.MCPHealthCheckInput) (types.MCPHealthCheckResult, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 3 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	actx := workflow.WithActivityOptions(ctx, ao)

	var result types.MCPHealthCheckResult
	if err := workflow.ExecuteActivity(actx, "RunMCPHealthCheckActivity", input).Get(ctx, &result); err != nil {
		return types.MCPHealthCheckResult{}, err
	}
	return result, nil
}
