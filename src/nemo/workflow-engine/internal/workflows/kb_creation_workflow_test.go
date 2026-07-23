package workflows

import (
	"errors"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func kbCreationInput() types.KnowledgeBaseCreationWorkflowInput {
	return types.KnowledgeBaseCreationWorkflowInput{
		ProjectId: "p1", KnowledgeBaseId: "kb1", KBName: "kb",
		SourceDatasetId: "d1", BucketName: "b1", EmbeddingModel: "emb",
	}
}

func registerKBCreationStubs(env *testsuite.TestWorkflowEnvironment) {
	registerStubsArgs(env, 3, "ClearStaleProgressActivity", "UpdateKBProgressActivity")
	registerStubsArgs(env, 1, "FetchProjectCredentialsActivity")
	registerStubsArgs(env, 5, "UpdateKBStatusActivity")
	registerStubsArgs(env, 1, "PostWorkflowProgressActivity", "UpdateKBStatusWithStatsActivity", "ReadKBMetadataActivity")
	registerStubs(env, "CreateWorkPlanActivity", "ProcessKBDocuments", "MergeKBResults")
}

func TestClampDuration(t *testing.T) {
	assert.Equal(t, 2*time.Second, clampDuration(time.Second, 2*time.Second, 5*time.Second))
	assert.Equal(t, 5*time.Second, clampDuration(10*time.Second, 2*time.Second, 5*time.Second))
	assert.Equal(t, 3*time.Second, clampDuration(3*time.Second, 2*time.Second, 5*time.Second))
}

func TestGetEnvOrDefault(t *testing.T) {
	t.Setenv("TEST_KB_ENV", "")
	assert.Equal(t, "default", getEnvOrDefault("TEST_KB_ENV", "default"))
	t.Setenv("TEST_KB_ENV", "custom")
	assert.Equal(t, "custom", getEnvOrDefault("TEST_KB_ENV", "default"))
}

func TestKbMetadataFromMergeResult_HappyPath(t *testing.T) {
	got := kbMetadataFromMergeResult(map[string]interface{}{
		"status": "success", "lanceTablePath": "s3://b/kb/lance",
		"documentCount": float64(5), "chunkCount": float64(20), "vectorCount": float64(20),
		"stats": map[string]interface{}{"storageBytes": float64(1024), "fileCount": float64(3)},
	})
	require.NotNil(t, got)
	assert.Equal(t, "s3://b/kb/lance", got.LanceTablePath)
	assert.Equal(t, 5, got.DocumentCount)
	assert.Equal(t, 20, got.ChunkCount)
	require.NotNil(t, got.Stats)
	assert.Equal(t, int64(1024), got.Stats.StorageBytes)
}

func TestKbMetadataFromMergeResult_ReturnsNilWithoutPathOrCounts(t *testing.T) {
	assert.Nil(t, kbMetadataFromMergeResult(nil))
	assert.Nil(t, kbMetadataFromMergeResult(map[string]interface{}{"status": "success"}))
	assert.Nil(t, kbMetadataFromMergeResult(map[string]interface{}{
		"lanceTablePath": "path", "chunkCount": float64(0),
	}))
}

func TestToIntAndToInt64AndToFloat64(t *testing.T) {
	v, ok := toInt(float64(7))
	assert.True(t, ok)
	assert.Equal(t, 7, v)
	_, ok = toInt("bad")
	assert.False(t, ok)

	v64, ok := toInt64(int64(99))
	assert.True(t, ok)
	assert.Equal(t, int64(99), v64)

	f, ok := toFloat64(float64(1.5))
	assert.True(t, ok)
	assert.Equal(t, 1.5, f)
}

func TestBuildKBWorkUnitInput_IncludesEmbeddingFields(t *testing.T) {
	in := kbCreationInput()
	in.EmbeddingModelId = "model-1"
	in.EmbeddingProvider = "openai"
	fs := types.FileSet{SetID: "s1", ManifestS3Key: "m", OutputPrefix: "o/"}
	got := buildKBWorkUnitInput(in, types.ProjectCredentials{ProjectClientId: "cid"}, fs, "job/", "wf-1")
	assert.Equal(t, "kb1", got["kb_id"])
	assert.Equal(t, "model-1", got["embedding_model_id"])
	assert.Equal(t, "openai", got["embedding_provider"])
	assert.Equal(t, "cid", got["project_client_id"])
}

func TestKnowledgeBaseCreationWorkflow_WorkPlanFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).
		Return(types.WorkPlan{}, errors.New("no files"))
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateKBProgressActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, kbCreationInput())
	require.Error(t, env.GetWorkflowError())
}

func TestKnowledgeBaseCreationWorkflow_FullPathHappy(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	plan := types.WorkPlan{
		TotalFiles:      3,
		FileSets:        []types.FileSet{{SetID: "s0", ManifestS3Key: "m", OutputPrefix: "o/"}},
		JobOutputPrefix: "jobs/",
	}
	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "s0", Status: "success", FileCount: 3, RowCount: 12}, nil)
	env.OnActivity("MergeKBResults", mock.Anything, mock.Anything).
		Return(map[string]interface{}{
			"status": "success", "lanceTablePath": "s3://b/kb/lance",
			"documentCount": float64(3), "chunkCount": float64(12), "vectorCount": float64(12),
		}, nil)
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("UpdateKBStatusWithStatsActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateKBProgressActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, kbCreationInput())
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.KnowledgeBaseCreationWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.Equal(t, "s3://b/kb/lance", got.LanceTablePath)
}

func TestKnowledgeBaseCreationWorkflow_IncrementalHappy(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(map[string]interface{}{
			"status": "success", "lanceTablePath": "s3://b/kb/inc",
			"documentCount": float64(1), "chunkCount": float64(4), "vectorCount": float64(4),
		}, nil)
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("UpdateKBStatusWithStatsActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateKBProgressActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil).Maybe()

	in := kbCreationInput()
	in.ProcessingMode = "incremental"
	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, in)

	require.NoError(t, env.GetWorkflowError())
	var got types.KnowledgeBaseCreationWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.Equal(t, "s3://b/kb/inc", got.LanceTablePath)
}

func TestKnowledgeBaseCreationWorkflow_MergeFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	plan := types.WorkPlan{TotalFiles: 1, FileSets: []types.FileSet{{SetID: "s0"}}, JobOutputPrefix: "j/"}
	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).Return(plan, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(types.WorkUnitResult{SetID: "s0", Status: "success"}, nil)
	env.OnActivity("MergeKBResults", mock.Anything, mock.Anything).
		Return(nil, errors.New("merge boom"))
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("UpdateKBProgressActivity", mock.Anything, mock.Anything, mock.Anything).Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, kbCreationInput())
	require.Error(t, env.GetWorkflowError())
}

func TestKnowledgeBaseCreationWorkflow_ClearStaleProgressContinues(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(errors.New("s3 glitch"))
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("creds missing"))
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, kbCreationInput())
	// creds failure is the terminal error; clear-stale warning must not mask it.
	require.Error(t, env.GetWorkflowError())
}
