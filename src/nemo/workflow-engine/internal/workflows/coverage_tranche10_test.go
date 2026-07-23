package workflows

import (
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestKnowledgeBaseCreationWorkflow_IncrementalHappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	in := kbCreationInput()
	in.ProcessingMode = "incremental"

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(map[string]interface{}{
			"status": "success", "lanceTablePath": "s3://b/kb/lance",
			"documentCount": float64(3), "chunkCount": float64(9), "vectorCount": float64(9),
		}, nil)
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("UpdateKBStatusWithStatsActivity", mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, in)
	require.NoError(t, env.GetWorkflowError())
	var got types.KnowledgeBaseCreationWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestKnowledgeBaseCreationWorkflow_IncrementalProcessFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	in := kbCreationInput()
	in.ProcessingMode = "incremental"

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(nil, errors.New("worker down"))
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, in)
	require.Error(t, env.GetWorkflowError())
}

func TestKnowledgeBaseCreationWorkflow_IncrementalReadsMetadataFromS3(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)

	in := kbCreationInput()
	in.ProcessingMode = "incremental"

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, nil)
	env.OnActivity("ProcessKBDocuments", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"status": "success"}, nil)
	env.OnActivity("ReadKBMetadataActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(types.KBMetadata{
			Status: "success", LanceTablePath: "s3://b/path",
			DocumentCount: 1, ChunkCount: 2, VectorCount: 2,
		}, nil)
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("UpdateKBStatusWithStatsActivity", mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, in)
	require.NoError(t, env.GetWorkflowError())
}
