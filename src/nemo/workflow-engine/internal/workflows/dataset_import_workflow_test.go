package workflows

import (
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func registerDatasetImportStubs(env *testsuite.TestWorkflowEnvironment) {
	registerStubsArgs(env, 1, "FetchProjectCredentialsActivity")
	registerStubsArgs(env, 4, "UpdateDatasetStatusActivity")
	registerStubsArgs(env, 3, "ReadProcessingResultActivity")
	registerStubsArgs(env, 1, "PostWorkflowProgressActivity", "UpdateDatasetStatsFacetActivity")
	registerStubs(env, "CreateWorkPlanActivity", "ProcessDatasetFiles", "MergeDatasetResults", "ReprocessPiiFiles", "MergePiiResults")
}

func datasetImportInput() types.DatasetImportWorkflowInput {
	return types.DatasetImportWorkflowInput{
		ProjectId: "p1", DataSetId: "d1", DatasetName: "ds", BucketName: "b1",
		Namespace: "ns", WarehouseId: "wh-1", DatasetKind: "files",
	}
}

func TestBuildDatasetWorkUnitInput_IncludesCredentials(t *testing.T) {
	in := datasetImportInput()
	creds := types.ProjectCredentials{ProjectClientId: "cid", S3AccessKey: "ak"}
	fs := types.FileSet{SetID: "s1", ManifestS3Key: "m.json", OutputPrefix: "out/"}
	got := buildDatasetWorkUnitInput(in, creds, fs, "job/", "wf-1")
	assert.Equal(t, "d1", got["dataset_id"])
	assert.Equal(t, "cid", got["project_client_id"])
	assert.Equal(t, "ak", got["aws_access_key_id"])
	assert.Equal(t, "s1", got["set_id"])
}

func TestBuildDatasetMergeInput_IncludesWarehouse(t *testing.T) {
	in := datasetImportInput()
	got := buildDatasetMergeInput(in, types.ProjectCredentials{}, "job/", "wf-1")
	assert.Equal(t, "wh-1", got["warehouse_id"])
	assert.Equal(t, "wf-1", got["workflow_id"])
}

func TestDatasetImportWorkflow_WorkPlanFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).
		Return(types.WorkPlan{}, errors.New("plan failed"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, datasetImportInput())
	require.Error(t, env.GetWorkflowError())
}

func TestDatasetImportWorkflow_HappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)

	creds := types.ProjectCredentials{ConfigServiceURL: "http://cfg", S3AccessKey: "ak", S3SecretKey: "sk"}
	plan := types.WorkPlan{
		TotalFiles:      2,
		FileSets:        []types.FileSet{{SetID: "set-0", ManifestS3Key: "m.json", OutputPrefix: "out/"}},
		JobOutputPrefix: "jobs/wf/",
	}

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).Return(creds, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ProcessDatasetFiles", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "set-0", Status: "success", FileCount: 2, RowCount: 10}, nil)
	env.OnActivity("MergeDatasetResults", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"merged": true}, nil)
	env.OnActivity("ReadProcessingResultActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(types.ProcessingResult{
			Status: "success", CatalogRegistered: true, CatalogTableRef: "ns.t",
			SourceFileCount: 2, RowCount: 10, ColumnCount: 3,
		}, nil)
	env.OnActivity("UpdateDatasetStatsFacetActivity", mock.Anything, mock.Anything).Return(nil)
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, datasetImportInput())
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.DatasetImportWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.Equal(t, "ns.t", got.CatalogTable)
}

func TestDatasetImportWorkflow_ProcessingResultNotSuccess(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)

	plan := types.WorkPlan{
		TotalFiles:      1,
		FileSets:        []types.FileSet{{SetID: "set-0"}},
		JobOutputPrefix: "jobs/",
	}
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ProcessDatasetFiles", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "set-0", Status: "success"}, nil)
	env.OnActivity("MergeDatasetResults", mock.Anything, mock.Anything).
		Return(map[string]interface{}{}, nil)
	env.OnActivity("ReadProcessingResultActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(types.ProcessingResult{Status: "failed", Error: "bad parquet"}, nil)
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, datasetImportInput())
	require.Error(t, env.GetWorkflowError())
}

func TestDatasetImportWorkflow_CatalogNotRegisteredFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)

	plan := types.WorkPlan{TotalFiles: 1, FileSets: []types.FileSet{{SetID: "s0"}}, JobOutputPrefix: "j/"}
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ProcessDatasetFiles", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "s0", Status: "success"}, nil)
	env.OnActivity("MergeDatasetResults", mock.Anything, mock.Anything).
		Return(map[string]interface{}{}, nil)
	env.OnActivity("ReadProcessingResultActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(types.ProcessingResult{Status: "success", CatalogRegistered: false}, nil)
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, datasetImportInput())
	require.Error(t, env.GetWorkflowError())
}

func TestDatasetImportWorkflow_PiiReprocessHappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)

	creds := types.ProjectCredentials{ConfigServiceURL: "http://cfg"}
	plan := types.WorkPlan{
		TotalFiles: 1, JobOutputPrefix: "jobs/",
		FileSets: []types.FileSet{{SetID: "s0", ManifestS3Key: "m", OutputPrefix: "o/"}},
	}

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).Return(creds, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ReprocessPiiFiles", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "s0", Status: "success"}, nil)
	env.OnActivity("MergePiiResults", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"ok": true}, nil)
	env.OnActivity("UpdateDatasetStatsFacetActivity", mock.Anything, mock.Anything).Return(nil)
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	in := datasetImportInput()
	in.ReprocessPiiOnly = true
	env.ExecuteWorkflow(DatasetImportWorkflow, in)

	require.NoError(t, env.GetWorkflowError())
	var got types.DatasetImportWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestBuildPiiReprocessWorkUnitInput_ForcesPiiFlags(t *testing.T) {
	got := buildPiiReprocessWorkUnitInput(
		datasetImportInput(), types.ProjectCredentials{}, types.FileSet{SetID: "s"}, "job/", "wf",
	)
	assert.Equal(t, true, got["enable_pii_analysis"])
	assert.Equal(t, true, got["reprocess_pii_only"])
}

func TestPostWorkflowProgressInput_UsedByDatasetImport(t *testing.T) {
	// Sanity: activities package type is referenced by workflow progress posts.
	_ = activities.PostWorkflowProgressInput{Phase: "importing", Percentage: 2}
}
