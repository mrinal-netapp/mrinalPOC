package workflows

import (
	"fmt"
	"log"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/util"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ProjectInitWorkflow orchestrates project initialization.
//
// The creator's admin grant (the Keycloak authz block) runs FIRST, before the
// failure-prone infra steps (Bifrost / Lakekeeper / service account). This
// guarantees that a mid-init failure can never leave a project row that its
// creator cannot see or manage: the owner is a project admin as soon as the
// Keycloak resource + admin policy exist, so the project shows up in
// `GET /api/v1/projects` and can be retried or deleted even if later steps
// fail.
//
// The workflow also reports a terminal init status (`ready` / `failed`) back to
// config-service so the outcome is visible on the project row instead of only
// in Temporal history — see ReportProjectInitStatusActivity below.
//
// Ordering:
//  1. Register the project resource in Keycloak.
//  2. Grant the creator the admin scope (owner is now an admin).
//  3. Persist the Keycloak resource id on the project row (best-effort).
//  4. Set up the Bifrost gateway (team + virtual key).
//  5. Look up the shared "nemo" warehouse and store its id in metadata.
//  6. Create the project-scoped namespace.
//  7. Create the project service account.
//  8. Grant any additional requested members.
func ProjectInitWorkflow(ctx workflow.Context, input types.ProjectInitWorkflowInput) (types.ProjectInitWorkflowResult, error) {
	result, err := runProjectInit(ctx, input)

	// Report terminal init status back to config-service (best-effort). This is
	// what makes a failed init visible on the project row instead of only in
	// Temporal history. It runs on BOTH the success and failure paths, after
	// runProjectInit returns, so every early return above is covered.
	// A reporting failure never changes the workflow's own result — the original
	// error is what callers act on.
	status := "ready"
	errMsg := ""
	if err != nil {
		status = "failed"
		errMsg = util.SanitizeLog(result.Error)
		if errMsg == "" {
			errMsg = util.SanitizeLog(err.Error())
		}
	}
	reportCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 1 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    5,
		},
	})
	reportInput := types.ReportProjectInitStatusInput{
		ProjectId: input.ProjectId,
		Status:    status,
		Error:     errMsg,
	}
	if reportErr := workflow.ExecuteActivity(reportCtx, "ReportProjectInitStatusActivity", reportInput).Get(reportCtx, nil); reportErr != nil {
		log.Printf("[ProjectInitWorkflow] WARN: Failed to report init status %q for project %s: %v", status, input.ProjectId, reportErr)
	}

	return result, err
}

