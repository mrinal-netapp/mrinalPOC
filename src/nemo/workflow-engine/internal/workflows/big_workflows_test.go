package workflows

import (
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

// TestDatasetImportWorkflow_CredsFailure walks the credentials-fetch failure
// short-path: workflow updates dataset status to "errored" and returns the
// underlying error.
func TestDatasetImportWorkflow_CredsFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubs(env, "FetchProjectCredentialsActivity")
	registerStubsArgs(env, 4, "UpdateDatasetStatusActivity")

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("creds missing"))
	env.OnActivity("UpdateDatasetStatusActivity",
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(DatasetImportWorkflow, types.DatasetImportWorkflowInput{
		ProjectId: "p", DataSetId: "d", DatasetName: "name", BucketName: "b",
	})
	require.Error(t, env.GetWorkflowError())
}

// TestKnowledgeBaseCreationWorkflow_CredsFailure walks the credentials-fetch
// failure short-path: workflow updates KB status to "errored" and returns
// the underlying error.
func TestKnowledgeBaseCreationWorkflow_CredsFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerStubsArgs(env, 3, "ClearStaleProgressActivity")
	registerStubs(env, "FetchProjectCredentialsActivity")
	registerStubsArgs(env, 5, "UpdateKBStatusActivity")

	env.OnActivity("ClearStaleProgressActivity",
		mock.Anything, mock.Anything, mock.Anything, mock.Anything).Return(nil).Maybe()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("creds missing"))
	env.OnActivity("UpdateKBStatusActivity",
		mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil)

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, types.KnowledgeBaseCreationWorkflowInput{
		ProjectId: "p", KnowledgeBaseId: "kb", BucketName: "b",
		KBName: "n", SourceDatasetId: "d",
	})
	require.Error(t, env.GetWorkflowError())
}

// TestProjectInitWorkflow_StubFailure ensures the workflow surfaces an
// activity error rather than swallowing it. The Keycloak authz block runs first
// (register resource -> grant admin -> persist), then the infra steps. We let
// the authz block + gateway succeed so the workflow reaches
// LookupWarehouseActivity and surfaces that failure.
func TestProjectInitWorkflow_StubFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()

	// Register stubs for every activity the workflow may invoke before the
	// injected failure. Temporal short-circuits on the first error so later
	// steps are never called.
	registerStubs(env,
		"RegisterProjectResourceActivity",
		"GrantInitialAdminActivity",
		"PersistKeycloakResourceIdActivity",
		"SetupProjectLLMGatewayActivity",
		"LookupWarehouseActivity",
		"UpdateProjectMetadataActivity",
		"CreateNamespaceActivity",
		"CreateProjectServiceAccountActivity",
		"ReportProjectInitStatusActivity")

	// Authz block succeeds so the owner becomes admin before infra runs.
	env.OnActivity("RegisterProjectResourceActivity", mock.Anything, mock.Anything).
		Return(types.RegisterProjectResourceResult{ResourceId: "kc-res"}, nil)
	env.OnActivity("GrantInitialAdminActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("PersistKeycloakResourceIdActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("SetupProjectLLMGatewayActivity", mock.Anything, mock.Anything).Return(nil, nil)
	env.OnActivity("LookupWarehouseActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("lookup warehouse fail"))
	// Terminal status report always runs (best-effort).
	env.OnActivity("ReportProjectInitStatusActivity", mock.Anything, mock.Anything).Return(nil, nil)

	env.ExecuteWorkflow(ProjectInitWorkflow, types.ProjectInitWorkflowInput{
		ProjectId: "p", OwnerUserId: "owner-1", Region: "us-east-1", StorageClass: "standard", StorageSize: "1Gi",
	})
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError(),
		"workflow must surface the LookupWarehouseActivity error rather than swallowing it")
}
