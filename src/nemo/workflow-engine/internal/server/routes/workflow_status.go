package routes

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
)

// WorkflowStatusResponse is the uniform response for workflow status queries.
// It is intentionally generic and workflow-type-agnostic so the same schema
// works for KB creation, dataset import, pipeline execution, etc.
type WorkflowStatusResponse struct {
	WorkflowId        string  `json:"workflowId"`
	RunId             string  `json:"runId"`
	WorkflowType      string  `json:"workflowType"`
	Status            string  `json:"status"`
	StartTime         *string `json:"startTime,omitempty"`
	EndTime           *string `json:"endTime,omitempty"`
	ExecutionDuration *string `json:"executionDuration,omitempty"`
	TaskQueue         string  `json:"taskQueue,omitempty"`
	HistoryLength     int64   `json:"historyLength"`
	// Derived helpers
	WorkflowCategory string `json:"workflowCategory"` // e.g. "kb-creation", "dataset-import"
	IsRunning        bool   `json:"isRunning"`
	// Error info (populated for failed workflows)
	FailureMessage string `json:"failureMessage,omitempty"`
	FailureDetails string `json:"failureDetails,omitempty"`
}

// WorkflowLogEntry represents a single event from the Temporal workflow history.
type WorkflowLogEntry struct {
	EventId   int64  `json:"eventId"`
	EventType string `json:"eventType"`
	Timestamp string `json:"timestamp"`
	Details   string `json:"details,omitempty"`
}

// WorkflowLogsResponse is the response for the workflow logs endpoint.
type WorkflowLogsResponse struct {
	WorkflowId string             `json:"workflowId"`
	Entries    []WorkflowLogEntry `json:"entries"`
	Total      int                `json:"total"`
}

// SetupWorkflowStatusRoutes registers the generic workflow lifecycle endpoints.
func SetupWorkflowStatusRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	workflows := router.Group("/workflows")
	{
		// Lifecycle: start + query a workflow. Used by the eval-worker trigger
		// surface (and any other client that wants a generic Temporal start
		// without going through a type-specific route).
		workflows.POST("", func(c *gin.Context) {
			postWorkflowStart(c, executorService)
		})
		workflows.POST("/:workflowId/query/:queryName", func(c *gin.Context) {
			postWorkflowQuery(c, executorService)
		})
		workflows.GET("/:workflowId/status", func(c *gin.Context) {
			getWorkflowStatus(c, executorService)
		})
		workflows.GET("/:workflowId/result", func(c *gin.Context) {
			getWorkflowResult(c, executorService)
		})
		workflows.GET("/:workflowId/logs", func(c *gin.Context) {
			getWorkflowLogs(c, executorService)
		})
		workflows.POST("/:workflowId/cancel", func(c *gin.Context) {
			postWorkflowCancel(c, executorService)
		})
		workflows.POST("/:workflowId/signal/:signalName", func(c *gin.Context) {
			postWorkflowSignal(c, executorService)
		})
	}
}

// startWorkflowRequest is the body of POST /workflows.
type startWorkflowRequest struct {
	WorkflowName string        `json:"workflowName"`
	WorkflowID   string        `json:"workflowId"`
	TaskQueue    string        `json:"taskQueue"`
	Args         []interface{} `json:"args"`
}

// startWorkflowResponse mirrors the upstream eval-helpers contract:
// the caller-supplied workflowId is echoed back along with the active runId.
type startWorkflowResponse struct {
	WorkflowID string `json:"workflowId"`
	RunID      string `json:"runId"`
}

