package workflows

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestExplorerSessionWorkflow_IdleTimeoutCompletes(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "ExplorerAction")
	env.RegisterWorkflow(ExplorerSessionWorkflow)

	// Advance workflow clock past the 30-minute idle timeout.
	env.RegisterDelayedCallback(func() {}, 31*time.Minute)

	env.ExecuteWorkflow(ExplorerSessionWorkflow, ExplorerSessionInput{
		ProjectID:        "p1",
		ConnectorID:      "c1",
		ConnectorConfig:  map[string]interface{}{"provider": "ontap"},
		CredentialID:     "cred-1",
		ConfigServiceURL: "http://cfg",
		Provider:         "ontap",
		Scope:            "resource",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}
