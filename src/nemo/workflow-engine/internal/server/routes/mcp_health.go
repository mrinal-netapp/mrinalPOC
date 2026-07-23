package routes

import (
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
)

func SetupMCPHealthRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	group := router.Group("/mcp-health")
	{
		group.POST("/schedule", func(c *gin.Context) {
			var req struct {
				Cron string `json:"cron"`
			}
			if err := c.ShouldBindJSON(&req); err != nil && err.Error() != "EOF" {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "message": "Invalid request body"})
				return
			}
			scheduleID, err := executorService.CreateMCPHealthSchedule(req.Cron)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to create MCP health schedule"})
				return
			}
			c.JSON(http.StatusCreated, gin.H{"scheduleId": scheduleID, "status": "created"})
		})

		group.DELETE("/schedule", func(c *gin.Context) {
			if err := executorService.DeleteMCPHealthSchedule(); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to delete MCP health schedule"})
				return
			}
			c.JSON(http.StatusOK, gin.H{"deleted": true})
		})

		group.GET("/schedule", func(c *gin.Context) {
			desc, err := executorService.DescribeMCPHealthSchedule()
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error(), "message": "Failed to describe MCP health schedule"})
				return
			}
			c.JSON(http.StatusOK, desc)
		})
	}
}
