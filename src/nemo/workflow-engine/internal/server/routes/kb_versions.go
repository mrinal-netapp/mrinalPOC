package routes

import (
	"log"
	"net/http"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/gin-gonic/gin"
)

// SetupKBVersionsRoutes registers list / rollback endpoints for the
// blue-green LanceDB sync versions persisted under
// `{pathPrefix}/knowledgebases/{kbId}/`. Each successful KB sync writes a new
// `lancedb-run-{runId}/` (or legacy `lancedb-{ts}/`) prefix and updates
// `metadata.json#lanceTablePath`. These endpoints expose those prefixes and
// flip the active pointer atomically.
func SetupKBVersionsRoutes(router *gin.RouterGroup, configClient *clients.ConfigClient) {
	projects := router.Group("/projects/:projectId")
	{
		kbs := projects.Group("/knowledgebases/:kbId")
		{
			kbs.GET("/versions", func(c *gin.Context) {
				listKBVersions(c, configClient)
			})
			kbs.POST("/versions/:versionId/rollback", func(c *gin.Context) {
				rollbackKBVersion(c, configClient)
			})
		}
	}
}

func listKBVersions(c *gin.Context, configClient *clients.ConfigClient) {
	projectId := c.Param("projectId")
	kbId := c.Param("kbId")

	bucketName, pathPrefix, err := resolveKBStorage(c, configClient, projectId, kbId)
	if err != nil {
		return
	}

	result, err := activities.ListKBVersionsActivity(c.Request.Context(), activities.KBVersionsListInput{
		ProjectId:       projectId,
		KnowledgeBaseId: kbId,
		BucketName:      bucketName,
		PathPrefix:      pathPrefix,
	})
	if err != nil {
		log.Printf("[KBVersionsRoute] List failed for kb=%s: %v", util.SanitizeLog(kbId), err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

func rollbackKBVersion(c *gin.Context, configClient *clients.ConfigClient) {
	projectId := c.Param("projectId")
	kbId := c.Param("kbId")
	versionId := c.Param("versionId")

	if versionId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "versionId path param required"})
		return
	}

	bucketName, pathPrefix, err := resolveKBStorage(c, configClient, projectId, kbId)
	if err != nil {
		return
	}

	result, err := activities.RollbackKBVersionActivity(c.Request.Context(), activities.KBVersionRollbackInput{
		ProjectId:       projectId,
		KnowledgeBaseId: kbId,
		BucketName:      bucketName,
		PathPrefix:      pathPrefix,
		TargetVersionId: versionId,
	})
	if err != nil {
		log.Printf("[KBVersionsRoute] Rollback failed for kb=%s version=%s: %v", util.SanitizeLog(kbId), util.SanitizeLog(versionId), err)
		// 404 when the target version doesn't exist; otherwise 500.
		status := http.StatusInternalServerError
		if isNotFoundError(err) {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// resolveKBStorage looks up the KB's bucketName + pathPrefix from the
// config-service so the storage helpers can read/write metadata.json without
// the caller needing to send those fields.
func resolveKBStorage(c *gin.Context, configClient *clients.ConfigClient, projectId, kbId string) (string, string, error) {
	bucketName, pathPrefix, err := configClient.GetKBStorageRoot(projectId, kbId)
	if err != nil {
		log.Printf("[KBVersionsRoute] Failed to resolve KB storage for kb=%s: %v", util.SanitizeLog(kbId), err)
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to resolve KB storage from config-service: " + err.Error()})
		return "", "", err
	}
	return bucketName, pathPrefix, nil
}

func isNotFoundError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return containsCaseInsensitive(msg, "not found")
}

func containsCaseInsensitive(s, substr string) bool {
	if len(substr) == 0 {
		return true
	}
	if len(s) < len(substr) {
		return false
	}
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			a := s[i+j]
			b := substr[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
