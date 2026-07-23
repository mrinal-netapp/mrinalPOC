package workflows

import (
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// DependencyLineageSyncWorkflow discovers cross-entity dependencies and
// maintains usage/lineage information. The work itself lives in
// config-service (where the catalog and TypeORM entities are); the
// workflow + activity here are a thin Temporal trigger that survives
// restarts and gives us exactly-once-per-tick scheduling for free across
// config-service replicas.
func DependencyLineageSyncWorkflow(
	ctx workflow.Context,
	input types.ReferenceEdgeReconcileInput,
) (types.ReferenceEdgeReconcileResult, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		HeartbeatTimeout:    1 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	actx := workflow.WithActivityOptions(ctx, ao)

	var result types.ReferenceEdgeReconcileResult
	if err := workflow.ExecuteActivity(actx, "RunReferenceEdgeReconcileActivity", input).Get(ctx, &result); err != nil {
		return types.ReferenceEdgeReconcileResult{}, err
	}

	// Step 2: Build lineage graphs from the freshly reconciled edges
	var graphResult types.BuildLineageGraphResult
	if err := workflow.ExecuteActivity(actx, "BuildLineageGraphActivity", input).Get(ctx, &graphResult); err != nil {
		return types.ReferenceEdgeReconcileResult{}, err
	}
	_ = graphResult // logged inside the activity

	return result, nil
}
