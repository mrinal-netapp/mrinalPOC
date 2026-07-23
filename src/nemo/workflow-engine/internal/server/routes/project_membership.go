package routes

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/gin-gonic/gin"
	"go.temporal.io/api/serviceerror"
)

// SetupProjectMembershipRoutes mounts the *write* membership endpoints. Each
// of these starts a Temporal workflow that transactionally updates Keycloak
// (resource/policy/permission), so they belong here.
//
// The matching *read* endpoints used to live here too. They were moved to
// config-service in PR #31 follow-up — see comment r3321434919 and
// docs/design/keycloak-per-project-authorization.md §6.1/§6.2. They are pure
// Keycloak Authorization Services queries with no Temporal involvement, so
// keeping them here just because the Authz client was already wired in Go was
// the wrong reason. `GET /projects/:projectId/members` is served by
// config-service; the caller's own project list is served by config-service's
// caller-scoped `GET /api/v1/projects` (the former `GET /users/:userId/projects`
// was folded into it and removed).
func SetupProjectMembershipRoutes(router *gin.RouterGroup, executorService *services.ExecutorService) {
	projects := router.Group("/projects/:projectId")
	{
		// Members are identified by email in the request body (no userId in the
		// path/body); workflow-engine resolves email -> Keycloak userId via
		// config-service before starting the Temporal workflow. See
		// docs/design/add-project-members-create-project-approach-a.md (addendum).
		projects.POST("/members", func(c *gin.Context) {
			addProjectMember(c, executorService)
		})
		projects.DELETE("/members", func(c *gin.Context) {
			removeProjectMember(c, executorService)
		})
		projects.PUT("/members/role", func(c *gin.Context) {
			changeProjectMemberRole(c, executorService)
		})
	}
}

// --- config-service resolution (email -> Keycloak userId) ------------------

func newRouteConfigClient() *clients.ConfigClient {
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}
	return clients.NewConfigClient(configServiceURL)
}

// Process-wide ConfigClient, cached so the service-account token cache is
// reused across requests (mirrors getRouteKeycloakClient).
var (
	routeConfigClientMu      sync.Mutex
	routeConfigClient        *clients.ConfigClient
	routeConfigClientFactory = newRouteConfigClient
)

func getRouteConfigClient() *clients.ConfigClient {
	routeConfigClientMu.Lock()
	defer routeConfigClientMu.Unlock()
	if routeConfigClient == nil {
		routeConfigClient = routeConfigClientFactory()
	}
	return routeConfigClient
}

// resolveMemberEmail resolves an invitee email to a Keycloak userId via
// config-service (which holds the Users-API privilege this service lacks).
//   - create=true  → resolve-or-create (add path): always yields a userId.
//   - create=false → resolve-only (change/remove): an empty userId with nil
//     error means no user has that email → caller returns 404.
//
// Overridable in tests so the membership handlers can be exercised without a
// live config-service.
var resolveMemberEmail = func(email string, create bool) (userId string, created bool, err error) {
	cc := getRouteConfigClient()
	if create {
		rs, e := cc.ResolveOrCreateUsers([]string{email})
		if e != nil {
			return "", false, e
		}
		if len(rs) == 0 {
			return "", false, fmt.Errorf("resolve-or-create returned no result for %q", email)
		}
		return rs[0].UserId, rs[0].Created, nil
	}
	rs, e := cc.ResolveUsers([]string{email})
	if e != nil {
		return "", false, e
	}
	if len(rs) == 0 {
		return "", false, nil
	}
	return rs[0].UserId, false, nil
}

func newRouteKeycloakClient() (*clients.KeycloakAuthzClient, error) {
	issuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	clientUUID := os.Getenv("KEYCLOAK_RESOURCE_SERVER_UUID")

	// Prefer dedicated authz credentials (agent-studio-svc-config) which the
	// realm bootstrap grants manage-authorization + uma_protection roles.
	clientID := os.Getenv("KEYCLOAK_AUTHZ_CLIENT_ID")
	clientSecret := os.Getenv("KEYCLOAK_AUTHZ_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		clientID = os.Getenv("KEYCLOAK_CLIENT_ID")
		clientSecret = os.Getenv("KEYCLOAK_CLIENT_SECRET")
	}

	if issuer == "" || clientID == "" || clientSecret == "" || clientUUID == "" {
		return nil, fmt.Errorf("KEYCLOAK_INTERNAL_ISSUER, KEYCLOAK_CLIENT_ID (or KEYCLOAK_AUTHZ_CLIENT_ID), KEYCLOAK_CLIENT_SECRET (or KEYCLOAK_AUTHZ_CLIENT_SECRET), and KEYCLOAK_RESOURCE_SERVER_UUID must be set")
	}
	return clients.NewKeycloakAuthzClient(issuer, clientID, clientSecret, clientUUID)
}

// Process-wide KeycloakAuthzClient. Cached so the underlying service-account
// token cache is reused across requests instead of triggering a fresh token
// fetch on every membership API call. Only cached on success so a transient
// misconfig at startup doesn't poison the cache permanently.
var (
	routeKcClientMu      sync.Mutex
	routeKcClient        *clients.KeycloakAuthzClient
	routeKcClientFactory = newRouteKeycloakClient // overridable in tests
)

