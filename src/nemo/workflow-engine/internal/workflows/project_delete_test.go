package workflows

import (
	"context"
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
)

// TestProjectDeleteWorkflow_WarehouseNotFound walks the short path: lookup says
// not-found, so the workflow skips warehouse cleanup and goes straight to
// secrets + bucket deletion.
func TestProjectDeleteWorkflow_WarehouseNotFound(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{Found: false}, nil)
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).
		Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId: "p1", BucketName: "b1",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.ProjectDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.True(t, got.BucketDeleted)
	assert.False(t, got.WarehouseUnregistered)
}

// TestProjectDeleteWorkflow_GatewayTeardownForwardsMeta verifies that the
// preloaded ProjectGatewayMeta captured by the DELETE handler is forwarded
// verbatim into TeardownProjectLLMGatewayActivity's input. This is the
// load-bearing wiring that lets the workflow drop the project's Bifrost
// VK / team in Bifrost's `config_store` even after the project row in
// config-service Postgres has been deleted (the handler returns 204 +
// drops the row inline, then the workflow runs asynchronously).
//
// We capture the activity input via SetOnActivityStartedListener and
// re-decode through the Temporal data converter, because the test-suite
// registers stub activities with a generic argument list, so a typed
// `mock.MatchedBy(func(types.TeardownProjectLLMGatewayInput) bool {...})`
// callback never sees a typed argument -- it gets handed the raw payload.
func TestProjectDeleteWorkflow_GatewayTeardownForwardsMeta(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)

	var gotInput types.TeardownProjectLLMGatewayInput
	env.SetOnActivityStartedListener(func(activityInfo *activity.Info, ctx context.Context, args converter.EncodedValues) {
		if activityInfo.ActivityType.Name != "TeardownProjectLLMGatewayActivity" {
			return
		}
		require.NoError(t, args.Get(&gotInput))
	})

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{Found: false}, nil)
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).
		Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).Return(nil, nil)

	gatewayMeta := &types.ProjectGatewayMeta{
		TeamId:         "team-abc",
		TeamName:       "as-proj-p1",
		VirtualKeyId:   "vk-xyz",
		VirtualKeyName: "as-proj-p1-vk",
	}

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId:  "p1",
		BucketName: "b1",
		Gateway:    gatewayMeta,
	})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	require.Equal(t, "p1", gotInput.ProjectId)
	require.NotNil(t, gotInput.Gateway)
	require.Equal(t, "team-abc", gotInput.Gateway.TeamId)
	require.Equal(t, "vk-xyz", gotInput.Gateway.VirtualKeyId)
	require.Equal(t, "as-proj-p1", gotInput.Gateway.TeamName)
	require.Equal(t, "as-proj-p1-vk", gotInput.Gateway.VirtualKeyName)
}

// TestProjectDeleteWorkflow_GatewayTeardownFailureIsNonFatal verifies that
// the workflow continues to the Iceberg / S3 / cred-secret cleanup steps
// even if Step 0 (Bifrost teardown) fails. The user has explicitly asked
// for the project to go away -- a transient Bifrost outage should not
// keep the project alive forever. Residual VK / team leaks are detected
// by `ensureProjectGateway`'s self-heal sweep on any project re-creation
// with the same id.
func TestProjectDeleteWorkflow_GatewayTeardownFailureIsNonFatal(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("bifrost unreachable"))
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{Found: false}, nil)
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).
		Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId: "p1", BucketName: "b1",
	})

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())

	var got types.ProjectDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.True(t, got.BucketDeleted)
}

// TestProjectDeleteWorkflow_FullPath walks every step end-to-end: lookup finds
// a warehouse, namespaces are listed, tables and namespaces are deleted, the
// warehouse is unregistered, secrets cleaned up, and the bucket is deleted.
func TestProjectDeleteWorkflow_FullPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"ListNamespacesActivity",
		"ListTablesInWarehouseActivity",
		"UnregisterWarehouseActivity",
		"DeleteNamespaceActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)
	registerStubsArgs(env, 3, "DeleteTableFromCatalogByNameActivity")

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{Found: true, WarehouseId: "wh-1"}, nil)
	env.OnActivity("ListNamespacesActivity", mock.Anything, mock.Anything).
		Return(types.ListNamespacesResult{Namespaces: []string{"default", "ns-1"}}, nil)
	env.OnActivity("ListTablesInWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.ListTablesResult{Tables: []string{"t1"}}, nil)
	env.OnActivity("DeleteTableFromCatalogByNameActivity",
		mock.Anything, mock.Anything, mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("DeleteNamespaceActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("UnregisterWarehouseActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId: "p1", BucketName: "b1",
	})

	require.NoError(t, env.GetWorkflowError())
	var got types.ProjectDeleteWorkflowResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.True(t, got.WarehouseUnregistered)
	assert.True(t, got.BucketDeleted)
}

func TestProjectDeleteWorkflow_BucketDeleteErrorFails(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{Found: false}, nil)
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).
		Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("bucket delete failed"))

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId: "p1", BucketName: "b1",
	})
	require.Error(t, env.GetWorkflowError())
}

func TestProjectDeleteWorkflow_LookupWarehouseErrorContinues(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env,
		"TeardownProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"DeleteProjectCredentialSecretsActivity",
		"DeleteBucketActivity",
	)

	env.OnActivity("TeardownProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(types.LookupWarehouseResult{}, errors.New("lookup down"))
	env.OnActivity("DeleteProjectCredentialSecretsActivity", mock.Anything, mock.Anything).
		Return(nil, nil)
	env.OnActivity("DeleteBucketActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectDeleteWorkflow, types.ProjectDeleteWorkflowInput{
		ProjectId: "p1", BucketName: "b1",
	})
	// Lookup error is non-fatal — workflow proceeds.
	require.NoError(t, env.GetWorkflowError())
}
