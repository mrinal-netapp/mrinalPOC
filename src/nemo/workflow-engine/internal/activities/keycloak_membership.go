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
	"go.temporal.io/sdk/temporal"
)

// ErrAlreadyAssignedDifferentRole is the stable error type string attached to
// the non-retryable ApplicationError returned when a user already holds a
// different role on the project.
const ErrAlreadyAssignedDifferentRole = "AlreadyAssignedDifferentRole"

// ParsePolicyRole extracts the role suffix from a policy name of the form
// usr-{userId}-proj-{projectId}-{role}. Returns "" if the name doesn't match
// the expected prefix.
func ParsePolicyRole(policyName, userId, projectId string) string {
	prefix := fmt.Sprintf("usr-%s-proj-%s-", userId, projectId)
	if !strings.HasPrefix(policyName, prefix) {
		return ""
	}
	return policyName[len(prefix):]
}

// ResolveOrCreateMembersActivity turns invitee emails into stable Keycloak
// user ids by calling config-service's internal resolve-or-create endpoint.
// config-service runs as the master-realm admin (view-users + manage-users);
// this service's scoped authz SA cannot read/create users, which is why the
// resolution is delegated. Returns one ResolvedMember per (deduped) email.
func ResolveOrCreateMembersActivity(ctx context.Context, emails []string) ([]types.ResolvedMember, error) {
	info := activity.GetInfo(ctx)
	log.Printf("[ResolveOrCreateMembersActivity] Resolving %d email(s), workflowID: %q", len(emails), info.WorkflowExecution.ID)

	if len(emails) == 0 {
		return []types.ResolvedMember{}, nil
	}

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}
	configClient := clients.NewConfigClient(configServiceURL)

	resolved, err := configClient.ResolveOrCreateUsers(emails)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve-or-create members: %w", err)
	}
	log.Printf("[ResolveOrCreateMembersActivity] Resolved %d member(s)", len(resolved))
	return resolved, nil
}

