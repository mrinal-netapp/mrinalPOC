package workflows

import (
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ArtifactGCWorkflow archives stale session branches across every
// artifact-store bare repo on the shared NFS volume, and (optionally)
// triggers `git gc --auto` on each repo to keep pack files bounded.
//
// Intended to run via a Temporal schedule (daily). The workflow itself
// is a thin orchestrator; the heavy lifting happens in
// `RunArtifactGCActivity` which has access to the NFS mount.
func ArtifactGCWorkflow(ctx workflow.Context, input types.ArtifactGCInput) (types.ArtifactGCResult, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
		HeartbeatTimeout:    2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	actx := workflow.WithActivityOptions(ctx, ao)

	var result types.ArtifactGCResult
	if err := workflow.ExecuteActivity(actx, "RunArtifactGCActivity", input).Get(ctx, &result); err != nil {
		return types.ArtifactGCResult{}, err
	}
	return result, nil
}
