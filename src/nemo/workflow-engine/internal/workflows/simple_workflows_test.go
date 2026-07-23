package workflows

import (
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

// Several stub activity signatures cover the different argument shapes the
// workflows use (single arg, two args, etc.). Tests override behaviour via
// env.OnActivity(...) which wins over the registered fallback.

func stubActivity1(arg interface{}) (interface{}, error) {
	return nil, errors.New("stub not overridden")
}

func stubActivity2(a, b interface{}) (interface{}, error) {
	return nil, errors.New("stub not overridden")
}

func stubActivity3(a, b, c interface{}) (interface{}, error) {
	return nil, errors.New("stub not overridden")
}

func stubActivity4(a, b, c, d interface{}) (interface{}, error) {
	return nil, errors.New("stub not overridden")
}

func stubActivity5(a, b, c, d, e interface{}) (interface{}, error) {
	return nil, errors.New("stub not overridden")
}

// registerStubs registers single-arg stubActivity1 by default. Use
// registerStubsArgs(env, n, name) when an activity takes more positional args.
func registerStubs(env *testsuite.TestWorkflowEnvironment, names ...string) {
	for _, n := range names {
		env.RegisterActivityWithOptions(stubActivity1, activity.RegisterOptions{Name: n})
	}
}

func registerStubsArgs(env *testsuite.TestWorkflowEnvironment, argCount int, names ...string) {
	var fn interface{}
	switch argCount {
	case 1:
		fn = stubActivity1
	case 2:
		fn = stubActivity2
	case 3:
		fn = stubActivity3
	case 4:
		fn = stubActivity4
	case 5:
		fn = stubActivity5
	default:
		fn = stubActivity1
	}
	for _, n := range names {
		env.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: n})
	}
}

// --- ArtifactGCWorkflow -----------------------------------------------------

func TestArtifactGCWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunArtifactGCActivity")

	want := types.ArtifactGCResult{ReposScanned: 3, BranchesArchived: 1}
	env.OnActivity("RunArtifactGCActivity", mock.Anything, mock.Anything).Return(want, nil)

	env.ExecuteWorkflow(ArtifactGCWorkflow, types.ArtifactGCInput{MaxAgeHours: 720})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.ArtifactGCResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, want, got)
}

func TestArtifactGCWorkflow_Error(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunArtifactGCActivity")
	env.OnActivity("RunArtifactGCActivity", mock.Anything, mock.Anything).
		Return(types.ArtifactGCResult{}, errors.New("nfs down"))

	env.ExecuteWorkflow(ArtifactGCWorkflow, types.ArtifactGCInput{})

	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

// --- MCPHealthCheckWorkflow ------------------------------------------------

func TestMCPHealthCheckWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunMCPHealthCheckActivity")
	want := types.MCPHealthCheckResult{Checked: 5, Healthy: 4, Unhealthy: 1}
	env.OnActivity("RunMCPHealthCheckActivity", mock.Anything, mock.Anything).Return(want, nil)

	env.ExecuteWorkflow(MCPHealthCheckWorkflow, types.MCPHealthCheckInput{ConfigServiceURL: "http://x"})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.MCPHealthCheckResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, want, got)
}

func TestMCPHealthCheckWorkflow_Error(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunMCPHealthCheckActivity")
	env.OnActivity("RunMCPHealthCheckActivity", mock.Anything, mock.Anything).
		Return(types.MCPHealthCheckResult{}, errors.New("boom"))

	env.ExecuteWorkflow(MCPHealthCheckWorkflow, types.MCPHealthCheckInput{})
	require.Error(t, env.GetWorkflowError())
}

// --- KnowledgeBaseDeleteWorkflow -------------------------------------------

func TestKBDeleteWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteKBFilesActivity")

	env.OnActivity("DeleteKBFilesActivity", mock.Anything, mock.Anything).Return(
		types.DeleteKBFilesResult{Success: true, FilesDeleted: 7}, nil,
	)
	env.ExecuteWorkflow(KnowledgeBaseDeleteWorkflow, types.KnowledgeBaseDeleteWorkflowInput{
		ProjectId: "p", KnowledgeBaseId: "kb", BucketName: "b",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.KnowledgeBaseDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.True(t, got.S3FilesDeleted)
	assert.Equal(t, 7, got.FilesDeleted)
}

func TestKBDeleteWorkflow_DeleteFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteKBFilesActivity")
	env.OnActivity("DeleteKBFilesActivity", mock.Anything, mock.Anything).
		Return(types.DeleteKBFilesResult{}, errors.New("s3 down"))

	env.ExecuteWorkflow(KnowledgeBaseDeleteWorkflow, types.KnowledgeBaseDeleteWorkflowInput{
		ProjectId: "p", KnowledgeBaseId: "kb",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestKBDeleteWorkflow_NotSuccess(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteKBFilesActivity")
	env.OnActivity("DeleteKBFilesActivity", mock.Anything, mock.Anything).
		Return(types.DeleteKBFilesResult{Success: false}, nil)

	env.ExecuteWorkflow(KnowledgeBaseDeleteWorkflow, types.KnowledgeBaseDeleteWorkflowInput{ProjectId: "p", KnowledgeBaseId: "kb"})
	require.Error(t, env.GetWorkflowError())
}

// --- ProjectVirtualKeyRotationWorkflow -------------------------------------

func TestProjectVirtualKeyRotationWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RotateProjectVirtualKeyActivity", "DeleteRetiredProjectVirtualKeyActivity")

	env.OnActivity("RotateProjectVirtualKeyActivity", mock.Anything, mock.Anything).
		Return(types.RotateProjectVirtualKeyResult{
			ProjectId:       "p1",
			OldVirtualKeyId: "old",
			NewVirtualKeyId: "new",
		}, nil)
	env.OnActivity("DeleteRetiredProjectVirtualKeyActivity", mock.Anything, mock.Anything).
		Return(types.DeleteRetiredProjectVirtualKeyResult{ProjectId: "p1", Deleted: true}, nil)

	env.ExecuteWorkflow(ProjectVirtualKeyRotationWorkflow, types.ProjectVKRotationInput{
		ProjectId:   "p1",
		GracePeriod: 0,
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectVirtualKeyRotationWorkflow_Skipped(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RotateProjectVirtualKeyActivity")

	env.OnActivity("RotateProjectVirtualKeyActivity", mock.Anything, mock.Anything).
		Return(types.RotateProjectVirtualKeyResult{ProjectId: "p1", Skipped: true, SkipReason: "no_gateway"}, nil)

	env.ExecuteWorkflow(ProjectVirtualKeyRotationWorkflow, types.ProjectVKRotationInput{ProjectId: "p1"})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

// --- ScheduledKBSyncWorkflow ----------------------------------------------

func TestScheduledKBSyncWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.TriggerKBSyncActivity)
	env.OnActivity(activities.TriggerKBSyncActivity, mock.Anything, mock.Anything).Return(nil)

	env.ExecuteWorkflow(ScheduledKBSyncWorkflow, activities.TriggerKBSyncInput{
		ProjectId: "p", KnowledgeBaseId: "kb",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestScheduledKBSyncWorkflow_Error(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.TriggerKBSyncActivity)
	env.OnActivity(activities.TriggerKBSyncActivity, mock.Anything, mock.Anything).
		Return(errors.New("config-service down"))

	env.ExecuteWorkflow(ScheduledKBSyncWorkflow, activities.TriggerKBSyncInput{ProjectId: "p", KnowledgeBaseId: "kb"})
	require.Error(t, env.GetWorkflowError())
}

// --- DependencyLineageSyncWorkflow ----------------------------------------

func TestDependencyLineageSyncWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunReferenceEdgeReconcileActivity", "BuildLineageGraphActivity")

	want := types.ReferenceEdgeReconcileResult{Added: 2}
	env.OnActivity("RunReferenceEdgeReconcileActivity", mock.Anything, mock.Anything).Return(want, nil)
	env.OnActivity("BuildLineageGraphActivity", mock.Anything, mock.Anything).
		Return(types.BuildLineageGraphResult{}, nil)

	env.ExecuteWorkflow(DependencyLineageSyncWorkflow, types.ReferenceEdgeReconcileInput{
		ConfigServiceURL: "http://x",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.ReferenceEdgeReconcileResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, want, got)
}

func TestDependencyLineageSyncWorkflow_FirstActivityFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunReferenceEdgeReconcileActivity", "BuildLineageGraphActivity")
	env.OnActivity("RunReferenceEdgeReconcileActivity", mock.Anything, mock.Anything).
		Return(types.ReferenceEdgeReconcileResult{}, errors.New("nope"))

	env.ExecuteWorkflow(DependencyLineageSyncWorkflow, types.ReferenceEdgeReconcileInput{})
	require.Error(t, env.GetWorkflowError())
}

func TestDependencyLineageSyncWorkflow_GraphActivityFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "RunReferenceEdgeReconcileActivity", "BuildLineageGraphActivity")
	env.OnActivity("RunReferenceEdgeReconcileActivity", mock.Anything, mock.Anything).
		Return(types.ReferenceEdgeReconcileResult{}, nil)
	env.OnActivity("BuildLineageGraphActivity", mock.Anything, mock.Anything).
		Return(types.BuildLineageGraphResult{}, errors.New("graph build failed"))

	env.ExecuteWorkflow(DependencyLineageSyncWorkflow, types.ReferenceEdgeReconcileInput{})
	require.Error(t, env.GetWorkflowError())
}

// --- DatasetDeleteWorkflow ------------------------------------------------

func TestDatasetDeleteWorkflow_HappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteTableFromCatalogActivity", "DeleteDatasetFilesActivity")

	env.OnActivity("DeleteTableFromCatalogActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("DeleteDatasetFilesActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(DatasetDeleteWorkflow, types.DatasetDeleteWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns", WarehouseId: "wh", BucketName: "b",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.DatasetDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.True(t, got.TableDeleted)
	assert.True(t, got.S3FilesDeleted)
}

func TestDatasetDeleteWorkflow_CatalogFailureContinues(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteTableFromCatalogActivity", "DeleteDatasetFilesActivity")
	env.OnActivity("DeleteTableFromCatalogActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("catalog down"))
	env.OnActivity("DeleteDatasetFilesActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(DatasetDeleteWorkflow, types.DatasetDeleteWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns", WarehouseId: "wh",
	})
	var got types.DatasetDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.False(t, got.TableDeleted)
	assert.True(t, got.S3FilesDeleted)
}

func TestDatasetDeleteWorkflow_S3FailureFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "DeleteTableFromCatalogActivity", "DeleteDatasetFilesActivity")
	env.OnActivity("DeleteTableFromCatalogActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("DeleteDatasetFilesActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("s3 down"))

	env.ExecuteWorkflow(DatasetDeleteWorkflow, types.DatasetDeleteWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns", WarehouseId: "wh",
	})
	require.Error(t, env.GetWorkflowError())
}

// --- TableProcessingWorkflow ----------------------------------------------

func TestTableProcessingWorkflow_HappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubsArgs(env, 4, "GetTableMetadataActivity") // (projectId, namespace, tableName, warehouseId)
	registerStubsArgs(env, 1, "FetchProjectCredentialsActivity", "ProcessKBDocuments")
	registerStubsArgs(env, 4, "UpdateDatasetStatusActivity") // (projectId, datasetId, status, errorMessage)
	env.OnActivity("GetTableMetadataActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"id": "t"}, nil)
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"ok": true}, nil)
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(TableProcessingWorkflow, types.TableProcessingWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns",
	})
	require.NoError(t, env.GetWorkflowError())
	var got types.TableProcessingWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestTableProcessingWorkflow_CatalogFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubsArgs(env, 4, "GetTableMetadataActivity", "UpdateDatasetStatusActivity")
	env.OnActivity("GetTableMetadataActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("catalog down"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(TableProcessingWorkflow, types.TableProcessingWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestTableProcessingWorkflow_CredsFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubsArgs(env, 4, "GetTableMetadataActivity", "UpdateDatasetStatusActivity")
	registerStubsArgs(env, 1, "FetchProjectCredentialsActivity")
	env.OnActivity("GetTableMetadataActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{}, nil)
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("creds missing"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(TableProcessingWorkflow, types.TableProcessingWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestTableProcessingWorkflow_ProcessingFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubsArgs(env, 4, "GetTableMetadataActivity", "UpdateDatasetStatusActivity")
	registerStubsArgs(env, 1, "FetchProjectCredentialsActivity", "ProcessKBDocuments")
	env.OnActivity("GetTableMetadataActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{}, nil)
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(nil, errors.New("processing failed"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(TableProcessingWorkflow, types.TableProcessingWorkflowInput{
		ProjectId: "p", DataSetId: "d", TableName: "t", Namespace: "ns",
	})
	require.Error(t, env.GetWorkflowError())
}

// --- ConnectorInteractiveWorkflow -----------------------------------------

func TestConnectorInteractiveWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "TestObjectStoreConnection")
	env.OnActivity("TestObjectStoreConnection", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"success": true, "message": "ok"}, nil)

	env.ExecuteWorkflow(ConnectorInteractiveWorkflow, ConnectorInteractiveInput{
		ProjectID: "p", ActivityName: "TestObjectStoreConnection", ConnectorConfig: map[string]interface{}{},
	})
	require.NoError(t, env.GetWorkflowError())
	var got ConnectorInteractiveResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.True(t, got.Success)
	assert.Equal(t, "ok", got.Message)
}

func TestConnectorInteractiveWorkflow_ActivitySaysFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "TestDatabaseConnection")
	env.OnActivity("TestDatabaseConnection", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"success": false, "message": "refused"}, nil)

	env.ExecuteWorkflow(ConnectorInteractiveWorkflow, ConnectorInteractiveInput{
		ProjectID: "p", ActivityName: "TestDatabaseConnection",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestConnectorInteractiveWorkflow_ActivityErrors(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "TestProviderConnection")
	env.OnActivity("TestProviderConnection", mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal-level fail"))

	env.ExecuteWorkflow(ConnectorInteractiveWorkflow, ConnectorInteractiveInput{
		ProjectID: "p", ActivityName: "TestProviderConnection",
	})
	require.Error(t, env.GetWorkflowError())
}

// --- ExplorerListWorkflow --------------------------------------------------

func TestExplorerListWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "ExplorerAction")
	env.OnActivity("ExplorerAction", mock.Anything, mock.Anything).Return(ExplorerResponse{
		Nodes: []ExplorerNode{{ID: "x", Label: "x"}},
	}, nil)

	env.ExecuteWorkflow(ExplorerListWorkflow, ExplorerListInput{
		ProjectID: "p", ConnectorID: "c", Provider: "ontap", Action: "list",
	})
	require.NoError(t, env.GetWorkflowError())
	var got ExplorerResponse
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Len(t, got.Nodes, 1)
}

func TestExplorerListWorkflow_ActivityErrorWrappedInResponse(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "ExplorerAction")
	env.OnActivity("ExplorerAction", mock.Anything, mock.Anything).
		Return(ExplorerResponse{}, errors.New("network error"))

	env.ExecuteWorkflow(ExplorerListWorkflow, ExplorerListInput{ProjectID: "p", ConnectorID: "c"})

	// Explorer flow surfaces errors inside the response envelope, not as workflow error.
	require.NoError(t, env.GetWorkflowError())
	var got ExplorerResponse
	require.NoError(t, env.GetWorkflowResult(&got))
	require.NotNil(t, got.Error)
	assert.Equal(t, "ACTIVITY_ERROR", got.Error.Code)
}

