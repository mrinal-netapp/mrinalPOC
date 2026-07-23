package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupDatasetDeleteRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		datasets := projects.Group("/datasets/:datasetId")
		{
			datasets.DELETE("", func(c *gin.Context) {
				deleteDataset(c, executorService)
			})
			datasets.POST("/terminate", func(c *gin.Context) {
				terminateDatasetWorkflows(c, executorService)
			})
		}
	}
}

func terminateDatasetWorkflows(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")
	log.Printf("[DatasetTerminate] Terminating workflows for dataset: %s, project: %s", datasetId, projectId)

	cancelled := executorService.TerminateDatasetWorkflows(c.Request.Context(), projectId, datasetId)
	log.Printf("[DatasetTerminate] Cancelled %d workflows for dataset %s: %v", len(cancelled), datasetId, cancelled)

	c.JSON(http.StatusOK, gin.H{
		"cancelled": cancelled,
		"datasetId": datasetId,
		"projectId": projectId,
	})
}

func deleteDataset(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")
	log.Printf("[DatasetDeleteRoute] Received request to delete dataset: %s, project: %s", datasetId, projectId)

	var req struct {
		TableName   string `json:"tableName"`
		Namespace   string `json:"namespace"`
		WarehouseId string `json:"warehouseId,omitempty"`
		BucketName  string `json:"bucketName,omitempty"`
		PathPrefix  string `json:"pathPrefix,omitempty"` // S3 path prefix (e.g., projects/<projectId>)
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[DatasetDeleteRoute] ERROR: Failed to bind request body: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   err.Error(),
			"message": "Invalid request body",
		})
		return
	}

	if req.TableName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "tableName is required",
			"message": "Invalid request",
		})
		return
	}

	if req.Namespace == "" {
		req.Namespace = "default"
	}

	// Use projectId as bucket name if not specified
	bucketName := req.BucketName
	if bucketName == "" {
		bucketName = projectId
	}

	// Use projectId as warehouseId if not specified
	warehouseId := req.WarehouseId
	if warehouseId == "" {
		warehouseId = projectId
	}

	workflowInput := types.DatasetDeleteWorkflowInput{
		ProjectId:   projectId,
		DataSetId:   datasetId,
		TableName:   req.TableName,
		Namespace:   req.Namespace,
		WarehouseId: warehouseId,
		BucketName:  bucketName,
		PathPrefix:  req.PathPrefix,
	}

	workflowID, err := executorService.StartDatasetDeletion(projectId, datasetId, workflowInput)
	if err != nil {
		log.Printf("[DatasetDeleteRoute] ERROR: Failed to start dataset deletion workflow for dataset %s: %v", datasetId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start dataset deletion workflow",
		})
		return
	}

	log.Printf("[DatasetDeleteRoute] Dataset deletion workflow started successfully for dataset: %s, workflowID: %s", datasetId, workflowID)
	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"datasetId":  datasetId,
		"projectId":  projectId,
	})
}
