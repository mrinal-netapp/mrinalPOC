package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
)

var agentServiceURL = getEnvOrDefault("AGENT_SERVICE_URL", "http://agent-service:8000")
var agentServiceToken = os.Getenv("AGENT_SERVICE_TOKEN")

// InvokeAgentActivity calls agent-service async and polls for completion.
func InvokeAgentActivity(ctx context.Context, input map[string]interface{}) (map[string]interface{}, error) {
	logger := activity.GetLogger(ctx)

	agentId, _ := input["agentId"].(string)
	projectId, _ := input["projectId"].(string)
	message, _ := input["message"].(string)
	timeoutSec := 900
	if t, ok := input["timeoutSeconds"].(float64); ok {
		timeoutSec = int(t)
	}

	if agentId == "" || message == "" {
		return nil, fmt.Errorf("agentId and message are required")
	}

	logger.Info("Invoking agent", "agentId", agentId, "projectId", projectId)

	// Async invoke
	invokeURL := fmt.Sprintf("%s/api/v1/projects/%s/agents/%s/invoke/async", agentServiceURL, projectId, agentId)
	invokeBody := map[string]interface{}{
		"message": message,
	}
	bodyBytes, _ := json.Marshal(invokeBody)

	req, err := http.NewRequestWithContext(ctx, "POST", invokeURL, strings.NewReader(string(bodyBytes)))
	if err != nil {
		return nil, fmt.Errorf("failed to create invoke request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	setAuthHeaders(req, projectId)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to invoke agent: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusAccepted {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("agent invoke returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var invokeResp map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&invokeResp); err != nil {
		return nil, fmt.Errorf("failed to decode invoke response: %w", err)
	}

	taskId, _ := invokeResp["taskId"].(string)
	if taskId == "" {
		// Synchronous response: agent already completed
		if response, ok := invokeResp["response"].(string); ok {
			return parseAgentResponse(response)
		}
		if parsedOutput, ok := invokeResp["parsedOutput"].(map[string]interface{}); ok {
			return parsedOutput, nil
		}
		return invokeResp, nil
	}

	// Poll for completion
	deadline := time.Now().Add(time.Duration(timeoutSec) * time.Second)
	pollURL := fmt.Sprintf("%s/api/v1/projects/%s/tasks/%s", agentServiceURL, projectId, taskId)

	for time.Now().Before(deadline) {
		activity.RecordHeartbeat(ctx, fmt.Sprintf("polling agent task %s", taskId))

		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		pollReq, err := http.NewRequestWithContext(ctx, "GET", pollURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create poll request: %w", err)
		}
		setAuthHeaders(pollReq, projectId)

		pollResp, err := client.Do(pollReq)
		if err != nil {
			logger.Warn("Poll request failed, retrying", "error", err)
			time.Sleep(5 * time.Second)
			continue
		}

		var taskResult map[string]interface{}
		json.NewDecoder(pollResp.Body).Decode(&taskResult)
		pollResp.Body.Close()

		status, _ := taskResult["status"].(string)
		switch status {
		case "completed":
			if parsedOutput, ok := taskResult["parsedOutput"].(map[string]interface{}); ok {
				return parsedOutput, nil
			}
			if response, ok := taskResult["response"].(string); ok {
				return parseAgentResponse(response)
			}
			return taskResult, nil

		case "failed":
			errMsg, _ := taskResult["error"].(string)
			return nil, fmt.Errorf("agent task failed: %s", errMsg)
		}

		time.Sleep(5 * time.Second)
	}

	return nil, fmt.Errorf("agent task %s timed out after %d seconds", taskId, timeoutSec)
}

// SendHILNotification sends a notification for human-in-the-loop approval.
func SendHILNotification(ctx context.Context, payload map[string]interface{}) error {
	logger := activity.GetLogger(ctx)
	logger.Info("Sending HIL notification", "payload", payload)

	channel, _ := payload["channel"].(string)
	if channel == "" {
		channel = "log"
	}

	switch channel {
	case "slack":
		return sendSlackNotification(payload)
	default:
		logger.Info("HIL notification (log only)", "executionId", payload["executionId"])
		return nil
	}
}

// PersistExecutionStatus updates execution status in config-service.
func PersistExecutionStatus(ctx context.Context, payload map[string]interface{}) error {
	logger := activity.GetLogger(ctx)
	executionId, _ := payload["executionId"].(string)
	pipelineId, _ := payload["pipelineId"].(string)
	projectId, _ := payload["projectId"].(string)

	configURL := getEnvOrDefault("CONFIG_SERVICE_URL", "http://config-service:3000")
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions/%s", configURL, projectId, pipelineId, executionId)

	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "PUT", url, strings.NewReader(string(bodyBytes)))
	if err != nil {
		logger.Warn("Failed to create persist request", "error", err)
		return nil
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logger.Warn("Failed to persist execution status", "error", err)
		return nil
	}
	resp.Body.Close()
	return nil
}

// PersistStepResult updates a single step result in config-service.
func PersistStepResult(ctx context.Context, payload map[string]interface{}) error {
	logger := activity.GetLogger(ctx)
	executionId, _ := payload["executionId"].(string)
	pipelineId, _ := payload["pipelineId"].(string)
	projectId, _ := payload["projectId"].(string)

	configURL := getEnvOrDefault("CONFIG_SERVICE_URL", "http://config-service:3000")
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions/%s/steps", configURL, projectId, pipelineId, executionId)

	bodyBytes, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "PUT", url, strings.NewReader(string(bodyBytes)))
	if err != nil {
		logger.Warn("Failed to create step persist request", "error", err)
		return nil
	}
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		logger.Warn("Failed to persist step result", "error", err)
		return nil
	}
	resp.Body.Close()
	return nil
}

func parseAgentResponse(response string) (map[string]interface{}, error) {
	var result map[string]interface{}
	if err := json.Unmarshal([]byte(response), &result); err != nil {
		// Try stripping markdown code block wrapper
		stripped := strings.TrimSpace(response)
		if strings.HasPrefix(stripped, "```json") {
			stripped = stripped[7:]
		} else if strings.HasPrefix(stripped, "```") {
			stripped = stripped[3:]
		}
		if strings.HasSuffix(stripped, "```") {
			stripped = stripped[:len(stripped)-3]
		}
		stripped = strings.TrimSpace(stripped)

		if err := json.Unmarshal([]byte(stripped), &result); err != nil {
			return map[string]interface{}{"response": response}, nil
		}
		return result, nil
	}
	return result, nil
}

func setAuthHeaders(req *http.Request, projectId string) {
	if agentServiceToken != "" {
		req.Header.Set("Authorization", "Bearer "+agentServiceToken)
	}
	if projectId != "" {
		req.Header.Set("X-Project-Id", projectId)
	}
}

func sendSlackNotification(payload map[string]interface{}) error {
	// Placeholder: integrate with Slack webhook
	return nil
}

func getEnvOrDefault(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}