// GrantProjectRoleActivity creates a user policy and merges it into the
// corresponding scope permission for a given project and role.
// Implements §6.2: idempotent — calling twice with the same args is a no-op.
//
// Enforces the "one role per (user, project)" invariant: if the user already
// holds a different role on the same project, returns a non-retryable error of
// type AlreadyAssignedDifferentRole. This check runs before CreateUserPolicy
// so no orphaned policies are left in Keycloak on the conflict path.
func GrantProjectRoleActivity(ctx context.Context, input types.ProjectMembershipInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[GrantProjectRoleActivity] Starting for project: %q, user: %q, role: %q, workflowID: %q",
		input.ProjectId, input.UserId, input.Role, info.WorkflowExecution.ID)

	startTime := time.Now()

	kcClient, err := newKeycloakAuthzClient()
	if err != nil {
		return fmt.Errorf("failed to create keycloak authz client: %w", err)
	}

	// Step 0: Enforce one-role-per-(user, project) invariant.
	// Query policies matching usr-{userId}-proj-{projectId}-* and check if any
	// exist for a role other than the requested one. Must happen before
	// CreateUserPolicy to avoid leaving orphaned policies.
	searchPrefix := fmt.Sprintf("usr-%s-proj-%s-", input.UserId, input.ProjectId)
	existingPolicies, err := kcClient.ListPolicies(searchPrefix, 10)
	if err != nil {
		log.Printf("[GrantProjectRoleActivity] ERROR: Failed to list existing policies for prefix %q: %v", searchPrefix, err)
		return fmt.Errorf("failed to check existing role policies: %w", err)
	}

	for _, p := range existingPolicies {
		existingRole := ParsePolicyRole(p.Name, input.UserId, input.ProjectId)
		if existingRole == "" {
			continue
		}
		if existingRole == input.Role {
			continue
		}
		msg := fmt.Sprintf("user already has role %q on this project; use the change-role endpoint to switch roles", existingRole)
		log.Printf("[GrantProjectRoleActivity] Conflict: user %q already has role %q on project %q, requested %q",
			input.UserId, existingRole, input.ProjectId, input.Role)
		return temporal.NewNonRetryableApplicationError(msg, ErrAlreadyAssignedDifferentRole, nil)
	}

	// Step 1: Create user policy (idempotent — 409 means already exists)
	policyName := fmt.Sprintf("usr-%s-proj-%s-%s", input.UserId, input.ProjectId, input.Role)
	policy := types.KeycloakUserPolicy{
		Name:  policyName,
		Users: []string{input.UserId},
	}

	_, err = kcClient.CreateUserPolicy(policy)
	if err != nil {
		log.Printf("[GrantProjectRoleActivity] ERROR: Failed to create policy %q: %v", policyName, err)
		return fmt.Errorf("failed to create user policy: %w", err)
	}
	log.Printf("[GrantProjectRoleActivity] Policy ensured: %q", policyName)

	// Step 2: Ensure scope permission exists with this policy attached
	permName := fmt.Sprintf("perm-proj-%s-%s", input.ProjectId, input.Role)

	permId, err := kcClient.GetPermissionByName(permName)
	if err != nil {
		// Only ErrNotFound means "create it". Other errors (network / Keycloak
		// 5xx / auth) must propagate so Temporal retries — otherwise a transient
		// failure here would silently create a duplicate permission on next
		// attempt and report success.
		if !errors.Is(err, clients.ErrNotFound) {
			log.Printf("[GrantProjectRoleActivity] ERROR: Failed to look up permission %q: %v", permName, err)
			return fmt.Errorf("failed to look up permission %s: %w", permName, err)
		}

		// Permission doesn't exist — create it
		perm := types.KeycloakScopePermission{
			Name:      permName,
			Resources: []string{fmt.Sprintf("project:%s", input.ProjectId)},
			Scopes:    []string{input.Role},
			Policies:  []string{policyName},
		}

		_, err = kcClient.CreateScopePermission(perm)
		if err != nil {
			log.Printf("[GrantProjectRoleActivity] ERROR: Failed to create permission %q: %v", permName, err)
			return fmt.Errorf("failed to create scope permission: %w", err)
		}
		log.Printf("[GrantProjectRoleActivity] Permission created: %q, duration=%v", permName, time.Since(startTime))
		return nil
	}

	// Permission exists — merge new policy into policies array.
	// Keycloak's GET /permission/scope/{id} omits policies; read the live
	// attachment list from /policy/{id}/associatedPolicies before updating.
	existingPerm, err := kcClient.GetScopePermission(permId)
	if err != nil {
		return fmt.Errorf("failed to get permission details: %w", err)
	}
	attachedPolicies, err := kcClient.GetPermissionAssociatedPolicyNames(permId)
	if err != nil {
		return fmt.Errorf("failed to list associated policies for %s: %w", permName, err)
	}

	for _, p := range attachedPolicies {
		if p == policyName {
			log.Printf("[GrantProjectRoleActivity] Policy %q already in permission %q, no-op", policyName, permName)
			return nil
		}
	}

	existingPerm.Policies = append(attachedPolicies, policyName)
	if len(existingPerm.Resources) == 0 {
		existingPerm.Resources = []string{fmt.Sprintf("project:%s", input.ProjectId)}
	}
	if len(existingPerm.Scopes) == 0 {
		existingPerm.Scopes = []string{input.Role}
	}
	if err := kcClient.UpdateScopePermission(permId, *existingPerm); err != nil {
		log.Printf("[GrantProjectRoleActivity] ERROR: Failed to update permission %q: %v", permName, err)
		return fmt.Errorf("failed to update scope permission: %w", err)
	}

	log.Printf("[GrantProjectRoleActivity] Policy %q merged into permission %q, duration=%v",
		policyName, permName, time.Since(startTime))
	return nil
}

