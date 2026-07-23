package routes

import (
	"fmt"
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupRoutes(router *gin.RouterGroup, executorService *services.ExecutorService, historyService *services.HistoryService) {
	pipelines := router.Group("/projects/:projectId/pipelines/:pipelineId")
	{
		pipelines.POST("/terminate", func(c *gin.Context) {
			terminatePipelineWorkflows(c, executorService)
		})

		// Pipeline scheduling
		pipelines.POST("/schedule", func(c *gin.Context) {
			createPipelineSchedule(c, executorService)
		})
		pipelines.DELETE("/schedule", func(c *gin.Context) {
			deletePipelineSchedule(c, executorService)
		})
		pipelines.GET("/schedule", func(c *gin.Context) {
			describePipelineSchedule(c, executorService)
		})

		executions := pipelines.Group("/executions")
		{
			executions.POST("", func(c *gin.Context) {
				executePipeline(c, executorService)
			})
			executions.GET("", func(c *gin.Context) {
				listExecutions(c, historyService)
			})
			executions.GET("/:executionId", func(c *gin.Context) {
				getExecution(c, historyService)
			})
			executions.POST("/:executionId/cancel", func(c *gin.Context) {
				cancelExecution(c, executorService)
			})
			executions.POST("/:executionId/resume", func(c *gin.Context) {
				resumeExecution(c, executorService)
			})
		}
	}
}

func executePipeline(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")

	var req struct {
		Parameters map[string]interface{} `json:"parameters,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	executionId, err := executorService.ExecutePipeline(projectId, pipelineId, req.Parameters)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"executionId": executionId,
		"status":      "running",
	})
}

func listExecutions(c *gin.Context, historyService *services.HistoryService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")

	executions, err := historyService.ListExecutions(projectId, pipelineId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, executions)
}

func getExecution(c *gin.Context, historyService *services.HistoryService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")
	executionId := c.Param("executionId")

	execution, err := historyService.GetExecution(projectId, pipelineId, executionId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, execution)
}

func cancelExecution(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")
	executionId := c.Param("executionId")

	err := executorService.CancelExecution(projectId, pipelineId, executionId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "cancelled"})
}

func resumeExecution(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")
	executionId := c.Param("executionId")

	var payload struct {
		ApprovedIds []string `json:"approvedIds"`
		RejectedIds []string `json:"rejectedIds"`
	}

	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	hilPayload := types.HILResumePayload{
		ApprovedIds: payload.ApprovedIds,
		RejectedIds: payload.RejectedIds,
	}

	err := executorService.ResumeExecution(projectId, pipelineId, executionId, hilPayload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "resumed"})
}

func createPipelineSchedule(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")

	var req struct {
		Cron     string `json:"cron" binding:"required"`
		Timezone string `json:"timezone,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	scheduleId, err := executorService.CreatePipelineSchedule(projectId, pipelineId, req.Cron, req.Timezone)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"scheduleId": scheduleId})
}

func deletePipelineSchedule(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")

	err := executorService.DeletePipelineSchedule(projectId, pipelineId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func describePipelineSchedule(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")

	desc, err := executorService.DescribePipelineSchedule(projectId, pipelineId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"scheduleId": fmt.Sprintf("pipeline-%s-%s", projectId, pipelineId),
		"spec":       desc.Schedule.Spec,
		"info":       desc.Info,
	})
}

func terminatePipelineWorkflows(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	pipelineId := c.Param("pipelineId")
	log.Printf("[PipelineTerminate] Terminating workflows for pipeline: %s, project: %s", pipelineId, projectId)

	cancelled := executorService.TerminatePipelineWorkflows(c.Request.Context(), pipelineId)
	log.Printf("[PipelineTerminate] Cancelled %d workflows for pipeline %s: %v", len(cancelled), pipelineId, cancelled)

	c.JSON(http.StatusOK, gin.H{
		"cancelled":  cancelled,
		"pipelineId": pipelineId,
		"projectId":  projectId,
	})
}
