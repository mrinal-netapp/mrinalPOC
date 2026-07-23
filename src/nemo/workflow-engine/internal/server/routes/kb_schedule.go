package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/gin-gonic/gin"
)

// SetupKBScheduleRoutes registers Temporal Schedule create/update/delete
// endpoints for knowledge base synchronization. Mirrors the dataset
// /datasets/{datasetId}/schedule endpoints registered in connector.go.
func SetupKBScheduleRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		kbs := projects.Group("/knowledgebases/:kbId")
		{
			kbs.POST("/schedule", func(c *gin.Context) {
				createOrUpdateKBSchedule(c, executorService)
			})
			kbs.DELETE("/schedule", func(c *gin.Context) {
				deleteKBSchedule(c, executorService)
			})
		}
	}
}

func createOrUpdateKBSchedule(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	kbId := c.Param("kbId")

	// `enabled` defaults to true when the field is omitted so legacy callers
	// (which always meant "create the schedule") keep working. Sending
	// enabled=false tears any existing schedule down without creating a new
	// one.
	enabled := true
	var req struct {
		CronExpression     string `json:"cronExpression" binding:"required"`
		Timezone           string `json:"timezone"`
		Enabled            *bool  `json:"enabled,omitempty"`
		TemporalScheduleId string `json:"temporalScheduleId,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Timezone == "" {
		req.Timezone = "UTC"
	}
	if req.Enabled != nil {
		enabled = *req.Enabled
	}

	// Create-replace semantics: delete existing if present, then create fresh.
	if req.TemporalScheduleId != "" {
		_ = svc.DeleteKBSyncSchedule(req.TemporalScheduleId)
	}

	// enabled=false: caller is explicitly pausing; tear down (already done
	// above if a previous schedule id was supplied) and return the resolved
	// cron without creating a new Temporal schedule.
	if !enabled {
		c.JSON(http.StatusOK, gin.H{
			"temporalScheduleId": "",
			"cronExpression":     req.CronExpression,
			"timezone":           req.Timezone,
			"enabled":            false,
		})
		return
	}

	scheduleID, err := svc.CreateKBSyncSchedule(projectId, kbId, req.CronExpression, req.Timezone)
	if err != nil {
		log.Printf("[KBScheduleRoute] Failed to create KB sync schedule for kb=%s: %v", util.SanitizeLog(kbId), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"temporalScheduleId": scheduleID,
		"cronExpression":     req.CronExpression,
		"timezone":           req.Timezone,
		"enabled":            true,
	})
}

func deleteKBSchedule(c *gin.Context, svc *services.ExecutorService) {
	var req struct {
		TemporalScheduleId string `json:"temporalScheduleId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := svc.DeleteKBSyncSchedule(req.TemporalScheduleId); err != nil {
		log.Printf("[KBScheduleRoute] Failed to delete KB sync schedule %s: %v", util.SanitizeLog(req.TemporalScheduleId), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"deleted": true})
}
