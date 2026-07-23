package routes

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"

	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
)

// memberEmailRe is a pragmatic email shape check (mirrors config-service's
// validation in userResolutionRoutes.ts). Invitee emails are validated here so
// a malformed address is rejected at request time with a 400, instead of
// passing the handler and failing the whole init workflow when config-service
// rejects the batch. Not a full RFC 5322 validator. The dot-separated,
// dot-free domain labels keep it linear-time (Go's RE2 is non-backtracking
// regardless, but this stays identical to the config-service pattern).
var memberEmailRe = regexp.MustCompile(`^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$`)

func SetupProjectInitRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		projects.POST("/init", func(c *gin.Context) {
			startProjectInit(c, executorService)
		})
	}
}

func startProjectInit(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")
	log.Printf("[ProjectInitRoute] Received request to initialize project: %q", projectId)

	var req struct {
		Region            string `json:"region,omitempty"`
		StorageClass      string `json:"storageClass,omitempty"`
		StorageSize       string `json:"storageSize,omitempty"`
		S3GatewayEndpoint string `json:"s3GatewayEndpoint,omitempty"`
		Members           []struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		} `json:"members,omitempty"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		// Only treat an empty body as the "use env defaults" case. Any other
		// bind error (malformed JSON, wrong types like {"region": 123}) is a
		// client bug — surface it as 400 instead of silently falling back to
		// defaults, which would hide the misuse and produce surprising state.
		if !errors.Is(err, io.EOF) {
			log.Printf("[ProjectInitRoute] ERROR: invalid request body for project %q: %v", projectId, err)
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "invalid request body",
				"message": err.Error(),
			})
			return
		}
		log.Printf("[ProjectInitRoute] No request body provided, using environment defaults for project: %q", projectId)
		req.Region = os.Getenv("REGION")
		if req.Region == "" {
			req.Region = "us-east-1"
		}
		req.StorageClass = os.Getenv("DEFAULT_STORAGE_CLASS")
		if req.StorageClass == "" {
			req.StorageClass = "standard"
		}
		req.StorageSize = os.Getenv("DEFAULT_STORAGE_SIZE")
		if req.StorageSize == "" {
			req.StorageSize = "10Gi"
		}
		req.S3GatewayEndpoint = os.Getenv("S3GATEWAY_ENDPOINT")
		if req.S3GatewayEndpoint == "" {
			// Connect directly to s3gateway to avoid auth middleware issues
			// Lakekeeper will use AWS signature v4 auth with the provided credentials
			req.S3GatewayEndpoint = "http://s3gateway:7070"
		}
	} else {
		log.Printf("[ProjectInitRoute] Request body: region=%q, storageClass=%q, storageSize=%q, s3GatewayEndpoint=%q",
			req.Region, req.StorageClass, req.StorageSize, req.S3GatewayEndpoint)
	}

	// Extract ownerUserId from the validated JWT. We require a user token here:
	// the project owner is recorded as a Keycloak user-policy bound to this
	// `sub`, so a service-account caller would silently make the SA the
	// project admin. Reject both missing tokens and service-account tokens.
	claims := middleware.GetUserClaims(c)
	if claims == nil || claims.UserID == "" {
		log.Printf("[ProjectInitRoute] ERROR: Missing user claims for project %q init", projectId)
		c.JSON(http.StatusUnauthorized, gin.H{
			"error":   "Unauthorized",
			"message": "project init requires an authenticated user token",
		})
		return
	}
	if strings.HasPrefix(claims.Username, "service-account-") {
		log.Printf("[ProjectInitRoute] ERROR: Service-account caller %q attempted project init for %q",
			claims.Username, projectId)
		c.JSON(http.StatusForbidden, gin.H{
			"error":   "Forbidden",
			"message": "project init must be invoked with a user token, not a service-account token",
		})
		return
	}
	ownerUserId := claims.UserID

	// Validate requested members (email + role). Roles must be admin|member|
	// viewer; emails must be non-empty. The owner is granted admin separately
	// (Step 7); any member entry that resolves to the owner is deduped in the
	// workflow so we never double-grant or downgrade the creator.
	validRoles := map[string]bool{"admin": true, "member": true, "viewer": true}
	members := make([]types.ProjectMemberInvite, 0, len(req.Members))
	for _, m := range req.Members {
		email := strings.TrimSpace(m.Email)
		role := strings.TrimSpace(m.Role)
		if email == "" {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "invalid member",
				"message": "member email is required",
			})
			return
		}
		if !memberEmailRe.MatchString(email) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "invalid member",
				"message": fmt.Sprintf("member email %q is not a valid email address", email),
			})
			return
		}
		if !validRoles[role] {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":   "invalid member",
				"message": fmt.Sprintf("member %q has invalid role %q (must be admin|member|viewer)", email, role),
			})
			return
		}
		members = append(members, types.ProjectMemberInvite{Email: email, Role: role})
	}

	workflowInput := types.ProjectInitWorkflowInput{
		ProjectId:         projectId,
		Region:            req.Region,
		StorageClass:      req.StorageClass,
		StorageSize:       req.StorageSize,
		S3GatewayEndpoint: req.S3GatewayEndpoint,
		OwnerUserId:       ownerUserId,
		Members:           members,
	}

	workflowID, err := executorService.StartProjectInit(projectId, workflowInput)
	if err != nil {
		log.Printf("[ProjectInitRoute] ERROR: Failed to start project init workflow for project %q: %v", projectId, err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   err.Error(),
			"message": "Failed to start project initialization workflow",
		})
		return
	}

	log.Printf("[ProjectInitRoute] Project init workflow started successfully for project: %q, workflowID: %q", projectId, workflowID)
	c.JSON(http.StatusCreated, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"projectId":  projectId,
	})
}
