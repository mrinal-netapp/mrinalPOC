package activities

import (
	"go.temporal.io/sdk/worker"
)

// RegisterActivities registers all activities with the worker
func RegisterActivities(w worker.Worker) {
	// K8s Resource activities (pod/service management for workspaces)
	w.RegisterActivity(CreatePodActivity)
	w.RegisterActivity(DeletePodActivity)
	w.RegisterActivity(GetPodStatusActivity)
	w.RegisterActivity(CreateServiceActivity)
	w.RegisterActivity(DeleteServiceActivity)
	w.RegisterActivity(UpdateServiceActivity)

	// Scaling activities
	w.RegisterActivity(ScaleDeploymentActivity)
	w.RegisterActivity(ScaleStatefulSetActivity)
	w.RegisterActivity(UpdateReplicasActivity)

	// CRD activities
	w.RegisterActivity(CreateCrdActivity)
	w.RegisterActivity(UpdateCrdActivity)
	w.RegisterActivity(DeleteCrdActivity)
	w.RegisterActivity(GetCrdStatusActivity)

	// Monitoring activities
	w.RegisterActivity(WaitForPodReadyActivity)
	w.RegisterActivity(WaitForServiceReadyActivity)
	w.RegisterActivity(CheckPodStatusActivity)
	w.RegisterActivity(CheckServiceStatusActivity)
	w.RegisterActivity(CollectLogsActivity)
	w.RegisterActivity(CollectMetricsActivity)

	// Step execution activity
	w.RegisterActivity(ExecuteStepActivity)

	// Project initialization activities
	w.RegisterActivity(CreateBucketActivity)
	w.RegisterActivity(WaitForBucketReadyActivity)
	w.RegisterActivity(CreateBucketInS3Activity)
	w.RegisterActivity(CheckBucketStatusActivity)
	w.RegisterActivity(RegisterWarehouseActivity)
	w.RegisterActivity(CreateNamespaceActivity)
	w.RegisterActivity(UpdateProjectMetadataActivity)
	w.RegisterActivity(CreateProjectServiceAccountActivity)
	w.RegisterActivity(SetupProjectLLMGatewayActivity)
	w.RegisterActivity(TeardownProjectLLMGatewayActivity)
	w.RegisterActivity(DeleteBucketActivity)
	w.RegisterActivity(UnregisterWarehouseActivity)
	w.RegisterActivity(DeleteBucketFromConfigActivity)

	// Project deletion activities
	w.RegisterActivity(LookupWarehouseActivity)
	w.RegisterActivity(ListNamespacesActivity)
	w.RegisterActivity(ListTablesInWarehouseActivity)
	w.RegisterActivity(DeleteTableFromCatalogByNameActivity)
	w.RegisterActivity(DeleteNamespaceActivity)
	w.RegisterActivity(DeleteProjectCredentialSecretsActivity)

	// Table processing activities (metadata retrieval)
	w.RegisterActivity(GetTableMetadataActivity)
	w.RegisterActivity(UpdateDatasetStatusActivity)

	// Dataset deletion activities
	w.RegisterActivity(DeleteTableFromCatalogActivity)
	w.RegisterActivity(DeleteDatasetFilesActivity)

	// Dataset import activities (S3 result/progress reads, status updates)
	w.RegisterActivity(ReadProcessingResultActivity)
	w.RegisterActivity(RegisterTableWithCatalogActivity)
	w.RegisterActivity(UpdateDatasetCatalogRefActivity)
	w.RegisterActivity(UpdateDatasetStatsFacetActivity)
	w.RegisterActivity(ReadDatasetProgressActivity)
	w.RegisterActivity(UpdateDatasetProgressActivity)
	w.RegisterActivity(UpdateAcquisitionFacetActivity)

	// Generic workflow progress activity
	w.RegisterActivity(PostWorkflowProgressActivity)

	// Knowledge Base activities (S3 result/progress reads, status updates).
	// ReadKBMetadataActivity is the unified read; it replaces the prior
	// ReadKBProcessingResultActivity (workflow-result file) + ReadMetadataActivity
	// (KB-shape file) pair now that kb-processor writes one file.
	w.RegisterActivity(ReadKBMetadataActivity)
	w.RegisterActivity(ReadKBProgressActivity)
	w.RegisterActivity(UpdateKBProgressActivity)
	w.RegisterActivity(UpdateKBStatusActivity)
	w.RegisterActivity(UpdateKBStatusWithStatsActivity)
	w.RegisterActivity(ClearStaleProgressActivity)

	// Knowledge Base deletion activities
	w.RegisterActivity(DeleteKBFilesActivity)

	// Knowledge Base sync schedule trigger activity
	w.RegisterActivity(TriggerKBSyncActivity)

	// Knowledge Base versioning (list / rollback metadata.json)
	w.RegisterActivity(ListKBVersionsActivity)
	w.RegisterActivity(RollbackKBVersionActivity)

	// ScatterGather config activity (CreateWorkPlanActivity moved to Python workers)
	w.RegisterActivity(GetScatterGatherConfigActivity)

	// Credential fetching activity (replaces ephemeral K8s Secrets)
	w.RegisterActivity(FetchProjectCredentialsActivity)

	// Data acquisition activities
	w.RegisterActivity(FetchDatasetConfigActivity)
	w.RegisterActivity(FetchDataSourceConfigActivity)
	w.RegisterActivity(UpdateDatasetWatermarkActivity)

	// Volume scan callback activity
	w.RegisterActivity(PostScanResultActivity)

	// MCP health check activities
	w.RegisterActivity(RunMCPHealthCheckActivity)

	// Project virtual key rotation
	w.RegisterActivity(ListProjectsForVKRotationActivity)
	w.RegisterActivity(RotateProjectVirtualKeyActivity)
	w.RegisterActivity(DeleteRetiredProjectVirtualKeyActivity)

	// Artifact-store GC (daily session-branch archive + git gc)
	w.RegisterActivity(RunArtifactGCActivity)

	// Reference-edge reconciliation
	w.RegisterActivity(RunReferenceEdgeReconcileActivity)

	// Lineage graph materialization (runs after reconciliation)
	w.RegisterActivity(BuildLineageGraphActivity)

	// Pipeline agent orchestration activities
	w.RegisterActivity(InvokeAgentActivity)
	w.RegisterActivity(SendHILNotification)
	w.RegisterActivity(PersistExecutionStatus)
	w.RegisterActivity(PersistStepResult)

	// Keycloak per-project authorization activities
	w.RegisterActivity(RegisterProjectResourceActivity)
	w.RegisterActivity(PersistKeycloakResourceIdActivity)
	w.RegisterActivity(GrantInitialAdminActivity)
	w.RegisterActivity(DeleteProjectResourceActivity)
	w.RegisterActivity(GrantProjectRoleActivity)
	w.RegisterActivity(RevokeProjectRoleActivity)
	w.RegisterActivity(ResolveOrCreateMembersActivity)
	w.RegisterActivity(ReportProjectInitStatusActivity)
}