// postWorkflowStart starts a Temporal workflow by name on a caller-supplied task queue.
// Idempotent on workflowId: if a workflow with the same ID is already running, the
// existing handle is returned instead of 409. Matches the upstream eval-helpers
// behaviour ("swallows WorkflowExecutionAlreadyStartedError").
func postWorkflowStart(c *gin.Context, executorService *services.ExecutorService) {
	var body startWorkflowRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid body: %v", err)})
		return
	}
	if body.WorkflowName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowName is required"})
		return
	}
	if body.WorkflowID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}
	if body.TaskQueue == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "taskQueue is required"})
		return
	}

	tc := executorService.GetTemporalClient()
	ctx := c.Request.Context()

	// REJECT_DUPLICATE so retries of the same workflowId — including retries
	// against an already-completed run — surface AlreadyStarted with the
	// existing RunId rather than silently spawning a fresh execution. This is
	// what the upstream trigger.ts assumes when it says workflow-engine
	// "swallows WorkflowExecutionAlreadyStartedError".
	opts := client.StartWorkflowOptions{
		ID:                    body.WorkflowID,
		TaskQueue:             body.TaskQueue,
		WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
	}

	wfRun, err := tc.ExecuteWorkflow(ctx, opts, body.WorkflowName, body.Args...)
	if err != nil {
		var already *serviceerror.WorkflowExecutionAlreadyStarted
		if errors.As(err, &already) {
			// Return the existing handle so the caller doesn't have to special-case
			// retries. RunId comes from the AlreadyStarted error payload.
			c.JSON(http.StatusOK, startWorkflowResponse{
				WorkflowID: body.WorkflowID,
				RunID:      already.RunId,
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to start workflow: %v", err)})
		return
	}

	c.JSON(http.StatusOK, startWorkflowResponse{
		WorkflowID: wfRun.GetID(),
		RunID:      wfRun.GetRunID(),
	})
}

// queryWorkflowRequest is the optional body of POST /workflows/:id/query/:name.
type queryWorkflowRequest struct {
	Args []interface{} `json:"args"`
}

// postWorkflowQuery dispatches a query against a running workflow. Returns the
// raw query result as JSON. Returns 502 on query/decoding errors and 404 when
// the workflow execution is not found.
func postWorkflowQuery(c *gin.Context, executorService *services.ExecutorService) {
	workflowID := c.Param("workflowId")
	queryName := c.Param("queryName")
	if workflowID == "" || queryName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId and queryName are required"})
		return
	}

	var body queryWorkflowRequest
	_ = c.ShouldBindJSON(&body) // empty body / no args is valid

	tc := executorService.GetTemporalClient()
	ctx := c.Request.Context()

	qr, err := tc.QueryWorkflow(ctx, workflowID, "", queryName, body.Args...)
	if err != nil {
		var notFound *serviceerror.NotFound
		if errors.As(err, &notFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowID)})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("query failed: %v", err)})
		return
	}

	var result interface{}
	if err := qr.Get(&result); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("query decode failed: %v", err)})
		return
	}
	c.JSON(http.StatusOK, result)
}

// deriveCategory extracts a human-readable category from the deterministic workflow ID.
// Examples: "kb-creation-proj-123-kb-456" -> "kb-creation"
//
//	"dataset-import-proj-123-ds-456" -> "dataset-import"
//	"pipeline-proj-123-pipe-456-exec-789" -> "pipeline"
func deriveCategory(workflowId string) string {
	prefixes := []string{
		"kb-creation",
		"kb-delete",
		"dataset-import",
		"dataset-delete",
		"table-processing",
		"project-init",
		"project-delete",
		"pipeline",
	}
	for _, p := range prefixes {
		if strings.HasPrefix(workflowId, p+"-") {
			return p
		}
	}
	return "unknown"
}

// mapWorkflowStatus converts the Temporal enum to a human-readable string.
func mapWorkflowStatus(s enumspb.WorkflowExecutionStatus) string {
	switch s {
	case enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING:
		return "running"
	case enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED:
		return "completed"
	case enumspb.WORKFLOW_EXECUTION_STATUS_FAILED:
		return "failed"
	case enumspb.WORKFLOW_EXECUTION_STATUS_CANCELED:
		return "cancelled"
	case enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED:
		return "terminated"
	case enumspb.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW:
		return "continued_as_new"
	case enumspb.WORKFLOW_EXECUTION_STATUS_TIMED_OUT:
		return "timed_out"
	default:
		return "unknown"
	}
}

// getWorkflowStatus returns metadata for a single workflow by its Temporal workflow ID.
func getWorkflowStatus(c *gin.Context, executorService *services.ExecutorService) {
	workflowId := c.Param("workflowId")
	if workflowId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}

	tc := executorService.GetTemporalClient()

	// DescribeWorkflowExecution gives us status, times, task queue, etc.
	desc, err := tc.DescribeWorkflowExecution(c.Request.Context(), workflowId, "")
	if err != nil {
		// Check if it's a "not found" type error
		errMsg := err.Error()
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "NotFound") {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowId)})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to describe workflow: %v", err)})
		return
	}

	info := desc.WorkflowExecutionInfo
	status := mapWorkflowStatus(info.Status)
	isRunning := info.Status == enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING

	resp := WorkflowStatusResponse{
		WorkflowId:       info.Execution.WorkflowId,
		RunId:            info.Execution.RunId,
		WorkflowType:     info.Type.Name,
		Status:           status,
		TaskQueue:        info.TaskQueue,
		HistoryLength:    info.HistoryLength,
		WorkflowCategory: deriveCategory(info.Execution.WorkflowId),
		IsRunning:        isRunning,
	}

	if info.StartTime != nil {
		t := info.StartTime.Format(time.RFC3339)
		resp.StartTime = &t
	}
	if info.CloseTime != nil {
		t := info.CloseTime.Format(time.RFC3339)
		resp.EndTime = &t
		if info.StartTime != nil {
			dur := info.CloseTime.Sub(*info.StartTime).Round(time.Second).String()
			resp.ExecutionDuration = &dur
		}
	}

	// For failed workflows, try to get the failure reason from the last history event
	if info.Status == enumspb.WORKFLOW_EXECUTION_STATUS_FAILED {
		failure := extractFailureFromHistory(c, tc, workflowId)
		if failure != "" {
			resp.FailureMessage = failure
		}
	}

	c.JSON(http.StatusOK, resp)
}

