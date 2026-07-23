package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupTableProcessingRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		datasets := projects.Group("/datasets/:datasetId")
		{
			datasets.POST("/process", func(c *gin.Context) {
				startTableProcessing(c, executorService)
			})
		}
	}
}

func startTableProcessing(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")
	log.Printf("[TableProcessingRoute] Received request to process table for dataset: %s, project: %s", datasetId, projectId)

	var req struct {
		TableName   string `json:"tableName"`
		Namespace   string `json:"namespace"`
		WarehouseId string `json:"warehouseId,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[TableProcessingRoute] ERROR: Failed to bind request body: %v", err)
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

	workflowInput := types.TableProcessingWorkflowInput{
		ProjectId:   projectId,
		DataSetId:   datasetId,
		TableName:   req.TableName,
		Namespace:   req.Namespace,
		WarehouseId: req.WarehouseId,
	}

	workflowID, err := executorService.StartTableProcessing(projectId, datasetId, workflowInput)
	if err != nil {
		log.Printf("[TableProcessingRoute] ERROR: Failed to start table processing workflow for dataset %s: %v", datasetId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start table processing workflow",
		})
		return
	}

	log.Printf("[TableProcessingRoute] Table processing workflow started successfully for dataset: %s, workflowID: %s", datasetId, workflowID)
	c.JSON(http.StatusCreated, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"datasetId":  datasetId,
		"projectId":  projectId,
	})
}
