package workflows

import (
	"errors"
	"os"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestDataAcquisitionWorkflow_PipelineDiscoverFailure(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "true"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "kind": "files", "bucketName": "dest",
				"originConnector": "conn",
				"resourceSelector": []interface{}{
					map[string]interface{}{"bucket": "src", "prefix": "p/"},
				},
				"acquisitionConfig": map[string]interface{}{"writeMode": "append"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connectorConfig": map[string]interface{}{
					"connector_type": "objectstore", "provider": "s3",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return nil, errors.New("discover down")
		},
		activity.RegisterOptions{Name: "DiscoverSourceItems"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"status": "failed"}, nil
		},
		activity.RegisterOptions{Name: "FinalizeAcquisition"},
	)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "DiscoverSourceItems")
}

func TestDataAcquisitionWorkflow_PipelineZeroDiscovered(t *testing.T) {
	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "true"))
	t.Cleanup(func() { _ = os.Unsetenv("ACQ_USE_PIPELINE") })

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDataAcquisitionStatusMocks(env)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"name": "ds", "kind": "files", "bucketName": "dest",
				"originConnector": "conn",
				"resourceSelector": []interface{}{
					map[string]interface{}{"bucket": "src", "prefix": "p/"},
				},
				"acquisitionConfig": map[string]interface{}{"writeMode": "append"},
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDatasetConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(_, _ string) (map[string]interface{}, error) {
			return map[string]interface{}{
				"type": "objectstore",
				"connectorConfig": map[string]interface{}{
					"connector_type": "objectstore", "provider": "s3",
				},
				"credentialId": "cred",
			}, nil
		},
		activity.RegisterOptions{Name: "FetchDataSourceConfigActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"totalDiscovered": float64(0)}, nil
		},
		activity.RegisterOptions{Name: "DiscoverSourceItems"},
	)
	env.RegisterActivityWithOptions(
		func(activities.PostWorkflowProgressInput) error { return nil },
		activity.RegisterOptions{Name: "PostWorkflowProgressActivity"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (types.WorkUnitResult, error) {
			return types.WorkUnitResult{Status: "success"}, nil
		},
		activity.RegisterOptions{Name: "AcquireBatch"},
	)
	env.RegisterActivityWithOptions(
		func(map[string]interface{}) (map[string]interface{}, error) {
			return map[string]interface{}{"fileListKey": "k", "filesCopied": float64(0)}, nil
		},
		activity.RegisterOptions{Name: "FinalizeAcquisition"},
	)
	env.OnWorkflow(DatasetImportWorkflow, mock.Anything, mock.Anything).
		Return(types.DatasetImportWorkflowResult{Status: "completed"}, nil)
	env.RegisterWorkflow(DataAcquisitionWorkflow)
	env.ExecuteWorkflow(DataAcquisitionWorkflow, DataAcquisitionWorkflowInput{
		ProjectID: "p1", DatasetID: "d1", ConfigServiceURL: "http://cfg",
	})
	require.NoError(t, env.GetWorkflowError())
}

func TestKnowledgeBaseCreationWorkflow_ClearProgressWarningContinues(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerKBCreationStubs(env)
	env.OnActivity("ClearStaleProgressActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(errors.New("clear failed")).Once()
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("no creds")).Once()
	env.OnActivity("UpdateKBStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(KnowledgeBaseCreationWorkflow, kbCreationInput())
	require.Error(t, env.GetWorkflowError())
}

func TestDatasetImportWorkflow_CredentialsFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)
	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{}, errors.New("creds missing"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, datasetImportInput())
	require.Error(t, env.GetWorkflowError())
}

func TestDatasetImportWorkflow_PiiReprocessFailure(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerDatasetImportStubs(env)
	in := datasetImportInput()
	in.ReprocessPiiOnly = true

	env.OnActivity("FetchProjectCredentialsActivity", mock.Anything, mock.Anything).
		Return(types.ProjectCredentials{ConfigServiceURL: "http://cfg"}, nil)
	env.OnActivity("CreateWorkPlanActivity", mock.Anything, mock.Anything).
		Return(types.WorkPlan{FileSets: []types.FileSet{{SetID: "s0"}}}, nil)
	env.OnActivity("ReprocessPiiFiles", mock.Anything, mock.Anything).
		Return(nil, errors.New("pii failed"))
	env.OnActivity("UpdateDatasetStatusActivity", mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil).Maybe()
	env.OnActivity("PostWorkflowProgressActivity", mock.Anything, mock.Anything).
		Return(nil).Maybe()

	env.ExecuteWorkflow(DatasetImportWorkflow, in)
	require.Error(t, env.GetWorkflowError())
}
