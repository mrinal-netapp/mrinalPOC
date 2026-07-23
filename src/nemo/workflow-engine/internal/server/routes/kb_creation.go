package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

func SetupKBCreationRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		kbs := projects.Group("/knowledgebases/:kbId")
		{
			kbs.POST("/create", func(c *gin.Context) {
				startKBCreation(c, executorService)
			})
		}
	}
}

func startKBCreation(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	kbId := c.Param("kbId")
	log.Printf("[KBCreationRoute] Received request to create KB: %s, project: %s", kbId, projectId)

	var req types.KnowledgeBaseCreationWorkflowInput

	if err := c.ShouldBindJSON(&req); err != nil {
		log.Printf("[KBCreationRoute] ERROR: Failed to bind request body: %v", err)
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   err.Error(),
			"message": "Invalid request body",
		})
		return
	}

	// Validate required fields
	if req.KBName == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "kbName is required",
			"message": "Invalid request",
		})
		return
	}

	if req.SourceDatasetId == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "sourceDatasetId is required",
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

	// Set project and KB IDs from URL params
	req.ProjectId = projectId
	req.KnowledgeBaseId = kbId

	// Default values
	if req.Namespace == "" {
		req.Namespace = projectId // Use projectId for namespace isolation
	}
	if req.EmbeddingModel == "" {
		req.EmbeddingModel = "sentence-transformers/all-MiniLM-L6-v2"
	}
	if req.ChunkSize == 0 {
		req.ChunkSize = 512
	}
	if req.VectorSize == 0 {
		req.VectorSize = 384
	}
	if req.DataType == "" {
		req.DataType = "float32"
	}
	if req.ProcessingMode == "" {
		req.ProcessingMode = "full" // Default to full processing mode
	}
	// Chunking strategy defaults
	if req.ChunkStrategy == "" {
		req.ChunkStrategy = "fixed" // Default to fixed-size chunking
	}
	if req.ChunkOverlap == 0 && req.ChunkStrategy == "fixed" {
		req.ChunkOverlap = 50 // Default overlap for fixed strategy
	}
	// Indexing mode default
	if req.IndexingMode == "" {
		req.IndexingMode = "hybrid" // Default to hybrid search (vector + FTS)
	}
	// Quantization default (valid values: "auto", "none", "ivf_pq", "scalar", "ivf_rq")
	if req.QuantizationType == "" {
		req.QuantizationType = "auto" // Default to auto (system picks best index for data size)
	}

	workflowID, err := executorService.StartKnowledgeBaseCreation(projectId, kbId, req)
	if err != nil {
		log.Printf("[KBCreationRoute] ERROR: Failed to start KB creation workflow for KB %s: %v", kbId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start KB creation workflow",
		})
		return
	}

	log.Printf("[KBCreationRoute] KB creation workflow started successfully for KB: %s, workflowID: %s", kbId, workflowID)
	c.JSON(http.StatusAccepted, gin.H{
		"workflowId":      workflowID,
		"status":          "running",
		"knowledgeBaseId": kbId,
		"projectId":       projectId,
	})
}