func getRouteKeycloakClient() (*clients.KeycloakAuthzClient, error) {
	routeKcClientMu.Lock()
	defer routeKcClientMu.Unlock()
	if routeKcClient != nil {
		return routeKcClient, nil
	}
	c, err := routeKcClientFactory()
	if err != nil {
		return nil, err
	}
	routeKcClient = c
	return c, nil
}

// requireProjectAdmin verifies the caller holds the admin scope on the given project
// by checking Keycloak. Returns true if authorized, false if the response
// has already been written (401/403/500).
//
// Two conditions must both hold: (a) the per-user policy
// `usr-{user}-proj-{project}-admin` exists, and (b) the corresponding
// permission `perm-proj-{project}-admin` exists. The policy alone is not
// sufficient — if the permission is missing or no longer references the
// policy, the admin scope is not actually granted at the Keycloak level.
func requireProjectAdmin(c *gin.Context, projectId string, claims *middleware.UserClaims) bool {
	// Defensive: an authenticated request with an empty sub cannot be an admin
	// of any project. Returning 401 here (rather than building a policy name
	// like `usr--proj-...-admin` and 403-ing) keeps the response semantically
	// correct. Handlers are expected to gate on empty UserID before calling us;
	// this is belt-and-braces.
	if claims == nil || claims.UserID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return false
	}

	kcClient, err := getRouteKeycloakClient()
	if err != nil {
		log.Printf("[requireProjectAdmin] ERROR: Failed to create keycloak client: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal configuration error"})
		return false
	}

	// Exact lookup via GetPolicyByName. ListPolicies uses Keycloak's search=true
	// (substring match) with no ordering guarantee, so a max=1 query can return
	// a non-exact match and 403 a legitimate admin.
	policyName := fmt.Sprintf("usr-%s-proj-%s-admin", claims.UserID, projectId)
	if _, err := kcClient.GetPolicyByName(policyName); err != nil {
		if errors.Is(err, clients.ErrNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "admin scope required on this project"})
			return false
		}
		log.Printf("[requireProjectAdmin] ERROR: Failed to check admin policy: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify authorization"})
		return false
	}

	// The policy exists; verify the matching admin permission also exists so we
	// don't grant admin access on an inconsistent Keycloak state (e.g. policy
	// orphaned after the permission was deleted or rewired).
	permissionName := fmt.Sprintf("perm-proj-%s-admin", projectId)
	if _, err := kcClient.GetPermissionByName(permissionName); err != nil {
		if errors.Is(err, clients.ErrNotFound) {
			c.JSON(http.StatusForbidden, gin.H{"error": "admin scope required on this project"})
			return false
		}
		log.Printf("[requireProjectAdmin] ERROR: Failed to check admin permission: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to verify authorization"})
		return false
	}
	return true
}

// checkExistingRoleConflict queries Keycloak for an existing role policy for
// the (userId, projectId) pair. If the user already holds a different role,
// it writes a 409 response and returns false. Returns true if the caller
// may proceed (either no existing role, or same role = idempotent).
//
// Uses three exact GetPolicyByName lookups (one per role) rather than
// ListPolicies with a substring search. ListPolicies relies on Keycloak's
// `search=true` semantics with no ordering guarantee, so a small `max` can
// silently drop the matching policy and let a conflicting role slip through
// this pre-check.
func checkExistingRoleConflict(c *gin.Context, projectId, userId, requestedRole string) bool {
	kcClient, err := getRouteKeycloakClient()
	if err != nil {
		log.Printf("[checkExistingRoleConflict] ERROR: Failed to create keycloak client: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal configuration error"})
		return false
	}

	for _, role := range []string{"admin", "member", "viewer"} {
		if role == requestedRole {
			continue // same role is idempotent, not a conflict
		}
		policyName := fmt.Sprintf("usr-%s-proj-%s-%s", userId, projectId, role)
		if _, err := kcClient.GetPolicyByName(policyName); err != nil {
			if errors.Is(err, clients.ErrNotFound) {
				continue
			}
			log.Printf("[checkExistingRoleConflict] ERROR: Failed to look up policy: %s", util.SanitizeLog(err.Error()))
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to check existing role"})
			return false
		}
		c.JSON(http.StatusConflict, gin.H{
			"error":   activities.ErrAlreadyAssignedDifferentRole,
			"message": fmt.Sprintf("user already has role '%s' on this project; use the change-role endpoint to switch roles", role),
		})
		return false
	}

	return true
}

// normalizeMemberEmail trims and shape-checks an invitee email (mirrors
// config-service's validation, reusing memberEmailRe from project_init.go in
// this package). On a malformed address it writes a 400 and returns
// ("", false), so a client typo is a 400 here rather than a misleading 502
// from the downstream resolve call (config-service rejects bad emails with a
// 400). 502 is then reserved for genuine upstream/network failures.
func normalizeMemberEmail(c *gin.Context, email string) (string, bool) {
	e := strings.TrimSpace(email)
	if !memberEmailRe.MatchString(e) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid email address"})
		return "", false
	}
	return e, true
}