// --- VolumeBrowseWorkflow --------------------------------------------------

func TestVolumeBrowseWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	registerStubs(env, "ListVolumeDirectory")
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"name": "vol-a"}, nil)
	env.OnActivity("ListVolumeDirectory", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"entries": []interface{}{"f1"}}, nil)

	env.ExecuteWorkflow(VolumeBrowseWorkflow, VolumeBrowseInput{ProjectID: "p", VolumeID: "v"})
	require.NoError(t, env.GetWorkflowError())
	var got map[string]interface{}
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.NotEmpty(t, got)
}

func TestVolumeBrowseWorkflow_FetchFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("config-service down"))

	env.ExecuteWorkflow(VolumeBrowseWorkflow, VolumeBrowseInput{ProjectID: "p", VolumeID: "v"})
	require.Error(t, env.GetWorkflowError())
}

func TestVolumeBrowseWorkflow_ActivityFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	registerStubs(env, "ListVolumeDirectory")
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"name": "v"}, nil)
	env.OnActivity("ListVolumeDirectory", mock.Anything, mock.Anything).
		Return(nil, errors.New("activity failed"))

	env.ExecuteWorkflow(VolumeBrowseWorkflow, VolumeBrowseInput{ProjectID: "p", VolumeID: "v"})
	require.Error(t, env.GetWorkflowError())
}