// runProjectInit performs the ordered init steps and returns the result. The
// public ProjectInitWorkflow wraps it to report terminal status.
func runProjectInit(ctx workflow.Context, input types.ProjectInitWorkflowInput) (types.ProjectInitWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[ProjectInitWorkflow] Starting workflow for project: %s, workflowID: %s, runID: %s", input.ProjectId, workflowID, runID)

	startTime := time.Now()

	// The default warehouse name is always "nemo" (static, not the bucket name).
	defaultWarehouseName := os.Getenv("DEFAULT_WAREHOUSE_NAME")
	if defaultWarehouseName == "" {
		defaultWarehouseName = "nemo"
	}

	result := types.ProjectInitWorkflowResult{
		ProjectId:           input.ProjectId,
		BucketCreated:       false, // no per-project bucket creation
		BucketName:          "",
		WarehouseRegistered: false, // warehouse already exists; we look it up
		WarehouseName:       defaultWarehouseName,
		NamespaceCreated:    false,
		NamespaceName:       input.ProjectId, // namespace = projectId
		Status:              "running",
	}

	// Activity options
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// ----------------------------------------------------------------
	// Keycloak per-project authorization — runs FIRST.
	//
	// OwnerUserId is required: it becomes the subject of the project's
	// `usr-{ownerSub}-proj-{projectId}-admin` Keycloak policy. The HTTP route
	// validates that this is a real user token (non-empty sub, not a
	// service-account principal); we re-check non-empty here as a workflow
	// invariant since project init has no meaningful "ownerless" mode.
	//
	// Doing this block before the infra steps guarantees the creator can always
	// see/manage/retry the project, even if a later step fails.
	// ----------------------------------------------------------------
	if input.OwnerUserId == "" {
		err := fmt.Errorf("OwnerUserId is required for project init")
		log.Printf("[ProjectInitWorkflow] ERROR: %v", err)
		result.Status = "failed"
		result.Error = err.Error()
		result.Duration = time.Since(startTime)
		return result, err
	}

	// Step 1: Register project resource in Keycloak
	log.Printf("[ProjectInitWorkflow] Step 1: Registering project resource in Keycloak for project: %s", input.ProjectId)
	registerInput := types.RegisterProjectResourceInput{
		ProjectId:   input.ProjectId,
		OwnerUserId: input.OwnerUserId,
	}
	var registerResult types.RegisterProjectResourceResult
	err := workflow.ExecuteActivity(ctx, "RegisterProjectResourceActivity", registerInput).Get(ctx, &registerResult)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 1 failed - RegisterProjectResourceActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to register project resource in Keycloak: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}
	log.Printf("[ProjectInitWorkflow] Step 1 completed: Keycloak resource registered, resourceId=%s", registerResult.ResourceId)

	// Step 2: Grant initial admin to project creator — BEFORE any infra step so
	// the owner is never stranded without access to their own project.
	log.Printf("[ProjectInitWorkflow] Step 2: Granting initial admin to owner %s for project: %s", input.OwnerUserId, input.ProjectId)
	grantInput := types.GrantInitialAdminInput{
		ProjectId:   input.ProjectId,
		OwnerUserId: input.OwnerUserId,
	}
	err = workflow.ExecuteActivity(ctx, "GrantInitialAdminActivity", grantInput).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 2 failed - GrantInitialAdminActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to grant initial admin: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}
	log.Printf("[ProjectInitWorkflow] Step 2 completed: Initial admin granted to owner %s", input.OwnerUserId)

	// Step 3: Persist Keycloak resource ID in config-service (best-effort).
	//
	// Non-fatal: teardown (DeleteProjectResourceActivity) resolves the resource
	// by NAME (`project:{id}`), not by this stored id, so the persisted value is
	// informational. We intentionally do NOT roll back the resource / admin grant
	// on failure here — doing so would strip the owner's admin and leave the
	// creator without access to a partially initialized project. A warn +
	// continue keeps the owner in control; a later reinitialize can re-persist it.
	log.Printf("[ProjectInitWorkflow] Step 3: Persisting Keycloak resource ID for project: %s", input.ProjectId)
	persistInput := types.PersistKeycloakResourceIdInput{
		ProjectId:  input.ProjectId,
		ResourceId: registerResult.ResourceId,
	}
	err = workflow.ExecuteActivity(ctx, "PersistKeycloakResourceIdActivity", persistInput).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] WARN: Step 3 failed - PersistKeycloakResourceIdActivity error: %v (non-critical, continuing)", err)
	} else {
		log.Printf("[ProjectInitWorkflow] Step 3 completed: Keycloak resource ID persisted")
	}

	// ----------------------------------------------------------------
	// Step 4: Set up Bifrost LLM gateway (team + virtual key) for the project
	// ----------------------------------------------------------------
	log.Printf("[ProjectInitWorkflow] Step 4: Setting up Bifrost LLM gateway for project: %s", input.ProjectId)
	err = workflow.ExecuteActivity(ctx, "SetupProjectLLMGatewayActivity", input.ProjectId).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 4 failed - SetupProjectLLMGatewayActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to set up project LLM gateway: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}
	log.Printf("[ProjectInitWorkflow] Step 4 completed: Bifrost LLM gateway ready for project: %s", input.ProjectId)

	// ----------------------------------------------------------------
	// Step 5: Look up the existing default warehouse "nemo" in Lakekeeper
	// ----------------------------------------------------------------
	log.Printf("[ProjectInitWorkflow] Step 5: Looking up default warehouse: %s", defaultWarehouseName)

	lookupReq := types.LookupWarehouseRequest{
		WarehouseName: defaultWarehouseName,
	}
	var lookupResult types.LookupWarehouseResult
	err = workflow.ExecuteActivity(ctx, "LookupWarehouseActivity", lookupReq).Get(ctx, &lookupResult)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 5 failed - LookupWarehouseActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to look up default warehouse '%s': %v", defaultWarehouseName, err)
		result.Duration = time.Since(startTime)
		return result, err
	}

	warehouseId := lookupResult.WarehouseId
	if warehouseId == "" {
		err = fmt.Errorf("default warehouse '%s' not found in Lakekeeper – was default-setup completed?", defaultWarehouseName)
		log.Printf("[ProjectInitWorkflow] ERROR: Step 5 failed - %v", err)
		result.Status = "failed"
		result.Error = err.Error()
		result.Duration = time.Since(startTime)
		return result, err
	}

	result.WarehouseRegistered = true
	result.WarehouseId = warehouseId
	log.Printf("[ProjectInitWorkflow] Step 5 completed: Warehouse '%s' found with ID: %s", defaultWarehouseName, warehouseId)

	// ----------------------------------------------------------------
	// Step 6: Store warehouse ID in project metadata (non-critical)
	// ----------------------------------------------------------------
	log.Printf("[ProjectInitWorkflow] Step 6: Storing warehouse ID in project metadata")
	err = workflow.ExecuteActivity(ctx, "UpdateProjectMetadataActivity", input.ProjectId, warehouseId).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] WARN: Step 6 failed - UpdateProjectMetadataActivity error: %v (non-critical, continuing)", err)
	} else {
		log.Printf("[ProjectInitWorkflow] Step 6 completed: Warehouse ID stored in project metadata")
	}

	// ----------------------------------------------------------------
	// Step 7: Create project namespace [projectId] in warehouse "nemo"
	// ----------------------------------------------------------------
	log.Printf("[ProjectInitWorkflow] Step 7: Creating namespace '%s' in warehouse '%s'", input.ProjectId, defaultWarehouseName)
	namespaceRequest := types.CreateNamespaceRequest{
		WarehouseId: warehouseId,
		Namespace:   []string{input.ProjectId}, // namespace = [projectId]
	}

	err = workflow.ExecuteActivity(ctx, "CreateNamespaceActivity", namespaceRequest).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 7 failed - CreateNamespaceActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create namespace: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}

	result.NamespaceCreated = true
	log.Printf("[ProjectInitWorkflow] Step 7 completed: Namespace '%s' created successfully", input.ProjectId)

	// ----------------------------------------------------------------
	// Step 8: Create project service account
	// ----------------------------------------------------------------
	log.Printf("[ProjectInitWorkflow] Step 8: Creating project service account for project: %s", input.ProjectId)
	err = workflow.ExecuteActivity(ctx, "CreateProjectServiceAccountActivity", input.ProjectId).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectInitWorkflow] ERROR: Step 8 failed - CreateProjectServiceAccountActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to create project service account: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}

	log.Printf("[ProjectInitWorkflow] Step 8 completed: Project service account created successfully for project: %s", input.ProjectId)

	// Step 9: Resolve-or-create the requested invitees and grant their roles.
	// Authz policies are keyed by userId, so each email is first resolved (or
	// created) in config-service, then granted via GrantProjectRoleActivity.
	if len(input.Members) > 0 {
		log.Printf("[ProjectInitWorkflow] Step 9: Granting %d requested member(s) for project: %s", len(input.Members), input.ProjectId)

		// Dedupe invitees by email (first role wins), preserving order so the
		// downstream activity scheduling stays deterministic across replays.
		emailToRole := make(map[string]string)
		emailOrder := make([]string, 0, len(input.Members))
		for _, m := range input.Members {
			if _, seen := emailToRole[m.Email]; !seen {
				emailToRole[m.Email] = m.Role
				emailOrder = append(emailOrder, m.Email)
			}
		}

		var resolved []types.ResolvedMember
		err = workflow.ExecuteActivity(ctx, "ResolveOrCreateMembersActivity", emailOrder).Get(ctx, &resolved)
		if err != nil {
			log.Printf("[ProjectInitWorkflow] ERROR: Step 9 failed - ResolveOrCreateMembersActivity error: %v", err)
			result.Status = "failed"
			result.Error = fmt.Sprintf("failed to resolve project members: %v", err)
			result.Duration = time.Since(startTime)
			return result, err
		}
		emailToUserId := make(map[string]string, len(resolved))
		for _, r := range resolved {
			emailToUserId[r.Email] = r.UserId
		}

		// Group resolved members by role, in deterministic (first-seen) order.
		// Skip the owner (already granted admin in Step 2) and dedupe userIds
		// (one role per user). GrantProjectRoleActivity does a read-modify-write
		// on the shared perm-proj-{projectId}-{role} permission, so grants of the
		// SAME role MUST be serialized; distinct roles touch distinct permissions
		// and are safe to run in parallel.
		roleOrder := make([]string, 0, 3)
		roleToUsers := make(map[string][]string)
		seenUser := make(map[string]bool)
		for _, email := range emailOrder {
			uid, ok := emailToUserId[email]
			if !ok || uid == "" {
				continue
			}
			if uid == input.OwnerUserId || seenUser[uid] {
				continue
			}
			seenUser[uid] = true
			role := emailToRole[email]
			if _, exists := roleToUsers[role]; !exists {
				roleOrder = append(roleOrder, role)
			}
			roleToUsers[role] = append(roleToUsers[role], uid)
		}

		// Fan out one coroutine per role (parallel across roles); within a role
		// grant sequentially to avoid the shared-permission lost-update race.
		type roleGrantResult struct {
			role string
			err  error
		}
		resultCh := workflow.NewChannel(ctx)
		for _, role := range roleOrder {
			role := role
			users := roleToUsers[role]
			workflow.Go(ctx, func(gctx workflow.Context) {
				var gerr error
				for _, uid := range users {
					grant := types.ProjectMembershipInput{
						ProjectId: input.ProjectId,
						UserId:    uid,
						Role:      role,
					}
					if e := workflow.ExecuteActivity(gctx, "GrantProjectRoleActivity", grant).Get(gctx, nil); e != nil {
						gerr = fmt.Errorf("failed to grant role %q to user %q: %w", role, uid, e)
						break
					}
				}
				resultCh.Send(gctx, roleGrantResult{role: role, err: gerr})
			})
		}

		var firstErr error
		for range roleOrder {
			var rr roleGrantResult
			resultCh.Receive(ctx, &rr)
			if rr.err != nil && firstErr == nil {
				firstErr = rr.err
			}
		}
		if firstErr != nil {
			log.Printf("[ProjectInitWorkflow] ERROR: Step 9 failed - member grant error: %v", firstErr)
			result.Status = "failed"
			result.Error = fmt.Sprintf("failed to grant project members: %v", firstErr)
			result.Duration = time.Since(startTime)
			return result, firstErr
		}
		log.Printf("[ProjectInitWorkflow] Step 9 completed: granted %d role group(s) for project: %s", len(roleOrder), input.ProjectId)
	}

	// Workflow completed successfully
	result.Status = "completed"
	result.Duration = time.Since(startTime)
	log.Printf("[ProjectInitWorkflow] Workflow completed successfully for project: %s, duration: %v", input.ProjectId, result.Duration)
	log.Printf("[ProjectInitWorkflow] Summary: warehouseLookup=%v, namespaceCreated=%v", result.WarehouseRegistered, result.NamespaceCreated)

	return result, nil
}
