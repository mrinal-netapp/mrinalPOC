package workflows

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestProjectInitWorkflow_PersistWarnContinues(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "UpdateProjectMetadataActivity",
		"CreateNamespaceActivity", "CreateProjectServiceAccountActivity",
		"ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).
		Return(nil, assert.AnError)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "wh-1", Found: true}, nil)
	env.OnActivity("UpdateProjectMetadataActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateNamespaceActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("CreateProjectServiceAccountActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestProjectInitWorkflow_WarehouseNotFound(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"RegisterProjectResourceActivity", "GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity", "SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity", "ReportProjectInitStatusActivity",
	)
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{WarehouseId: "", Found: false}, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p1", OwnerUserId: "owner-1",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

func TestDataAcquisitionWorkflow_CloudGCPPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)

	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "gcp-ds", "kind": "files", "bucketName": "dest-bucket",
				"namespace": "default", "originConnector": "conn-gcp",
				"filterSpec": map[string]interface{}{"sourcePath": "my-bucket/data/"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "cloud",
				"connectorConfig": map[string]interface{}{
					"connector_type": "cloud", "provider": "gcp", "bucket": "src",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{
				"fileListKey": "projects/p1/datasets/d1/_acquisition/filelist.json",
				"filesCopied": float64(2),
			}, nil
		},
		activity.RegisterOptions{Name: "AcquireFromGCS"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)

	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}

func TestKbMetadataFromMergeResult_NestedStats(t *testing.T) {
	got := kbMetadataFromMergeResult(map[string]interface{}{
		"status": "success", "lanceTablePath": "s3://b/kb/lancedb",
		"stats": map[string]interface{}{
			"documentCount": float64(3), "chunkCount": float64(12), "vectorCount": float64(12),
			"storageBytes": float64(1024), "storageMB": float64(0.001), "fileCount": float64(2),
			"lastProcessedAt": "2026-06-01T00:00:00Z",
		},
	})
	require.NotNil(t, got)
	assert.Equal(t, 3, got.DocumentCount)
	assert.Equal(t, 12, got.ChunkCount)
	require.NotNil(t, got.Stats)
	assert.Equal(t, int64(1024), got.Stats.StorageBytes)
}

func TestToNumericHelpers_AllTypes(t *testing.T) {
	v, ok := toInt(int64(7))
	assert.True(t, ok)
	assert.Equal(t, 7, v)
	v64, ok := toInt64(int(9))
	assert.True(t, ok)
	assert.Equal(t, int64(9), v64)
	f, ok := toFloat64(int64(3))
	assert.True(t, ok)
	assert.Equal(t, float64(3), f)
	_, ok = toInt("bad")
	assert.False(t, ok)
}

func TestApplyDatabaseSourceOverlay(t *testing.T) {
	cfg := map[string]interface{}{"database": "conn-db"}
	ds := map[string]interface{}{"sourceDatabase": "analytics", "sourceSchema": "public"}
	applyDatabaseSourceOverlay(cfg, ds)
	assert.Equal(t, "analytics", cfg["database"])
	assert.Equal(t, "public", cfg["schema"])
}

func TestDataAcquisitionWorkflow_MetricsOverwriteRejected(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "m", "bucketName": "b", "originConnector": "c",
				"resourceSelector": []interface{}{
					map[string]interface{}{"category": "latency"},
				},
				"acquisitionConfig": map[string]interface{}{"writeMode": "overwrite"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "cloud",
				"connectorConfig": map[string]interface{}{
					"connector_type": "cloud", "provider": "ontap",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "overwrite")
}

func TestKnowledgeBaseCreationWorkflow_IncrementalFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"ClearStaleProgressActivity", "FetchProjectCredentialsActivity",
		"ProcessKBDocuments", "UpdateKBStatusActivity",
	)
	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(nil, assert.AnError)
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	in := kbCreationInput()
	in.ProcessingMode = "incremental"
	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, in)
	require.Error(t, env.GetWorkflowError())
}
