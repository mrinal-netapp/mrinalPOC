package workflows

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// PipelineWorkflow orchestrates the execution of a pipeline DAG
func PipelineWorkflow(ctx workflow.Context, input types.PipelineWorkflowInput) (types.PipelineExecutionResult, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	result := types.PipelineExecutionResult{
		ExecutionId: input.ExecutionId,
		PipelineId:  input.PipelineId,
		Status:      "running",
		Steps:       []types.StepResult{},
	}

	configClient := clients.NewConfigClient("http://config-service:3000")
	_ = configClient

	// Data passing: outputs keyed by node ID
	outputs := make(map[string]map[string]interface{})

	// Persist initial execution status (best-effort)
	persistExecution(ctx, input, "running", "", nil, nil)

	executedNodes := make(map[string]bool)

	for len(executedNodes) < len(input.Pipeline.Graph.Nodes) {
		progress := false

		for _, node := range input.Pipeline.Graph.Nodes {
			if executedNodes[node.ID] {
				continue
			}

			ready := true
			for _, edge := range input.Pipeline.Graph.Edges {
				if edge.To == node.ID && !executedNodes[edge.From] {
					ready = false
					break
				}
			}

			if !ready {
				continue
			}

			// Build previousOutputs from inbound edges
			previousOutputs := buildPreviousOutputs(node.ID, input.Pipeline.Graph.Edges, outputs)

			var stepResult types.StepResult

			switch node.Type {
			case "schedule":
				// Schedule block is a no-op entry point at execution time
				stepResult = types.StepResult{
					NodeId: node.ID,
					Status: "completed",
					Output: map[string]interface{}{"trigger": "scheduled"},
				}

			case "human_in_the_loop":
				// HIL block runs at workflow level (not as activity) to support long waits
				stepResult = executeHILBlock(ctx, input, node, previousOutputs, outputs)

			case "response":
				// Response block assembles final output from all previous outputs
				stepResult = executeResponseBlock(node, outputs)
				if stepResult.Output != nil {
					result.FinalOutput = stepResult.Output
				}

			case "agent":
				// Agent block: invoke agent-service via activity
				stepResult = executeAgentBlock(ctx, input, node, previousOutputs)

			default:
				// Original behavior: route to ExecuteStepActivity
				targetCluster := determineTargetClusterV2(node, input.Pipeline)

				stepInput := types.StepExecutionInput{
					ClusterId:       targetCluster,
					NodeId:          node.ID,
					NodeType:        node.Type,
					Config:          node.Config,
					PipelineId:      input.PipelineId,
					ExecutionId:     input.ExecutionId,
					ProjectId:       input.ProjectId,
					PreviousOutputs: previousOutputs,
				}

				activityQueue := "pipeline-execution"
				if targetCluster != "" {
					activityQueue = fmt.Sprintf("ray-%s", targetCluster)
				}
				activityOptions := workflow.ActivityOptions{
					TaskQueue:           activityQueue,
					StartToCloseTimeout: 10 * time.Minute,
					RetryPolicy: &temporal.RetryPolicy{
						InitialInterval:    time.Second,
						BackoffCoefficient: 2.0,
						MaximumAttempts:    3,
					},
				}
				activityCtx := workflow.WithActivityOptions(ctx, activityOptions)
				err := workflow.ExecuteActivity(activityCtx, "ExecuteStepActivity", stepInput).Get(ctx, &stepResult)
				if err != nil {
					stepResult = types.StepResult{
						NodeId: node.ID,
						Status: "failed",
						Error:  err.Error(),
					}
				}
			}

			// Store output for data passing
			if stepResult.Output != nil {
				outputs[node.ID] = stepResult.Output
			} else if stepResult.Results != nil {
				outputs[node.ID] = stepResult.Results
			}

			result.Steps = append(result.Steps, stepResult)
			executedNodes[node.ID] = true
			progress = true

			// Persist step result (best-effort)
			persistStepResult(ctx, input, node.ID, stepResult)

			if stepResult.Status == "failed" || stepResult.Status == "timed_out" {
				result.Status = "failed"
				persistExecution(ctx, input, "failed", stepResult.Error, result.Steps, result.FinalOutput)
				return result, fmt.Errorf("step %s failed: %s", node.ID, stepResult.Error)
			}
		}

		if !progress {
			return result, fmt.Errorf("pipeline execution deadlock: unable to progress")
		}
	}

	result.Status = "completed"
	persistExecution(ctx, input, "completed", "", result.Steps, result.FinalOutput)
	return result, nil
}

