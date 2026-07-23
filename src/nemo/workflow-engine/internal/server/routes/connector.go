package routes

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	"github.com/gin-gonic/gin"
)

// SetupConnectorRoutes registers acquisition, schedule, interactive connector, and explorer endpoints.
func SetupConnectorRoutes(router *gin.RouterGroup, executorService *services.ExecutorService, explorerCache *cache.ExplorerListCache) {
	projects := router.Group("/projects/:projectId")
	{
		datasets := projects.Group("/datasets/:datasetId")
		{
			datasets.POST("/acquire", func(c *gin.Context) {
				acquireDataset(c, executorService)
			})
			datasets.POST("/schedule", func(c *gin.Context) {
				createOrUpdateSchedule(c, executorService)
			})
			datasets.DELETE("/schedule", func(c *gin.Context) {
				deleteSchedule(c, executorService)
			})
			datasets.GET("/schedule", func(c *gin.Context) {
				getSchedule(c, executorService)
			})
		}

		connectors := projects.Group("/connectors/:connectorId")
		{
			connectors.POST("/test", func(c *gin.Context) {
				testConnector(c, executorService)
			})
			connectors.GET("/discover", func(c *gin.Context) {
				discoverConnector(c, executorService)
			})
			connectors.POST("/preview", func(c *gin.Context) {
				previewConnector(c, executorService)
			})
			connectors.POST("/terminate", func(c *gin.Context) {
				terminateConnectorWorkflows(c, executorService)
			})
		}
	}

	// Volume browse route (dispatches ListVolumeDirectory to connector-worker)
	router.POST("/connectors/volume-browse", func(c *gin.Context) {
		volumeBrowse(c, executorService)
	})

	// Volume scan route (async; starts VolumeScanWorkflow and returns workflowId)
	router.POST("/connectors/volume-scan", func(c *gin.Context) {
		volumeScan(c, executorService)
	})

	// Explorer session routes
	explorer := router.Group("/explore")
	{
		explorer.POST("/session", func(c *gin.Context) {
			startExplorerSession(c, executorService)
		})
		explorer.POST("/session/:sessionId/list", func(c *gin.Context) {
			explorerList(c, executorService, explorerCache)
		})
		if explorerCache != nil {
			explorer.POST("/cache/invalidate", func(c *gin.Context) {
				explorerCacheInvalidate(c, explorerCache)
			})
		}
	}
}

func acquireDataset(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")
	log.Printf("[ConnectorRoutes] Acquire request: project=%s, dataset=%s", projectId, datasetId)

	workflowID, err := svc.StartDataAcquisition(projectId, datasetId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "started",
		"datasetId":  datasetId,
	})
}

