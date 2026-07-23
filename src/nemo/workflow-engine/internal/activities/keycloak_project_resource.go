package activities

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

func newKeycloakAuthzClient() (*clients.KeycloakAuthzClient, error) {
	issuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	clientUUID := os.Getenv("KEYCLOAK_RESOURCE_SERVER_UUID")

	// Prefer dedicated authz credentials (agent-studio-svc-config) which the
	// realm bootstrap grants manage-authorization + uma_protection roles.
	// Fall back to the workflow-engine's own credentials if not configured.
	clientID := os.Getenv("KEYCLOAK_AUTHZ_CLIENT_ID")
	clientSecret := os.Getenv("KEYCLOAK_AUTHZ_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		clientID = os.Getenv("KEYCLOAK_CLIENT_ID")
		clientSecret = os.Getenv("KEYCLOAK_CLIENT_SECRET")
	}

	if issuer == "" || clientID == "" || clientSecret == "" || clientUUID == "" {
		return nil, fmt.Errorf(
			"KEYCLOAK_INTERNAL_ISSUER, KEYCLOAK_CLIENT_ID (or KEYCLOAK_AUTHZ_CLIENT_ID), KEYCLOAK_CLIENT_SECRET (or KEYCLOAK_AUTHZ_CLIENT_SECRET), and KEYCLOAK_RESOURCE_SERVER_UUID must be set")
	}

	return clients.NewKeycloakAuthzClient(issuer, clientID, clientSecret, clientUUID)
}

// RegisterProjectResourceActivity creates a Keycloak resource for the project
// via the Admin Authz API (/admin/realms/.../authz/resource-server/resource).
// Idempotent: 409 is treated as success. Returns the Keycloak resource ID.
func RegisterProjectResourceActivity(ctx context.Context, input types.RegisterProjectResourceInput) (types.RegisterProjectResourceResult, error) {
	info := activity.GetInfo(ctx)
	log.Printf("[RegisterProjectResourceActivity] Starting for project: %q, owner: %q, workflowID: %q",
		input.ProjectId, input.OwnerUserId, info.WorkflowExecution.ID)

	startTime := time.Now()

	kcClient, err := newKeycloakAuthzClient()
	if err != nil {
		return types.RegisterProjectResourceResult{}, fmt.Errorf("failed to create keycloak authz client: %w", err)
	}

	resource := types.KeycloakResource{
		Name: fmt.Sprintf("project:%s", input.ProjectId),
		Type: "urn:agent-studio:resource-types:project",
		URIs: []string{fmt.Sprintf("/projects/%s", input.ProjectId)},
		Scopes: []types.KeycloakScope{
			{Name: "admin"},
			{Name: "member"},
			{Name: "viewer"},
		},
		OwnerManagedAccess: false,
	}

	resourceId, err := kcClient.CreateResource(resource)
	if err != nil {
		log.Printf("[RegisterProjectResourceActivity] ERROR: Failed to create resource for project %q: %v", input.ProjectId, err)
		return types.RegisterProjectResourceResult{}, fmt.Errorf("failed to create project resource: %w", err)
	}

	log.Printf("[RegisterProjectResourceActivity] Resource created for project %q: resourceId=%q, duration=%v",
		input.ProjectId, resourceId, time.Since(startTime))

	return types.RegisterProjectResourceResult{ResourceId: resourceId}, nil
}

// PersistKeycloakResourceIdActivity writes the Keycloak resource ID to the
// config-service projects table. Idempotent: writing the same ID again is a no-op.
func PersistKeycloakResourceIdActivity(ctx context.Context, input types.PersistKeycloakResourceIdInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[PersistKeycloakResourceIdActivity] Starting for project: %q, resourceId: %q, workflowID: %q",
		input.ProjectId, input.ResourceId, info.WorkflowExecution.ID)

	startTime := time.Now()

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	metadata := map[string]interface{}{
		"keycloakResourceId": input.ResourceId,
	}

	err := configClient.UpdateProjectMetadata(input.ProjectId, metadata)
	if err != nil {
		log.Printf("[PersistKeycloakResourceIdActivity] ERROR: Failed to persist resource ID for project %q: %v", input.ProjectId, err)
		return fmt.Errorf("failed to persist keycloak resource ID: %w", err)
	}

	log.Printf("[PersistKeycloakResourceIdActivity] Resource ID persisted for project %q, duration=%v",
		input.ProjectId, time.Since(startTime))
	return nil
}

// GrantInitialAdminActivity creates the user policy and scope permission that
// grants the project creator the admin scope on the project resource.
func GrantInitialAdminActivity(ctx context.Context, input types.GrantInitialAdminInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[GrantInitialAdminActivity] Starting for project: %q, owner: %q, workflowID: %q",
		input.ProjectId, input.OwnerUserId, info.WorkflowExecution.ID)

	startTime := time.Now()

	kcClient, err := newKeycloakAuthzClient()
	if err != nil {
		return fmt.Errorf("failed to create keycloak authz client: %w", err)
	}

	// Step 1: Create user policy
	policyName := fmt.Sprintf("usr-%s-proj-%s-admin", input.OwnerUserId, input.ProjectId)
	policy := types.KeycloakUserPolicy{
		Name:  policyName,
		Users: []string{input.OwnerUserId},
	}

	policyId, err := kcClient.CreateUserPolicy(policy)
	if err != nil {
		log.Printf("[GrantInitialAdminActivity] ERROR: Failed to create policy %q: %v", policyName, err)
		return fmt.Errorf("failed to create admin policy: %w", err)
	}
	log.Printf("[GrantInitialAdminActivity] Policy created: %q (id=%q)", policyName, policyId)

	// Step 2: Create scope permission
	permName := fmt.Sprintf("perm-proj-%s-admin", input.ProjectId)
	perm := types.KeycloakScopePermission{
		Name:      permName,
		Resources: []string{fmt.Sprintf("project:%s", input.ProjectId)},
		Scopes:    []string{"admin"},
		Policies:  []string{policyName},
	}

	permId, err := kcClient.CreateScopePermission(perm)
	if err != nil {
		log.Printf("[GrantInitialAdminActivity] ERROR: Failed to create permission %q: %v", permName, err)
		return fmt.Errorf("failed to create admin scope permission: %w", err)
	}

	log.Printf("[GrantInitialAdminActivity] Permission created: %q (id=%q), duration=%v",
		permName, permId, time.Since(startTime))
	return nil
}

