package routes

import (
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
)

// SetupProgressRoutes registers GET/POST routes for transient workflow progress.
func SetupProgressRoutes(rg *gin.RouterGroup, progressStore services.ProgressStorer) {
	// GET /api/v1/workflows/:workflowId/progress
	rg.GET("/workflows/:workflowId/progress", func(c *gin.Context) {
		workflowID := c.Param("workflowId")
		payload := progressStore.Get(workflowID)
		if payload == nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "no progress found for this workflow"})
			return
		}
		c.JSON(http.StatusOK, payload)
	})

	// POST /api/v1/workflows/:workflowId/progress
	rg.POST("/workflows/:workflowId/progress", func(c *gin.Context) {
		workflowID := c.Param("workflowId")
		var payload services.ProgressPayload
		if err := c.ShouldBindJSON(&payload); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		progressStore.Set(workflowID, payload)
		c.JSON(http.StatusOK, gin.H{"status": "updated"})
	})

	// DELETE /api/v1/workflows/:workflowId/progress (cleanup after workflow completion)
	rg.DELETE("/workflows/:workflowId/progress", func(c *gin.Context) {
		workflowID := c.Param("workflowId")
		progressStore.Delete(workflowID)
		c.JSON(http.StatusOK, gin.H{"status": "deleted"})
	})
}
