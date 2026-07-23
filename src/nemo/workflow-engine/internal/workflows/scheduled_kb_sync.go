package workflows

import (
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ScheduledKBSyncWorkflow is the lightweight workflow target of a Temporal
// Schedule for KB synchronization. It does not chunk/embed itself; it asks
// the config-service to fire a regular KB reprocess so that the persisted
// KB row (latest chunking/embedding/quantization config) is read at trigger
// time. The real work happens inside KnowledgeBaseCreationWorkflow which is
// started by the config-service in response.
//
// This indirection means the Temporal Schedule can be created once at the
// time the user enables `sync_mode='scheduled'` and never needs to be
// reconciled when the KB's chunking/embedding settings later change.
func ScheduledKBSyncWorkflow(ctx workflow.Context, input activities.TriggerKBSyncInput) error {
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

	return workflow.ExecuteActivity(actx, activities.TriggerKBSyncActivity, input).Get(ctx, nil)
}