// DeleteProjectResourceActivity removes all Keycloak authorization artifacts
// for a project: scope permissions, user policies, and the resource itself.
// All steps are idempotent (404 = already deleted = pass).
func DeleteProjectResourceActivity(ctx context.Context, input types.DeleteProjectResourceInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[DeleteProjectResourceActivity] Starting for project: %q, workflowID: %q",
		input.ProjectId, info.WorkflowExecution.ID)

	startTime := time.Now()

	kcClient, err := newKeycloakAuthzClient()
	if err != nil {
		return fmt.Errorf("failed to create keycloak authz client: %w", err)
	}

	// Step 1: Find the resource ID by name.
	// Only ErrNotFound is idempotent; transient errors (network/5xx) must
	// propagate so Temporal retries the cleanup.
	resourceName := fmt.Sprintf("project:%s", input.ProjectId)
	resourceId, err := kcClient.GetResourceByName(resourceName)
	resourceNotFound := errors.Is(err, clients.ErrNotFound)
	if err != nil && !resourceNotFound {
		return fmt.Errorf("failed to look up resource %s: %w", resourceName, err)
	}
	if resourceNotFound {
		log.Printf("[DeleteProjectResourceActivity] Resource %q already deleted, cleaning up remaining artifacts", resourceName)
	}

	// Step 2: Delete scope permissions for all roles (attempt even if resource is gone).
	// Same discipline as Step 1 — non-404 lookup/delete errors must propagate so
	// we don't leak per-project permissions on transient Keycloak failures.
	roles := []string{"admin", "member", "viewer"}
	for _, role := range roles {
		permName := fmt.Sprintf("perm-proj-%s-%s", input.ProjectId, role)
		permId, err := kcClient.GetPermissionByName(permName)
		if err != nil {
			if errors.Is(err, clients.ErrNotFound) {
				log.Printf("[DeleteProjectResourceActivity] Permission %q already gone, skipping", permName)
				continue
			}
			return fmt.Errorf("failed to look up permission %s: %w", permName, err)
		}
		if err := kcClient.DeletePermission(permId); err != nil {
			return fmt.Errorf("failed to delete permission %s: %w", permName, err)
		}
		log.Printf("[DeleteProjectResourceActivity] Deleted permission: %q", permName)
	}

	// Step 3: Delete user policies matching pattern usr-*-proj-{projectId}-*.
	// Propagate errors so Temporal retries the cleanup instead of silently
	// leaking auth artifacts. Idempotent: DeletePolicy returns nil on 404,
	// so already-cleaned roles are no-ops on retry.
	for _, role := range roles {
		if err := deletePoliciesForProjectRole(kcClient, input.ProjectId, role); err != nil {
			return fmt.Errorf("failed to clean up policies for project %s role %s: %w", input.ProjectId, role, err)
		}
	}

	// Step 4: Delete the resource (skip if already gone)
	if !resourceNotFound {
		if err := kcClient.DeleteResource(resourceId); err != nil {
			log.Printf("[DeleteProjectResourceActivity] WARN: Failed to delete resource %q: %v", resourceName, err)
			return fmt.Errorf("failed to delete project resource: %w", err)
		}
	}

	log.Printf("[DeleteProjectResourceActivity] Completed cleanup for project %q, duration=%v",
		input.ProjectId, time.Since(startTime))
	return nil
}

// deletePoliciesForProjectRole finds and deletes all user policies for a project/role.
// Policy names follow the pattern: usr-{userId}-proj-{projectId}-{role}.
// Errors propagate so Temporal retries the cleanup.
func deletePoliciesForProjectRole(kcClient *clients.KeycloakAuthzClient, projectId, role string) error {
	searchPattern := fmt.Sprintf("proj-%s-%s", projectId, role)
	policies, err := kcClient.ListPolicies(searchPattern, 500)
	if err != nil {
		return fmt.Errorf("failed to list policies for %s: %w", searchPattern, err)
	}
	// ListPolicies uses Keycloak's search=true (substring match). Filter
	// client-side so we only delete names that actually match the
	// usr-{userId}-proj-{projectId}-{role} shape, regardless of how
	// broadly the server-side search behaves.
	expectedSuffix := fmt.Sprintf("-proj-%s-%s", projectId, role)
	for _, p := range policies {
		if !strings.HasPrefix(p.Name, "usr-") || !strings.HasSuffix(p.Name, expectedSuffix) {
			continue
		}
		if err := kcClient.DeletePolicy(p.ID); err != nil {
			return fmt.Errorf("failed to delete policy %s (%s): %w", p.Name, p.ID, err)
		}
		log.Printf("[DeleteProjectResourceActivity] Deleted policy: %q", p.Name)
	}
	return nil
}
