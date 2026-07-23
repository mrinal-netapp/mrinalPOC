package activities

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestDeleteKBFilesActivity_MissingS3Credentials(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteKBFilesActivity)

	_, err := env.ExecuteActivity(DeleteKBFilesActivity, types.DeleteKBFilesRequest{
		ProjectId: "p1", KnowledgeBaseId: "kb1", BucketName: "p1",
	})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "S3 credentials not configured")
}