func addProjectMember(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")

	claims := middleware.GetUserClaims(c)
	if claims == nil || claims.UserID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}

	// Authorize BEFORE resolving the email so a non-admin can't probe which
	// emails map to members via 404-vs-202 timing differences.
	if !requireProjectAdmin(c, projectId, claims) {
		return
	}

	var req struct {
		Email string `json:"email" binding:"required"`
		Role  string `json:"role" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	email, ok := normalizeMemberEmail(c, req.Email)
	if !ok {
		return
	}
	req.Email = email

	if req.Role != "admin" && req.Role != "member" && req.Role != "viewer" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be one of: admin, member, viewer"})
		return
	}

	// Resolve-or-create: unknown invitees are pre-created (consistent with the
	// project-init flow) so the add always targets a stable userId.
	userId, created, err := resolveMemberEmail(req.Email, true)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to resolve member email: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to resolve member"})
		return
	}

	// Pre-check: reject if the user already holds a different role on this project.
	if !checkExistingRoleConflict(c, projectId, userId, req.Role) {
		return
	}

	log.Printf("[ProjectMembershipRoute] Add member: project=%s, user=%s, role=%s, created=%t, callerUserId=%s",
		util.SanitizeLog(projectId), util.SanitizeLog(userId), util.SanitizeLog(req.Role), created, util.SanitizeLog(claims.UserID))

	input := types.ProjectMembershipInput{
		ProjectId: projectId,
		UserId:    userId,
		Role:      req.Role,
	}

	workflowID, err := executorService.StartProjectAddUser(projectId, input)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to start add-user workflow: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"projectId":  projectId,
		"email":      req.Email,
		"role":       req.Role,
		"created":    created,
	})
}

func removeProjectMember(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")

	claims := middleware.GetUserClaims(c)
	if claims == nil || claims.UserID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}

	if !requireProjectAdmin(c, projectId, claims) {
		return
	}

	var req struct {
		Email string `json:"email" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	email, ok := normalizeMemberEmail(c, req.Email)
	if !ok {
		return
	}
	req.Email = email

	// Resolve-only: removing a non-existent member is a 404, not a silent create.
	userId, _, err := resolveMemberEmail(req.Email, false)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to resolve member email: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to resolve member"})
		return
	}
	if userId == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no member with that email"})
		return
	}

	log.Printf("[ProjectMembershipRoute] Remove member: project=%s, user=%s, callerUserId=%s",
		util.SanitizeLog(projectId), util.SanitizeLog(userId), util.SanitizeLog(claims.UserID))

	input := types.ProjectMembershipInput{
		ProjectId: projectId,
		UserId:    userId,
	}

	workflowID, err := executorService.StartProjectRemoveUser(projectId, input)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to start remove-user workflow: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"projectId":  projectId,
		"email":      req.Email,
	})
}

func changeProjectMemberRole(c *gin.Context, executorService *services.ExecutorService) {
	projectId := c.Param("projectId")

	claims := middleware.GetUserClaims(c)
	if claims == nil || claims.UserID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "authentication required"})
		return
	}

	if !requireProjectAdmin(c, projectId, claims) {
		return
	}

	var req struct {
		Email string `json:"email" binding:"required"`
		Role  string `json:"role" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	email, ok := normalizeMemberEmail(c, req.Email)
	if !ok {
		return
	}
	req.Email = email

	if req.Role != "admin" && req.Role != "member" && req.Role != "viewer" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role must be one of: admin, member, viewer"})
		return
	}

	// Resolve-only: changing the role of a non-existent member is a 404.
	userId, _, err := resolveMemberEmail(req.Email, false)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to resolve member email: %s", util.SanitizeLog(err.Error()))
		c.JSON(http.StatusBadGateway, gin.H{"error": "failed to resolve member"})
		return
	}
	if userId == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no member with that email"})
		return
	}

	log.Printf("[ProjectMembershipRoute] Change role: project=%s, user=%s, newRole=%s, callerUserId=%s",
		util.SanitizeLog(projectId), util.SanitizeLog(userId), util.SanitizeLog(req.Role), util.SanitizeLog(claims.UserID))

	input := types.ProjectMembershipInput{
		ProjectId: projectId,
		UserId:    userId,
		Role:      req.Role,
	}

	workflowID, err := executorService.StartProjectChangeRole(projectId, input)
	if err != nil {
		log.Printf("[ProjectMembershipRoute] ERROR: Failed to start change-role workflow: %s", util.SanitizeLog(err.Error()))
		var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
		if errors.As(err, &alreadyStarted) {
			c.JSON(http.StatusConflict, gin.H{"error": "a role change for this user is already in progress; retry shortly"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusAccepted, gin.H{
		"workflowId": workflowID,
		"status":     "running",
		"projectId":  projectId,
		"email":      req.Email,
		"role":       req.Role,
	})
}