// executeAgentBlock invokes agent-service asynchronously and polls for completion.
func executeAgentBlock(ctx workflow.Context, input types.PipelineWorkflowInput, node types.PipelineNode, previousOutputs map[string]map[string]interface{}) types.StepResult {
	stepResult := types.StepResult{
		NodeId: node.ID,
		Status: "running",
	}

	agentId, _ := node.Config["agentId"].(string)
	message, _ := node.Config["message"].(string)
	projectId := input.ProjectId
	if pid, ok := node.Config["projectId"].(string); ok && pid != "" {
		projectId = pid
	}

	// Interpolate variables in message
	message = interpolateVariables(message, previousOutputs)

	// Use long timeout for agent execution
	timeoutSec := 900 // 15 minutes default
	if t, ok := node.Config["timeoutSeconds"].(float64); ok {
		timeoutSec = int(t)
	}

	agentInput := map[string]interface{}{
		"agentId":        agentId,
		"projectId":      projectId,
		"message":        message,
		"executionId":    input.ExecutionId,
		"timeoutSeconds": timeoutSec,
	}

	activityOptions := workflow.ActivityOptions{
		TaskQueue:           "pipeline-execution",
		StartToCloseTimeout: time.Duration(timeoutSec+60) * time.Second,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
			InitialInterval: 10 * time.Second,
		},
	}
	activityCtx := workflow.WithActivityOptions(ctx, activityOptions)

	var agentOutput map[string]interface{}
	err := workflow.ExecuteActivity(activityCtx, "InvokeAgentActivity", agentInput).Get(ctx, &agentOutput)
	if err != nil {
		stepResult.Status = "failed"
		stepResult.Error = fmt.Sprintf("agent invocation failed: %v", err)
		return stepResult
	}

	stepResult.Status = "completed"
	stepResult.Output = agentOutput
	return stepResult
}

// executeHILBlock pauses the workflow and waits for human approval signal.
func executeHILBlock(ctx workflow.Context, input types.PipelineWorkflowInput, node types.PipelineNode, previousOutputs map[string]map[string]interface{}, outputs map[string]map[string]interface{}) types.StepResult {
	stepResult := types.StepResult{
		NodeId: node.ID,
		Status: "waiting_for_approval",
	}

	// Persist waiting status
	persistExecution(ctx, input, "waiting_for_approval", "", nil, nil)

	// Send notification (best-effort)
	inboundNodeID := getInboundSourceNode(node.ID, input.Pipeline.Graph.Edges)
	notifPayload := map[string]interface{}{
		"channel":     node.Config["notification"],
		"executionId": input.ExecutionId,
		"pipelineId":  input.PipelineId,
		"projectId":   input.ProjectId,
		"nodeId":      node.ID,
	}
	if inboundNodeID != "" {
		if data, ok := outputs[inboundNodeID]; ok {
			notifPayload["pendingData"] = data
		}
	}

	notifCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		TaskQueue:           "pipeline-execution",
	})
	_ = workflow.ExecuteActivity(notifCtx, "SendHILNotification", notifPayload).Get(ctx, nil)

	// Determine timeout (default 7 days)
	hilTimeout := 7 * 24 * time.Hour
	if timeoutStr, ok := node.Config["timeout"].(string); ok {
		if parsed, err := time.ParseDuration(timeoutStr); err == nil {
			hilTimeout = parsed
		}
	}

	// Wait for signal or timeout
	signalCh := workflow.GetSignalChannel(ctx, "hil_resume")
	var resumePayload types.HILResumePayload

	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	timerFuture := workflow.NewTimer(timerCtx, hilTimeout)

	selector := workflow.NewSelector(ctx)
	signalReceived := false

	selector.AddReceive(signalCh, func(ch workflow.ReceiveChannel, more bool) {
		ch.Receive(ctx, &resumePayload)
		cancelTimer()
		signalReceived = true
	})
	selector.AddFuture(timerFuture, func(f workflow.Future) {
		resumePayload = types.HILResumePayload{TimedOut: true}
	})
	selector.Select(ctx)

	if resumePayload.TimedOut {
		stepResult.Status = "timed_out"
		stepResult.Error = fmt.Sprintf("HIL approval timed out after %s", hilTimeout.String())
		return stepResult
	}

	// Filter analysis output by approved IDs
	if signalReceived && inboundNodeID != "" {
		analysisOutput := outputs[inboundNodeID]
		approvedItems := filterRecommendationsByIds(analysisOutput, resumePayload.ApprovedIds)
		stepResult.Output = map[string]interface{}{
			"approvedItems": approvedItems,
			"approvedIds":   resumePayload.ApprovedIds,
			"rejectedIds":   resumePayload.RejectedIds,
		}
	} else {
		stepResult.Output = map[string]interface{}{
			"approvedIds": resumePayload.ApprovedIds,
			"rejectedIds": resumePayload.RejectedIds,
		}
	}

	stepResult.Status = "completed"
	return stepResult
}

// executeResponseBlock assembles the final pipeline output from all previous outputs.
func executeResponseBlock(node types.PipelineNode, outputs map[string]map[string]interface{}) types.StepResult {
	stepResult := types.StepResult{
		NodeId: node.ID,
		Status: "completed",
	}

	finalOutput := map[string]interface{}{
		"$schema": "https://agentstudio.io/schemas/pipeline-output/v1",
	}

	// Merge all previous outputs into the final output
	for nodeId, output := range outputs {
		finalOutput[nodeId] = output
	}

	// If response block has a template/format config, use it
	if template, ok := node.Config["template"].(map[string]interface{}); ok {
		for k, v := range template {
			if vStr, ok := v.(string); ok {
				finalOutput[k] = interpolateVariables(vStr, outputs)
			} else {
				finalOutput[k] = v
			}
		}
	}

	stepResult.Output = finalOutput
	return stepResult
}

