package activities

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestDeleteProjectCredentialSecretsActivity_OutOfClusterConfig(t *testing.T) {
	t.Setenv("NAMESPACE", "agentstudio")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteProjectCredentialSecretsActivity)

	_, err := env.ExecuteActivity(DeleteProjectCredentialSecretsActivity, "project-1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}
