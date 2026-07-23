package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupProjectDeleteRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		projects.DELETE("/delete", func(c *gin.Context) {
			startProjectDelete(c, executorService)
		})
	}
}

func startProjectDelete(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	log.Printf("[ProjectDeleteRoute] Received request to delete project: %s", projectId)

	var req struct {
		BucketName string                    `json:"bucketName,omitempty"`
		Gateway    *types.ProjectGatewayMeta `json:"gateway,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		// If no body is provided, use projectId as default bucket name
		log.Printf("[ProjectDeleteRoute] No request body provided, using projectId as bucket name for project: %s", projectId)
		req.BucketName = projectId
	} else {
		if req.BucketName == "" {
			req.BucketName = projectId
		}
		if req.Gateway != nil {
			log.Printf("[ProjectDeleteRoute] Request body: bucketName=%s gateway={teamId=%s vkId=%s}", req.BucketName, req.Gateway.TeamId, req.Gateway.VirtualKeyId)
		} else {
			log.Printf("[ProjectDeleteRoute] Request body: bucketName=%s (no gateway metadata supplied; teardown will fall back to DB read)", req.BucketName)
		}
	}

	workflowInput := types.ProjectDeleteWorkflowInput{
		ProjectId:  projectId,
		BucketName: req.BucketName,
		Gateway:    req.Gateway,
	}

	workflowID, err := executorService.StartProjectDelete(projectId, workflowInput)
	if err != nil {
		log.Printf("[ProjectDeleteRoute] ERROR: Failed to start project delete workflow for project %s: %v", projectId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start project deletion workflow",
		})
		return
	}

	log.Printf("[ProjectDeleteRoute] Project delete workflow started successfully for project: %s, workflowID: %s", projectId, workflowID)
	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"projectId":  projectId,
	})
}
