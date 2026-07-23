package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupDatasetImportRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		datasets := projects.Group("/datasets/:datasetId")
		{
			datasets.POST("/import", func(c *gin.Context) {
				startDatasetImport(c, executorService)
			})
		}
	}
}

func startDatasetImport(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")
	log.Printf("[DatasetImportRoute] Received request to import dataset: %s, project: %s", datasetId, projectId)

	var req struct {
		DatasetName          string `json:"datasetName"`
		DatasetKind          string `json:"datasetKind"`           // "structured" or "unstructured"
		DatasetType          string `json:"datasetType,omitempty"` // "manual" or "acquired"
		BucketName           string `json:"bucketName"`
		Namespace            string `json:"namespace,omitempty"`
		WarehouseId          string `json:"warehouseId,omitempty"`
		PathPrefix           string `json:"pathPrefix,omitempty"`
		EnablePiiAnalysis    bool   `json:"enablePiiAnalysis,omitempty"`
		PiiAnalysisImageOnly bool   `json:"piiAnalysisImageOnly,omitempty"`
		ReprocessPiiOnly     bool   `json:"reprocessPiiOnly,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[DatasetImportRoute] ERROR: Failed to bind request body: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   err.Error(),
			"message": "Invalid request body",
		})
		return
	}

	if req.DatasetName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "datasetName is required",
			"message": "Invalid request",
		})
		return
	}

	if req.BucketName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "bucketName is required",
			"message": "Invalid request",
		})
		return
	}

	// Default values
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	if req.DatasetKind == "" {
		req.DatasetKind = "structured"
	}
	if req.WarehouseId == "" {
		req.WarehouseId = "nemo" // default warehouse NAME (not UUID) — Lakekeeper /config expects the name
	}

	workflowInput := types.DatasetImportWorkflowInput{
		ProjectId:            projectId,
		DataSetId:            datasetId,
		DatasetName:          req.DatasetName,
		DatasetKind:          req.DatasetKind,
		DatasetType:          req.DatasetType,
		BucketName:           req.BucketName,
		Namespace:            req.Namespace,
		WarehouseId:          req.WarehouseId,
		PathPrefix:           req.PathPrefix,
		EnablePiiAnalysis:    req.EnablePiiAnalysis,
		PiiAnalysisImageOnly: req.PiiAnalysisImageOnly,
		ReprocessPiiOnly:     req.ReprocessPiiOnly,
	}

	workflowID, err := executorService.StartDatasetImport(projectId, datasetId, workflowInput)
	if err != nil {
		log.Printf("[DatasetImportRoute] ERROR: Failed to start dataset import workflow for dataset %s: %v", datasetId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start dataset import workflow",
		})
		return
	}

	log.Printf("[DatasetImportRoute] Dataset import workflow started successfully for dataset: %s, workflowID: %s", datasetId, workflowID)
	c.JSON(http.StatusCreated, gin.H{
		"workflowId":  workflowID,
		"status":      "running",
		"datasetId":   datasetId,
		"projectId":   projectId,
		"datasetKind": req.DatasetKind,
	})
}
