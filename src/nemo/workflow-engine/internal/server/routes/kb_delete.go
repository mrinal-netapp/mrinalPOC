package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupKBDeleteRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		kbs := projects.Group("/knowledgebases/:kbId")
		{
			kbs.DELETE("", func(c *gin.Context) {
				deleteKnowledgeBase(c, executorService)
			})
			kbs.POST("/terminate", func(c *gin.Context) {
				terminateKBWorkflows(c, executorService)
			})
		}
	}
}

func terminateKBWorkflows(c *gin.Context, executorService *services.ExecutorService) {
	kbId := c.Param("kbId")
	projectId := c.Param("projectId")
	log.Printf("[KBTerminate] Terminating workflows for KB: %s, project: %s", kbId, projectId)

	cancelled := executorService.TerminateKBWorkflows(c.Request.Context(), kbId)
	log.Printf("[KBTerminate] Cancelled %d workflows for KB %s: %v", len(cancelled), kbId, cancelled)

	c.JSON(http.StatusOK, gin.H{
		"cancelled":       cancelled,
		"knowledgeBaseId": kbId,
		"projectId":       projectId,
	})
}

func deleteKnowledgeBase(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	kbId := c.Param("kbId")
	log.Printf("[KBDeleteRoute] Received request to delete KB: %s, project: %s", kbId, projectId)

	var req struct {
		BucketName string `json:"bucketName,omitempty"`
		PathPrefix string `json:"pathPrefix,omitempty"`
	}

	// Allow empty body - bucket name is optional
	_ = c.ShouldBindJSON(&req)

	// Use projectId as bucket name if not specified
	bucketName := req.BucketName
	if bucketName == "" {
		bucketName = projectId
	}

	workflowInput := types.KnowledgeBaseDeleteWorkflowInput{
		ProjectId:       projectId,
		KnowledgeBaseId: kbId,
		BucketName:      bucketName,
		PathPrefix:      req.PathPrefix,
	}

	workflowID, err := executorService.StartKnowledgeBaseDeletion(projectId, kbId, workflowInput)
	if err != nil {
		log.Printf("[KBDeleteRoute] ERROR: Failed to start KB deletion workflow for KB %s: %v", kbId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start KB deletion workflow",
		})
		return
	}

	log.Printf("[KBDeleteRoute] KB deletion workflow started successfully for KB: %s, workflowID: %s", kbId, workflowID)
	c.JSON(http.StatusAccepted, gin.H{
		"workflowId":      workflowID,
		"status":          "running",
		"knowledgeBaseId": kbId,
		"projectId":       projectId,
	})
}
