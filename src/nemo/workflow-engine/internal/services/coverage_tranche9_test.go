package services

import (
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/mocks"
)

func TestExecutor_StartProjectDelete_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()
	_, err := ex.StartProjectDelete("p1", types.ProjectDeleteWorkflowInput{BucketName: "b1"})
	require.Error(t, err)
}

func TestExecutor_StartProjectChangeRole_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()
	_, err := ex.StartProjectChangeRole("p1", types.ProjectMembershipInput{
		ProjectId: "p1", UserId: "u1", Role: "admin",
	})
	require.Error(t, err)
}

func TestExecutor_StartTableProcessing_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()
	_, err := ex.StartTableProcessing("p1", "d1", types.TableProcessingWorkflowInput{})
	require.Error(t, err)
}

func TestExecutor_StartKnowledgeBaseCreation_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("temporal down")).Once()
	_, err := ex.StartKnowledgeBaseCreation("p1", "kb1", types.KnowledgeBaseCreationWorkflowInput{})
	require.Error(t, err)
}

func TestExecutor_EnsureProjectVKRotationSchedule_PropagatesOtherError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, errors.New("schedule down")).Once()
	_, err := ex.EnsureProjectVKRotationSchedule(0, 0)
	require.Error(t, err)
}
