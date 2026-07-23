package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ExplorerNode is the common node type returned by all explorer list operations.
type ExplorerNode struct {
	ID           string                 `json:"id"`
	Label        string                 `json:"label"`
	Type         string                 `json:"type"`
	Kind         string                 `json:"kind,omitempty"`
	ChildrenHint string                 `json:"childrenHint,omitempty"`
	Resource     map[string]interface{} `json:"resource,omitempty"`
	Metadata     map[string]interface{} `json:"metadata,omitempty"`
	Actions      []string               `json:"actions,omitempty"`
}

// ExplorerError is the structured error in the explorer response envelope.
type ExplorerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ExplorerResponse is the common envelope for all explorer list responses.
type ExplorerResponse struct {
	Nodes     []ExplorerNode `json:"nodes"`
	NextToken string         `json:"nextToken,omitempty"`
	Error     *ExplorerError `json:"error,omitempty"`
}

// ExplorerActionInput is the full input to the ExplorerAction Temporal activity.
type ExplorerActionInput struct {
	ProjectID        string                 `json:"projectId"`
	ConnectorID      string                 `json:"connectorId"`
	ConnectorConfig  map[string]interface{} `json:"connectorConfig"`
	CredentialID     string                 `json:"credentialId"`
	ConfigServiceURL string                 `json:"configServiceUrl"`
	Provider         string                 `json:"provider"`
	Scope            string                 `json:"scope"`
	Action           string                 `json:"action"`
	Payload          map[string]interface{} `json:"payload"`
}

// ExplorerSessionInput is the workflow input when starting an explorer session.
type ExplorerSessionInput struct {
	ProjectID        string                 `json:"projectId"`
	ConnectorID      string                 `json:"connectorId"`
	ConnectorConfig  map[string]interface{} `json:"connectorConfig"`
	CredentialID     string                 `json:"credentialId"`
	ConfigServiceURL string                 `json:"configServiceUrl"`
	Provider         string                 `json:"provider"`
	Scope            string                 `json:"scope"`
}

// ExplorerListRequest is the input to the List Update handler.
type ExplorerListRequest struct {
	Action  string                 `json:"action"`
	Payload map[string]interface{} `json:"payload"`
}

// ExplorerListInput is the input for the one-shot ExplorerListWorkflow.
type ExplorerListInput struct {
	ProjectID        string                 `json:"projectId"`
	ConnectorID      string                 `json:"connectorId"`
	ConnectorConfig  map[string]interface{} `json:"connectorConfig"`
	CredentialID     string                 `json:"credentialId"`
	ConfigServiceURL string                 `json:"configServiceUrl"`
	Provider         string                 `json:"provider"`
	Scope            string                 `json:"scope"`
	Action           string                 `json:"action"`
	Payload          map[string]interface{} `json:"payload"`
}

// ExplorerListWorkflow is a one-shot workflow that runs ExplorerAction and returns the result.
// Used when Temporal Update API is disabled (no long-running session workflow).
func ExplorerListWorkflow(ctx workflow.Context, input ExplorerListInput) (ExplorerResponse, error) {
	activityInput := ExplorerActionInput{
		ProjectID:        input.ProjectID,
		ConnectorID:      input.ConnectorID,
		ConnectorConfig:  input.ConnectorConfig,
		CredentialID:     input.CredentialID,
		ConfigServiceURL: input.ConfigServiceURL,
		Provider:         input.Provider,
		Scope:            input.Scope,
		Action:           input.Action,
		Payload:          input.Payload,
	}

	activityOptions := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 2 * time.Minute,
		HeartbeatTimeout:    45 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    2,
		},
	}
	actCtx := workflow.WithActivityOptions(ctx, activityOptions)

	var result ExplorerResponse
	err := workflow.ExecuteActivity(actCtx, "ExplorerAction", activityInput).Get(ctx, &result)
	if err != nil {
		return ExplorerResponse{
			Nodes: []ExplorerNode{},
			Error: &ExplorerError{
				Code:    "ACTIVITY_ERROR",
				Message: fmt.Sprintf("ExplorerAction failed: %v", err),
			},
		}, nil
	}
	return result, nil
}

// ExplorerSessionWorkflow is a long-running workflow that supports explorer operations
// via Temporal Updates. Each List call dispatches to the ExplorerAction activity.
// Use ExplorerListWorkflow (one-shot) instead when Update API is disabled on the namespace.
func ExplorerSessionWorkflow(ctx workflow.Context, input ExplorerSessionInput) error {
	idleTimeout := 30 * time.Minute

	err := workflow.SetUpdateHandler(ctx, "List", func(ctx workflow.Context, req ExplorerListRequest) (ExplorerResponse, error) {
		activityInput := ExplorerActionInput{
			ProjectID:        input.ProjectID,
			ConnectorID:      input.ConnectorID,
			ConnectorConfig:  input.ConnectorConfig,
			CredentialID:     input.CredentialID,
			ConfigServiceURL: input.ConfigServiceURL,
			Provider:         input.Provider,
			Scope:            input.Scope,
			Action:           req.Action,
			Payload:          req.Payload,
		}

		activityOptions := workflow.ActivityOptions{
			TaskQueue:           connectorOperationsQueue,
			StartToCloseTimeout: 2 * time.Minute,
			HeartbeatTimeout:    45 * time.Second,
			RetryPolicy: &temporal.RetryPolicy{
				InitialInterval:    2 * time.Second,
				BackoffCoefficient: 2.0,
				MaximumAttempts:    2,
			},
		}
		actCtx := workflow.WithActivityOptions(ctx, activityOptions)

		var result ExplorerResponse
		err := workflow.ExecuteActivity(actCtx, "ExplorerAction", activityInput).Get(ctx, &result)
		if err != nil {
			return ExplorerResponse{
				Nodes: []ExplorerNode{},
				Error: &ExplorerError{
					Code:    "ACTIVITY_ERROR",
					Message: fmt.Sprintf("ExplorerAction failed: %v", err),
				},
			}, nil
		}
		return result, nil
	})
	if err != nil {
		return fmt.Errorf("failed to register List update handler: %w", err)
	}

	// Keep the workflow alive until idle timeout. The timer resets on any update.
	for {
		timerCtx, cancelTimer := workflow.WithCancel(ctx)
		timerFuture := workflow.NewTimer(timerCtx, idleTimeout)

		selector := workflow.NewSelector(ctx)
		timerFired := false

		selector.AddFuture(timerFuture, func(f workflow.Future) {
			timerFired = true
		})

		selector.Select(ctx)

		if timerFired {
			cancelTimer()
			return nil
		}
		cancelTimer()
	}
}
