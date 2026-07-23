package routes

import (
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
)

// SetupReferenceEdgeRoutes mounts ops endpoints for managing the
// `dependency-lineage-sync` Temporal schedule that discovers cross-entity
// dependencies and maintains usage/lineage information.
func SetupReferenceEdgeRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	group := router.Group("/reference-edges")
	{
		group.POST("/schedule", func(c *gin.Context) {
			var req struct {
				Cron string `json:"cron"`
			}
			if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "message": "Invalid request body"})
				return
			}
			scheduleID, err := executorService.CreateReferenceEdgeReconcileSchedule(req.Cron)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to create dependency-lineage-sync schedule"})
				return
			}
			c.JSON(http.StatusCreated, gin.H{"scheduleId": scheduleID, "status": "created"})
		})

		group.DELETE("/schedule", func(c *gin.Context) {
			if err := executorService.DeleteReferenceEdgeReconcileSchedule(); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to delete dependency-lineage-sync schedule"})
				return
			}
			c.JSON(http.StatusOK, gin.H{"deleted": true})
		})

		group.GET("/schedule", func(c *gin.Context) {
			desc, err := executorService.DescribeReferenceEdgeReconcileSchedule()
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to describe dependency-lineage-sync schedule"})
				return
			}
			c.JSON(http.StatusOK, desc)
		})
	}
}
