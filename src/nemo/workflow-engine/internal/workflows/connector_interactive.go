package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ConnectorInteractiveInput is the input for interactive connector operations (test, discover, preview).
type ConnectorInteractiveInput struct {
	ProjectID        string                 `json:"projectID"`
	CredentialID     string                 `json:"credentialID"`
	ConnectorConfig  map[string]interface{} `json:"connectorConfig"`
	ConfigServiceURL string                 `json:"configServiceURL"`
	ActivityName     string                 `json:"activityName"`
}

// ConnectorInteractiveResult is the result of an interactive connector operation.
type ConnectorInteractiveResult struct {
	Success bool                   `json:"success"`
	Message string                 `json:"message,omitempty"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

// ConnectorInteractiveWorkflow dispatches a single activity to the connector-worker
// and returns its result. Used for test, discover, and preview operations.
func ConnectorInteractiveWorkflow(ctx workflow.Context, input ConnectorInteractiveInput) (ConnectorInteractiveResult, error) {
	activityOptions := workflow.ActivityOptions{
		TaskQueue:           connectorOperationsQueue,
		StartToCloseTimeout: 60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    1,
		},
	}
	activityCtx := workflow.WithActivityOptions(ctx, activityOptions)

	activityInput := map[string]interface{}{
		"projectID":        input.ProjectID,
		"credentialID":     input.CredentialID,
		"connectorConfig":  input.ConnectorConfig,
		"configServiceURL": input.ConfigServiceURL,
	}

	var activityResult map[string]interface{}
	err := workflow.ExecuteActivity(activityCtx, input.ActivityName, activityInput).Get(ctx, &activityResult)
	if err != nil {
		return ConnectorInteractiveResult{
			Success: false,
			Message: fmt.Sprintf("Activity %s failed: %v", input.ActivityName, err),
		}, fmt.Errorf("activity %s failed: %w", input.ActivityName, err)
	}

	// The activity itself may return success=false (e.g. connection refused)
	if success, ok := activityResult["success"].(bool); ok && !success {
		msg := "Operation failed"
		if m, ok := activityResult["message"].(string); ok {
			msg = m
		}
		return ConnectorInteractiveResult{
			Success: false,
			Message: msg,
			Data:    activityResult,
		}, fmt.Errorf("%s", msg)
	}

	msg := "Operation completed successfully"
	if m, ok := activityResult["message"].(string); ok {
		msg = m
	}

	return ConnectorInteractiveResult{
		Success: true,
		Message: msg,
		Data:    activityResult,
	}, nil
}