// getWorkflowResult returns the result payload of a completed workflow.
// Returns 404 if workflow not found, 409 if workflow is not yet completed.
func getWorkflowResult(c *gin.Context, executorService *services.ExecutorService) {
	workflowId := c.Param("workflowId")
	if workflowId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}

	tc := executorService.GetTemporalClient()
	ctx := c.Request.Context()
	// Empty runID uses the latest run for this workflow ID
	run := tc.GetWorkflow(ctx, workflowId, "")

	var result map[string]interface{}
	err := run.Get(ctx, &result)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "NotFound") {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowId)})
			return
		}
		if strings.Contains(errMsg, "workflow is still running") {
			c.JSON(http.StatusConflict, gin.H{"error": "workflow has not completed yet"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to get workflow result: %v", err)})
		return
	}

	c.JSON(http.StatusOK, result)
}

// cancelRequest is the optional body for POST /workflows/:workflowId/cancel
type cancelRequest struct {
	RunId string `json:"runId"`
}

// postWorkflowCancel requests cancellation of a workflow by ID.
// Body (optional): { "runId": "..." }. If runId is omitted or empty, the current run is cancelled.
// Returns 200 with { "status": "cancelled" } on success or when already cancelled/completed (idempotent).
func postWorkflowCancel(c *gin.Context, executorService *services.ExecutorService) {
	workflowId := c.Param("workflowId")
	if workflowId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}

	var body cancelRequest
	_ = c.ShouldBindJSON(&body) // empty body or {} is valid; runId stays ""
	runId := strings.TrimSpace(body.RunId)
	err := executorService.CancelWorkflowByID(c.Request.Context(), workflowId, runId)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "NotFound") {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowId)})
			return
		}
		// Already completed or already cancelled: treat as success (idempotent)
		if strings.Contains(strings.ToLower(errMsg), "already completed") ||
			strings.Contains(strings.ToLower(errMsg), "already cancelled") ||
			strings.Contains(strings.ToLower(errMsg), "already canceled") {
			c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to cancel workflow: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
}

// signalRequest is the optional body for POST /workflows/:workflowId/signal/:signalName.
// `runId` is optional (defaults to the current run); `payload` is forwarded verbatim
// to the workflow's signal handler. Callers should match the payload shape the
// workflow's `setHandler` expects for that signal.
type signalRequest struct {
	RunId   string `json:"runId"`
	Payload any    `json:"payload"`
}

// postWorkflowSignal delivers an in-band signal to a running workflow.
//
// Unlike /cancel (which sends Temporal's CancelWorkflowExecution and hard-stops
// the run), this preserves the workflow's own cancellation semantics — eval-
// worker uses it to drain in-flight cases within DEFAULT_STOP_GRACE_SECONDS
// rather than cancelling activities mid-flight.
//
// Body (optional): { "runId": "...", "payload": <signal-args> }. Returns 200
// with { "status": "signaled" } on success; 404 when the workflow is missing.
func postWorkflowSignal(c *gin.Context, executorService *services.ExecutorService) {
	workflowId := c.Param("workflowId")
	signalName := c.Param("signalName")
	if workflowId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}
	if signalName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "signalName is required"})
		return
	}

	var body signalRequest
	_ = c.ShouldBindJSON(&body) // empty body is valid; defaults to current run, nil payload
	runId := strings.TrimSpace(body.RunId)

	err := executorService.SignalWorkflowByID(c.Request.Context(), workflowId, runId, signalName, body.Payload)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "NotFound") {
			c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowId)})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to signal workflow: %v", err)})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "signaled"})
}