// determineTargetClusterV2 routes pipeline-native blocks to the local queue.
func determineTargetClusterV2(node types.PipelineNode, pipeline *types.Pipeline) string {
	if queue, ok := node.Config["taskQueue"].(string); ok {
		return queue
	}
	switch node.Type {
	case "agent", "human_in_the_loop", "response", "schedule":
		return "" // use workflow's own queue
	default:
		return "us-east-1" // backward-compatible for pod/container types
	}
}

// buildPreviousOutputs constructs the map of outputs from inbound edges' source nodes.
func buildPreviousOutputs(nodeID string, edges []types.PipelineEdge, outputs map[string]map[string]interface{}) map[string]map[string]interface{} {
	prev := make(map[string]map[string]interface{})
	for _, edge := range edges {
		if edge.To == nodeID {
			if output, ok := outputs[edge.From]; ok {
				prev[edge.From] = output
			}
		}
	}
	return prev
}

// interpolateVariables replaces {{nodeId.field}} placeholders with actual values.
func interpolateVariables(template string, outputs map[string]map[string]interface{}) string {
	re := regexp.MustCompile(`\{\{([^}]+)\}\}`)
	return re.ReplaceAllStringFunc(template, func(match string) string {
		path := strings.TrimSpace(match[2 : len(match)-2])
		parts := strings.SplitN(path, ".", 2)
		if len(parts) < 2 {
			return match
		}
		nodeId := parts[0]
		fieldPath := parts[1]

		nodeOutput, ok := outputs[nodeId]
		if !ok {
			return match
		}

		value := resolveFieldPath(nodeOutput, fieldPath)
		if value == nil {
			return match
		}

		switch v := value.(type) {
		case string:
			return v
		default:
			jsonBytes, err := json.Marshal(v)
			if err != nil {
				return match
			}
			return string(jsonBytes)
		}
	})
}

// resolveFieldPath navigates a nested map using dot-separated path.
func resolveFieldPath(data map[string]interface{}, path string) interface{} {
	parts := strings.Split(path, ".")
	var current interface{} = data

	for _, part := range parts {
		switch v := current.(type) {
		case map[string]interface{}:
			current = v[part]
		default:
			return nil
		}
	}
	return current
}

// getInboundSourceNode returns the first inbound edge's source node ID.
func getInboundSourceNode(nodeID string, edges []types.PipelineEdge) string {
	for _, edge := range edges {
		if edge.To == nodeID {
			return edge.From
		}
	}
	return ""
}

// filterRecommendationsByIds filters analysis output recommendations by approved IDs.
func filterRecommendationsByIds(analysisOutput map[string]interface{}, approvedIds []string) []interface{} {
	if analysisOutput == nil {
		return nil
	}

	recommendations, ok := analysisOutput["recommendations"]
	if !ok {
		return nil
	}

	recsSlice, ok := recommendations.([]interface{})
	if !ok {
		return nil
	}

	approvedSet := make(map[string]bool)
	for _, id := range approvedIds {
		approvedSet[id] = true
	}

	var approved []interface{}
	for _, rec := range recsSlice {
		recMap, ok := rec.(map[string]interface{})
		if !ok {
			continue
		}
		if id, ok := recMap["id"].(string); ok && approvedSet[id] {
			approved = append(approved, rec)
		}
	}
	return approved
}

// persistExecution updates execution status via activity (best-effort).
func persistExecution(ctx workflow.Context, input types.PipelineWorkflowInput, status, errMsg string, steps []types.StepResult, finalOutput map[string]interface{}) {
	payload := map[string]interface{}{
		"executionId": input.ExecutionId,
		"pipelineId":  input.PipelineId,
		"projectId":   input.ProjectId,
		"status":      status,
	}
	if errMsg != "" {
		payload["error"] = errMsg
	}
	if steps != nil {
		payload["stepResults"] = steps
	}
	if finalOutput != nil {
		payload["finalOutput"] = finalOutput
	}

	persistCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		TaskQueue:           "pipeline-execution",
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
		},
	})
	_ = workflow.ExecuteActivity(persistCtx, "PersistExecutionStatus", payload).Get(ctx, nil)
}

// persistStepResult persists a single step result (best-effort).
func persistStepResult(ctx workflow.Context, input types.PipelineWorkflowInput, nodeId string, stepResult types.StepResult) {
	payload := map[string]interface{}{
		"executionId": input.ExecutionId,
		"pipelineId":  input.PipelineId,
		"projectId":   input.ProjectId,
		"nodeId":      nodeId,
		"stepResult":  stepResult,
	}

	persistCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Second,
		TaskQueue:           "pipeline-execution",
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
		},
	})
	_ = workflow.ExecuteActivity(persistCtx, "PersistStepResult", payload).Get(ctx, nil)
}