// RevokeProjectRoleActivity removes a user from a specific role on a project.
// Implements §6.4 for a single role: detaches the policy from the permission,
// deletes the permission if its policies list becomes empty, then deletes the policy.
func RevokeProjectRoleActivity(ctx context.Context, input types.ProjectMembershipInput) error {
	info := activity.GetInfo(ctx)
	log.Printf("[RevokeProjectRoleActivity] Starting for project: %q, user: %q, role: %q, workflowID: %q",
		input.ProjectId, input.UserId, input.Role, info.WorkflowExecution.ID)

	startTime := time.Now()

	kcClient, err := newKeycloakAuthzClient()
	if err != nil {
		return fmt.Errorf("failed to create keycloak authz client: %w", err)
	}

	policyName := fmt.Sprintf("usr-%s-proj-%s-%s", input.UserId, input.ProjectId, input.Role)
	permName := fmt.Sprintf("perm-proj-%s-%s", input.ProjectId, input.Role)

	// Step 1: Look up the policy — if absent, nothing to revoke.
	// Only treat ErrNotFound as idempotent success; any other error (transient
	// network / Keycloak 5xx / auth) must propagate so Temporal retries the
	// activity instead of silently leaving the user with access.
	policyId, err := kcClient.GetPolicyByName(policyName)
	if err != nil {
		if errors.Is(err, clients.ErrNotFound) {
			log.Printf("[RevokeProjectRoleActivity] Policy %q not found, nothing to revoke", policyName)
			return nil
		}
		log.Printf("[RevokeProjectRoleActivity] ERROR: Failed to look up policy %q: %v", policyName, err)
		return fmt.Errorf("failed to get policy %s: %w", policyName, err)
	}

	// Step 2: Look up the scope permission.
	// Not-found is treated as an orphan policy (clean it up); other errors must
	// propagate so we don't leave the policy attached to a still-existing permission.
	permId, err := kcClient.GetPermissionByName(permName)
	if err != nil {
		if !errors.Is(err, clients.ErrNotFound) {
			log.Printf("[RevokeProjectRoleActivity] ERROR: Failed to look up permission %q: %v", permName, err)
			return fmt.Errorf("failed to get permission %s: %w", permName, err)
		}
		log.Printf("[RevokeProjectRoleActivity] Permission %q not found, cleaning up orphan policy", permName)
		if delErr := kcClient.DeletePolicy(policyId); delErr != nil {
			return fmt.Errorf("failed to delete orphan policy %s: %w", policyName, delErr)
		}
		return nil
	}

	// Step 3: Detach policy from permission.
	// Same discipline: only ErrNotFound (permission disappeared between lookup
	// and fetch) is treated as the orphan-policy case.
	existingPerm, err := kcClient.GetScopePermission(permId)
	if err != nil {
		if !errors.Is(err, clients.ErrNotFound) {
			log.Printf("[RevokeProjectRoleActivity] ERROR: Failed to get permission %q details: %v", permName, err)
			return fmt.Errorf("failed to get permission %s details: %w", permName, err)
		}
		log.Printf("[RevokeProjectRoleActivity] Permission %q vanished, cleaning up orphan policy", permName)
		if delErr := kcClient.DeletePolicy(policyId); delErr != nil {
			return fmt.Errorf("failed to delete orphan policy %s: %w", policyName, delErr)
		}
		return nil
	}

	attachedPolicies, err := kcClient.GetPermissionAssociatedPolicyNames(permId)
	if err != nil {
		return fmt.Errorf("failed to list associated policies for %s: %w", permName, err)
	}

	// Remove the policy from the list
	newPolicies := make([]string, 0, len(attachedPolicies))
	for _, p := range attachedPolicies {
		if p != policyName {
			newPolicies = append(newPolicies, p)
		}
	}

	if len(newPolicies) == 0 {
		// No policies left — delete the permission entirely
		if err := kcClient.DeletePermission(permId); err != nil {
			return fmt.Errorf("failed to delete empty permission %s: %w", permName, err)
		}
		log.Printf("[RevokeProjectRoleActivity] Deleted empty permission: %q", permName)
	} else {
		// Update permission with reduced policies list
		existingPerm.Policies = newPolicies
		if len(existingPerm.Resources) == 0 {
			existingPerm.Resources = []string{fmt.Sprintf("project:%s", input.ProjectId)}
		}
		if len(existingPerm.Scopes) == 0 {
			existingPerm.Scopes = []string{input.Role}
		}
		if err := kcClient.UpdateScopePermission(permId, *existingPerm); err != nil {
			return fmt.Errorf("failed to update permission %s: %w", permName, err)
		}
	}

	// Step 4: Delete the policy
	if err := kcClient.DeletePolicy(policyId); err != nil {
		return fmt.Errorf("failed to delete policy %s: %w", policyName, err)
	}
	log.Printf("[RevokeProjectRoleActivity] Deleted policy: %q", policyName)

	log.Printf("[RevokeProjectRoleActivity] Completed revoke for user %q on project %q role %q, duration=%v",
		input.UserId, input.ProjectId, input.Role, time.Since(startTime))
	return nil
}