// extractFailureFromHistory fetches the last few events to find a failure reason.
func extractFailureFromHistory(c *gin.Context, tc client.Client, workflowId string) string {
	iter := tc.GetWorkflowHistory(c.Request.Context(), workflowId, "", false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	var lastFailure string
	for iter.HasNext() {
		event, err := iter.Next()
		if err != nil {
			break
		}
		if event.EventType == enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED {
			attrs := event.GetWorkflowExecutionFailedEventAttributes()
			if attrs != nil && attrs.Failure != nil {
				lastFailure = attrs.Failure.Message
			}
		}
		if event.EventType == enumspb.EVENT_TYPE_ACTIVITY_TASK_FAILED {
			attrs := event.GetActivityTaskFailedEventAttributes()
			if attrs != nil && attrs.Failure != nil {
				lastFailure = attrs.Failure.Message
			}
		}
	}
	return lastFailure
}

// getWorkflowLogs returns Temporal history events formatted as log entries.
// Supports query params:
//
//	?search=<string>  - filter entries whose details or eventType contain the string (case-insensitive)
//	?tail=<int>       - return only the last N entries
//	?since=<RFC3339>  - return only entries after this timestamp
func getWorkflowLogs(c *gin.Context, executorService *services.ExecutorService) {
	workflowId := c.Param("workflowId")
	if workflowId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflowId is required"})
		return
	}

	search := strings.ToLower(c.Query("search"))
	tailStr := c.Query("tail")
	sinceStr := c.Query("since")

	var sinceTime *time.Time
	if sinceStr != "" {
		t, err := time.Parse(time.RFC3339, sinceStr)
		if err == nil {
			sinceTime = &t
		}
	}

	tc := executorService.GetTemporalClient()

	iter := tc.GetWorkflowHistory(c.Request.Context(), workflowId, "", false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	var entries []WorkflowLogEntry

	for iter.HasNext() {
		event, err := iter.Next()
		if err != nil {
			errMsg := err.Error()
			if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "NotFound") {
				c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("workflow %s not found", workflowId)})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("failed to get workflow history: %v", err)})
			return
		}

		entry := historyEventToLogEntry(event)

		// Apply since filter
		if sinceTime != nil {
			ts, parseErr := time.Parse(time.RFC3339, entry.Timestamp)
			if parseErr == nil && ts.Before(*sinceTime) {
				continue
			}
		}

		// Apply search filter
		if search != "" {
			if !strings.Contains(strings.ToLower(entry.EventType), search) &&
				!strings.Contains(strings.ToLower(entry.Details), search) {
				continue
			}
		}

		entries = append(entries, entry)
	}

	// Apply tail filter
	if tailStr != "" {
		if tail, err := strconv.Atoi(tailStr); err == nil && tail > 0 && tail < len(entries) {
			entries = entries[len(entries)-tail:]
		}
	}

	total := len(entries)
	if entries == nil {
		entries = []WorkflowLogEntry{}
	}

	c.JSON(http.StatusOK, WorkflowLogsResponse{
		WorkflowId: workflowId,
		Entries:    entries,
		Total:      total,
	})
}

// historyEventToLogEntry converts a Temporal history event to a log entry.
func historyEventToLogEntry(event *historypb.HistoryEvent) WorkflowLogEntry {
	entry := WorkflowLogEntry{
		EventId:   event.EventId,
		EventType: event.EventType.String(),
		Timestamp: event.EventTime.Format(time.RFC3339),
	}

	// Extract meaningful details from common event types
	switch event.EventType {
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED:
		attrs := event.GetWorkflowExecutionStartedEventAttributes()
		if attrs != nil {
			entry.Details = fmt.Sprintf("Workflow started on task queue: %s", attrs.TaskQueue.GetName())
		}
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED:
		entry.Details = "Workflow completed successfully"
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_FAILED:
		attrs := event.GetWorkflowExecutionFailedEventAttributes()
		if attrs != nil && attrs.Failure != nil {
			entry.Details = fmt.Sprintf("Workflow failed: %s", attrs.Failure.Message)
		}
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT:
		entry.Details = "Workflow timed out"
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED:
		entry.Details = "Workflow cancelled"
	case enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED:
		entry.Details = "Workflow terminated"
	case enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED:
		attrs := event.GetActivityTaskScheduledEventAttributes()
		if attrs != nil {
			entry.Details = fmt.Sprintf("Activity scheduled: %s", attrs.ActivityType.GetName())
		}
	case enumspb.EVENT_TYPE_ACTIVITY_TASK_STARTED:
		entry.Details = "Activity started"
	case enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED:
		entry.Details = "Activity completed"
	case enumspb.EVENT_TYPE_ACTIVITY_TASK_FAILED:
		attrs := event.GetActivityTaskFailedEventAttributes()
		if attrs != nil && attrs.Failure != nil {
			entry.Details = fmt.Sprintf("Activity failed: %s", attrs.Failure.Message)
		}
	case enumspb.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT:
		entry.Details = "Activity timed out"
	case enumspb.EVENT_TYPE_TIMER_STARTED:
		attrs := event.GetTimerStartedEventAttributes()
		if attrs != nil {
			entry.Details = fmt.Sprintf("Timer started (duration: %s)", attrs.StartToFireTimeout.String())
		}
	case enumspb.EVENT_TYPE_TIMER_FIRED:
		entry.Details = "Timer fired"
	}

	return entry
}
