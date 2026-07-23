package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ProjectAddUserWorkflow grants a user a specific role on a project.
// Implements §4.1: creates the user policy and merges it into the scope permission.
// Idempotent: calling twice with the same args is a no-op.
func ProjectAddUserWorkflow(ctx workflow.Context, input types.ProjectMembershipInput) error {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	log.Printf("[ProjectAddUserWorkflow] Starting for project: %q, user: %q, role: %q, workflowID: %q",
		input.ProjectId, input.UserId, input.Role, workflowID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	err := workflow.ExecuteActivity(ctx, "GrantProjectRoleActivity", input).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectAddUserWorkflow] ERROR: Failed to grant role %q to user %q on project %q: %v",
			input.Role, input.UserId, input.ProjectId, err)
		return fmt.Errorf("failed to grant project role: %w", err)
	}

	log.Printf("[ProjectAddUserWorkflow] Completed: granted role %q to user %q on project %q",
		input.Role, input.UserId, input.ProjectId)
	return nil
}

// ProjectRemoveUserWorkflow removes a user from all roles on a project.
// Implements §4.2: iterates admin, member, viewer and revokes each.
// Idempotent: skips missing entries.
func ProjectRemoveUserWorkflow(ctx workflow.Context, input types.ProjectMembershipInput) error {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	log.Printf("[ProjectRemoveUserWorkflow] Starting for project: %q, user: %q, workflowID: %q",
		input.ProjectId, input.UserId, workflowID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	roles := []string{"admin", "member", "viewer"}
	var lastErr error
	for _, role := range roles {
		revokeInput := types.ProjectMembershipInput{
			ProjectId: input.ProjectId,
			UserId:    input.UserId,
			Role:      role,
		}
		err := workflow.ExecuteActivity(ctx, "RevokeProjectRoleActivity", revokeInput).Get(ctx, nil)
		if err != nil {
			log.Printf("[ProjectRemoveUserWorkflow] ERROR: Failed to revoke role %q for user %q on project %q: %v",
				role, input.UserId, input.ProjectId, err)
			lastErr = err
		}
	}

	if lastErr != nil {
		return fmt.Errorf("failed to revoke one or more roles for user %s on project %s: %w",
			input.UserId, input.ProjectId, lastErr)
	}

	log.Printf("[ProjectRemoveUserWorkflow] Completed: removed user %q from all roles on project %q",
		input.UserId, input.ProjectId)
	return nil
}

// ProjectChangeRoleWorkflow changes a user's role on a project.
// Implements §5: remove-then-add (not in-place mutation).
// Both halves are idempotent, so retrying from a failed activity is safe.
func ProjectChangeRoleWorkflow(ctx workflow.Context, input types.ProjectMembershipInput) error {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	log.Printf("[ProjectChangeRoleWorkflow] Starting for project: %q, user: %q, newRole: %q, workflowID: %q",
		input.ProjectId, input.UserId, input.Role, workflowID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Step 1: Remove from all existing roles — must succeed before granting new role
	roles := []string{"admin", "member", "viewer"}
	for _, role := range roles {
		if role == input.Role {
			continue
		}
		revokeInput := types.ProjectMembershipInput{
			ProjectId: input.ProjectId,
			UserId:    input.UserId,
			Role:      role,
		}
		err := workflow.ExecuteActivity(ctx, "RevokeProjectRoleActivity", revokeInput).Get(ctx, nil)
		if err != nil {
			return fmt.Errorf("failed to revoke role %s before granting %s: %w", role, input.Role, err)
		}
	}

	// Step 2: Grant the new role
	err := workflow.ExecuteActivity(ctx, "GrantProjectRoleActivity", input).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectChangeRoleWorkflow] ERROR: Failed to grant new role %q to user %q: %v",
			input.Role, input.UserId, err)
		return fmt.Errorf("failed to grant new role: %w", err)
	}

	log.Printf("[ProjectChangeRoleWorkflow] Completed: changed user %q to role %q on project %q",
		input.UserId, input.Role, input.ProjectId)
	return nil
}