func createOrUpdateSchedule(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	datasetId := c.Param("datasetId")

	// `enabled` defaults to true when the field is omitted so legacy callers
	// (which always meant "create the schedule") keep working. Sending
	// enabled=false tears any existing schedule down without creating a new one.
	enabled := true
	// cronExpression is required only when creating/enabling a schedule. It is
	// intentionally not `binding:"required"` so callers can pause/disable
	// (enabled=false) without supplying a cron string.
	var req struct {
		CronExpression     string `json:"cronExpression"`
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

	// Validate before mutating any existing schedule: enabling requires a cron
	// expression. Rejecting here (before the create-replace delete below) ensures
	// a malformed enable request can't tear down a caller's active schedule and
	// then 400 — which would silently disable refresh.
	if enabled && req.CronExpression == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cronExpression is required when enabled"})
		return
	}

	// Create-replace semantics: delete any existing schedule before creating a
	// new one. When the caller doesn't supply temporalScheduleId, fall back to
	// the deterministic schedule id so enabling can't collide with an existing
	// schedule (Create would error on a duplicate id) and disabling still tears
	// the existing schedule down. Deletion is best-effort: a missing schedule is
	// not an error here.
	scheduleIdToDelete := req.TemporalScheduleId
	if scheduleIdToDelete == "" {
		scheduleIdToDelete = services.AcquisitionScheduleID(projectId, datasetId)
	}
	_ = svc.DeleteAcquisitionSchedule(scheduleIdToDelete)

	// enabled=false: caller is explicitly pausing; tear down (already done above)
	// and return without creating a new Temporal schedule.
	if !enabled {
		c.JSON(http.StatusOK, gin.H{
			"temporalScheduleId": "",
			"cronExpression":     req.CronExpression,
			"timezone":           req.Timezone,
			"enabled":            false,
		})
		return
	}

	scheduleID, err := svc.CreateAcquisitionSchedule(projectId, datasetId, req.CronExpression, req.Timezone)
	if err != nil {
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

func deleteSchedule(c *gin.Context, svc *services.ExecutorService) {
	var req struct {
		TemporalScheduleId string `json:"temporalScheduleId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := svc.DeleteAcquisitionSchedule(req.TemporalScheduleId); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

func getSchedule(c *gin.Context, svc *services.ExecutorService) {
	scheduleID := c.Query("temporalScheduleId")
	if scheduleID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "temporalScheduleId query parameter required"})
		return
	}

	desc, err := svc.DescribeAcquisitionSchedule(scheduleID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, desc)
}

func testConnector(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	connectorId := c.Param("connectorId")

	var req struct {
		ConnectorConfig  map[string]interface{} `json:"connectorConfig" binding:"required"`
		CredentialID     string                 `json:"credentialId" binding:"required"`
		ConfigServiceURL string                 `json:"configServiceURL,omitempty"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	workflowID, err := svc.StartConnectorTest(projectId, connectorId, req.ConnectorConfig, req.CredentialID, req.ConfigServiceURL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"workflowId": workflowID,
		"status":     "testing",
	})
}

func discoverConnector(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	connectorId := c.Param("connectorId")

	log.Printf("[ConnectorRoutes] Discover request: project=%s, connector=%s", projectId, connectorId)

	// Discover dispatches via a short-lived workflow; for now, return the workflow ID
	c.JSON(http.StatusOK, gin.H{
		"message":     "Discover endpoint registered",
		"connectorId": connectorId,
	})
}

func previewConnector(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	connectorId := c.Param("connectorId")

	log.Printf("[ConnectorRoutes] Preview request: project=%s, connector=%s", projectId, connectorId)

	c.JSON(http.StatusOK, gin.H{
		"message":     "Preview endpoint registered",
		"connectorId": connectorId,
	})
}

func startExplorerSession(c *gin.Context, svc *services.ExecutorService) {
	var req struct {
		ProjectID   string `json:"projectId" binding:"required"`
		ConnectorID string `json:"connectorId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[ExplorerRoutes] Start session: project=%s, connector=%s", req.ProjectID, req.ConnectorID)

	sessionId, err := svc.StartExplorerSession(req.ProjectID, req.ConnectorID)
	if err != nil {
		log.Printf("[ExplorerRoutes] Failed to start session: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"sessionId": sessionId,
	})
}

func explorerList(c *gin.Context, svc *services.ExecutorService, explorerCache *cache.ExplorerListCache) {
	sessionId := c.Param("sessionId")

	var req struct {
		Action      string                 `json:"action" binding:"required"`
		Payload     map[string]interface{} `json:"payload"`
		ProjectID   string                 `json:"projectId"`
		ConnectorID string                 `json:"connectorId"`
		Refresh     bool                   `json:"refresh"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Payload == nil {
		req.Payload = map[string]interface{}{}
	}

	// Use one-shot workflow when projectId and connectorId are provided (works when Update API is disabled)
	if req.ProjectID != "" && req.ConnectorID != "" {
		// Explicit refresh: invalidate cache for this connector so the next list repopulates from source
		if req.Refresh && explorerCache != nil {
			if err := explorerCache.InvalidateByConnector(c.Request.Context(), req.ProjectID, req.ConnectorID); err != nil {
				log.Printf("[ExplorerRoutes] Cache invalidate on refresh failed: %v", err)
			} else {
				log.Printf("[ExplorerRoutes] Cache invalidated for refresh: project=%s, connector=%s", req.ProjectID, req.ConnectorID)
			}
		}
		// Cache-before-workflow: check cache for this level first (skip when refresh was requested); only run workflow on miss (fail-open if cache unavailable)
		if explorerCache != nil && !req.Refresh {
			key := cache.CacheKey(req.ProjectID, req.ConnectorID, req.Action, req.Payload)
			if cached, _ := explorerCache.Get(c.Request.Context(), key); cached != nil {
				log.Printf("[ExplorerRoutes] List (cache hit): project=%s, connector=%s, action=%s", req.ProjectID, req.ConnectorID, req.Action)
				c.JSON(http.StatusOK, cached)
				return
			}
		}
		log.Printf("[ExplorerRoutes] List (direct): project=%s, connector=%s, action=%s", req.ProjectID, req.ConnectorID, req.Action)
		result, err := svc.ExplorerListDirect(req.ProjectID, req.ConnectorID, req.Action, req.Payload)
		if err != nil {
			log.Printf("[ExplorerRoutes] List direct failed: %v", err)
			c.JSON(http.StatusInternalServerError, gin.H{
				"nodes": []interface{}{},
				"error": gin.H{"code": "INTERNAL_ERROR", "message": err.Error()},
			})
			return
		}
		if explorerCache != nil && result != nil {
			key := cache.CacheKey(req.ProjectID, req.ConnectorID, req.Action, req.Payload)
			explorerCache.Set(c.Request.Context(), key, result)
			// Optional prefetch for listPath: fill cache for child folders (one level, up to 10)
			if req.Action == "listPath" && len(result.Nodes) > 0 {
				go prefetchListPathChildren(req.ProjectID, req.ConnectorID, req.Payload, result.Nodes, svc, explorerCache)
			}
		}
		c.JSON(http.StatusOK, result)
		return
	}

	log.Printf("[ExplorerRoutes] List (session): session=%s, action=%s", sessionId, req.Action)

	result, err := svc.ExplorerList(sessionId, req.Action, req.Payload)
	if err != nil {
		log.Printf("[ExplorerRoutes] List failed: session=%s, error=%v", sessionId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"nodes": []interface{}{},
			"error": gin.H{"code": "INTERNAL_ERROR", "message": err.Error()},
		})
		return
	}

	c.JSON(http.StatusOK, result)
}

const prefetchFolderLimit = 3

// prefetchListPathChildren fills the cache for child folder nodes (one level) in the background.
func prefetchListPathChildren(projectId, connectorId string, basePayload map[string]interface{}, nodes []workflows.ExplorerNode, svc *services.ExecutorService, explorerCache *cache.ExplorerListCache) {
	if explorerCache == nil || svc == nil {
		return
	}
	ctx := context.Background()
	count := 0
	for i := range nodes {
		if count >= prefetchFolderLimit {
			break
		}
		node := &nodes[i]
		if node.Type != "folder" || node.Resource == nil {
			continue
		}
		prefixVal, ok := node.Resource["prefix"].(string)
		if !ok || prefixVal == "" {
			continue
		}
		childPayload := make(map[string]interface{})
		for k, v := range basePayload {
			childPayload[k] = v
		}
		childPayload["prefix"] = prefixVal
		result, err := svc.ExplorerListDirect(projectId, connectorId, "listPath", childPayload)
		if err != nil {
			log.Printf("[ExplorerRoutes] Prefetch listPath failed for prefix %q: %v", prefixVal, err)
			continue
		}
		if result != nil {
			key := cache.CacheKey(projectId, connectorId, "listPath", childPayload)
			explorerCache.Set(ctx, key, result)
			count++
		}
	}
	if count > 0 {
		log.Printf("[ExplorerRoutes] Prefetch cached %d listPath children", count)
	}
}

func volumeBrowse(c *gin.Context, svc *services.ExecutorService) {
	var req struct {
		ProjectID string `json:"projectId" binding:"required"`
		VolumeID  string `json:"volumeId" binding:"required"`
		SubPath   string `json:"subPath"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[ConnectorRoutes] Volume browse: project=%s, volume=%s, subPath=%s", req.ProjectID, req.VolumeID, req.SubPath)

	result, err := svc.ListVolumeDirectory(req.ProjectID, req.VolumeID, req.SubPath)
	if err != nil {
		log.Printf("[ConnectorRoutes] Volume browse failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// volumeScan starts an async VolumeScanWorkflow for a volume data source and
// returns the Temporal workflowId. Final scan_result / scan_status is
// delivered back to config-service via PATCH /api/v1/internal/datasources/...
func volumeScan(c *gin.Context, svc *services.ExecutorService) {
	var req struct {
		ProjectID    string                 `json:"projectId" binding:"required"`
		DataSourceID string                 `json:"dataSourceId" binding:"required"`
		ScanConfig   map[string]interface{} `json:"scanConfig" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	log.Printf("[ConnectorRoutes] Volume scan: project=%s, dataSource=%s, scanDepth=%s",
		util.SanitizeLog(req.ProjectID),
		util.SanitizeLog(req.DataSourceID),
		util.SanitizeLog(fmt.Sprintf("%v", req.ScanConfig["scan_depth"])))

	workflowId, err := svc.StartVolumeScan(req.ProjectID, req.DataSourceID, req.ScanConfig)
	if err != nil {
		log.Printf("[ConnectorRoutes] Volume scan failed to start: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"workflowId":   workflowId,
		"status":       "started",
		"dataSourceId": req.DataSourceID,
	})
}

func terminateConnectorWorkflows(c *gin.Context, svc *services.ExecutorService) {
	projectId := c.Param("projectId")
	connectorId := c.Param("connectorId")
	log.Printf("[ConnectorTerminate] Terminating workflows for connector: %s, project: %s", connectorId, projectId)

	cancelled := svc.TerminateConnectorWorkflows(c.Request.Context(), projectId, connectorId)
	log.Printf("[ConnectorTerminate] Cancelled %d workflows for connector %s: %v", len(cancelled), connectorId, cancelled)

	c.JSON(http.StatusOK, gin.H{
		"cancelled":   cancelled,
		"connectorId": connectorId,
		"projectId":   projectId,
	})
}

func explorerCacheInvalidate(c *gin.Context, explorerCache *cache.ExplorerListCache) {
	var req struct {
		ProjectID   string `json:"projectId" binding:"required"`
		ConnectorID string `json:"connectorId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "projectId and connectorId required"})
		return
	}
	if err := explorerCache.InvalidateByConnector(c.Request.Context(), req.ProjectID, req.ConnectorID); err != nil {
		log.Printf("[ExplorerRoutes] Cache invalidate failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	log.Printf("[ExplorerRoutes] Cache invalidated for project=%s connector=%s", req.ProjectID, req.ConnectorID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
