package activities

import (
	"context"
	"fmt"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

// ExecuteStepActivity is the main activity that executes a pipeline step
func ExecuteStepActivity(ctx context.Context, input types.StepExecutionInput) (types.StepResult, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("Executing step", "nodeId", input.NodeId, "nodeType", input.NodeType)

	result := types.StepResult{
		NodeId: input.NodeId,
		Status: "running",
	}

	// Route to appropriate activity based on node type
	switch input.NodeType {
	case "pod", "container":
		// Execute pod-related activities
		podResult, err := executePodStep(ctx, input)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Results = podResult
		return result, nil

	case "service":
		// Execute service-related activities
		serviceResult, err := executeServiceStep(ctx, input)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Results = serviceResult
		return result, nil

	case "scale":
		// Execute scaling activities
		scaleResult, err := executeScaleStep(ctx, input)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Results = scaleResult
		return result, nil

	case "crd", "custom-resource":
		// Execute CRD activities
		crdResult, err := executeCrdStep(ctx, input)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Results = crdResult
		return result, nil

	case "agent":
		// Agent block: handled at workflow level via InvokeAgentActivity
		// This case exists for backward compat if routed through ExecuteStepActivity
		agentResult, err := InvokeAgentActivity(ctx, input.Config)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Output = agentResult
		return result, nil

	case "response", "schedule", "human_in_the_loop":
		// These are handled at workflow level; no-op if routed here
		result.Status = "completed"
		return result, nil

	default:
		// Generic execution - create pod with custom image/command
		genericResult, err := executeGenericStep(ctx, input)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
			return result, err
		}
		result.Status = "completed"
		result.Results = genericResult
		return result, nil
	}
}

func executePodStep(ctx context.Context, input types.StepExecutionInput) (map[string]interface{}, error) {
	// This will be implemented in k8s_resources.go
	// For now, return placeholder
	return map[string]interface{}{
		"message": "Pod step executed",
		"nodeId":  input.NodeId,
	}, nil
}

func executeServiceStep(ctx context.Context, input types.StepExecutionInput) (map[string]interface{}, error) {
	// This will be implemented in k8s_resources.go
	return map[string]interface{}{
		"message": "Service step executed",
		"nodeId":  input.NodeId,
	}, nil
}

func executeScaleStep(ctx context.Context, input types.StepExecutionInput) (map[string]interface{}, error) {
	// This will be implemented in scaling.go
	return map[string]interface{}{
		"message": "Scale step executed",
		"nodeId":  input.NodeId,
	}, nil
}

func executeCrdStep(ctx context.Context, input types.StepExecutionInput) (map[string]interface{}, error) {
	// This will be implemented in crd.go
	return map[string]interface{}{
		"message": "CRD step executed",
		"nodeId":  input.NodeId,
	}, nil
}

func executeGenericStep(ctx context.Context, input types.StepExecutionInput) (map[string]interface{}, error) {
	// Generic step - typically creates a pod with custom image/command
	image, _ := input.Config["image"].(string)
	if image == "" {
		image = "python:3.11-slim"
	}

	// Create pod with the specified image
	podInput := types.PodCreationInput{
		Name:      fmt.Sprintf("pipeline-%s-%s", input.PipelineId, input.NodeId),
		Image:     image,
		Command:   getStringSlice(input.Config, "command"),
		Args:      getStringSlice(input.Config, "args"),
		Env:       getStringMap(input.Config, "env"),
		Resources: getResources(input.Config),
		Namespace: getString(input.Config, "namespace", "default"),
	}

	result, err := CreatePodActivity(ctx, podInput)
	if err != nil {
		return nil, fmt.Errorf("failed to create pod: %w", err)
	}

	return map[string]interface{}{
		"podName": result.PodName,
		"status":  result.Status,
	}, nil
}

// Helper functions
func getString(config map[string]interface{}, key, defaultValue string) string {
	if val, ok := config[key].(string); ok {
		return val
	}
	return defaultValue
}

func getStringSlice(config map[string]interface{}, key string) []string {
	if val, ok := config[key].([]interface{}); ok {
		result := make([]string, len(val))
		for i, v := range val {
			if str, ok := v.(string); ok {
				result[i] = str
			}
		}
		return result
	}
	return nil
}

func getStringMap(config map[string]interface{}, key string) map[string]string {
	if val, ok := config[key].(map[string]interface{}); ok {
		result := make(map[string]string)
		for k, v := range val {
			if str, ok := v.(string); ok {
				result[k] = str
			}
		}
		return result
	}
	return nil
}

func getResources(config map[string]interface{}) types.ResourceRequirements {
	reqs := types.ResourceRequirements{}
	if resources, ok := config["resources"].(map[string]interface{}); ok {
		if cpu, ok := resources["cpu"].(string); ok {
			reqs.CPU = cpu
		}
		if memory, ok := resources["memory"].(string); ok {
			reqs.Memory = memory
		}
	}
	return reqs
}