// --- VolumeScanWorkflow ---------------------------------------------------

func TestVolumeScanWorkflow_Success(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	env.RegisterActivity(activities.PostScanResultActivity)
	registerStubs(env, "ScanVolume")
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"name": "vol-1"}, nil)
	env.OnActivity("ScanVolume", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"total_files": int64(10)}, nil)
	env.OnActivity(activities.PostScanResultActivity,
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything,
	).Return(nil)

	env.ExecuteWorkflow(VolumeScanWorkflow, VolumeScanInput{ProjectID: "p", DataSourceID: "ds"})
	require.NoError(t, env.GetWorkflowError())
}

func TestVolumeScanWorkflow_FetchVolumeFails_PostsFailureAndErrors(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	env.RegisterActivity(activities.PostScanResultActivity)
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("config-service down"))
	env.OnActivity(activities.PostScanResultActivity,
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything,
	).Return(nil)

	env.ExecuteWorkflow(VolumeScanWorkflow, VolumeScanInput{ProjectID: "p", DataSourceID: "ds"})
	require.Error(t, env.GetWorkflowError())
}

func TestVolumeScanWorkflow_ScanFails_PostsFailureAndErrors(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	env.RegisterActivity(activities.PostScanResultActivity)
	registerStubs(env, "ScanVolume")
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"name": "v"}, nil)
	env.OnActivity("ScanVolume", mock.Anything, mock.Anything).
		Return(nil, errors.New("scan crashed"))
	env.OnActivity(activities.PostScanResultActivity,
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything,
	).Return(nil)

	env.ExecuteWorkflow(VolumeScanWorkflow, VolumeScanInput{ProjectID: "p", DataSourceID: "ds"})
	require.Error(t, env.GetWorkflowError())
}

func TestVolumeScanWorkflow_PostFailureSwallowed(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	env.RegisterActivity(activities.FetchDataSourceConfigActivity)
	env.RegisterActivity(activities.PostScanResultActivity)
	registerStubs(env, "ScanVolume")
	env.OnActivity(activities.FetchDataSourceConfigActivity, mock.Anything, mock.Anything, mock.Anything).
		Return(map[string]interface{}{"name": "v"}, nil)
	env.OnActivity("ScanVolume", mock.Anything, mock.Anything).
		Return(map[string]interface{}{}, nil)
	env.OnActivity(activities.PostScanResultActivity,
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything,
	).Return(errors.New("post failed"))

	env.ExecuteWorkflow(VolumeScanWorkflow, VolumeScanInput{ProjectID: "p", DataSourceID: "ds"})
	// Final post failure on success path is logged-only; workflow still succeeds.
	require.NoError(t, env.GetWorkflowError())
}
