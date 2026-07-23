package services

import (
	"context"
	"errors"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
)

func TestExecutor_StartProjectAddUser_Success(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "project-add-user-p1-u1-admin" && opts.TaskQueue == "pipeline-execution"
		}),
		"ProjectAddUserWorkflow",
		mock.MatchedBy(func(input types.ProjectMembershipInput) bool {
			return input.ProjectId == "p1" && input.UserId == "u1" && input.Role == "admin"
		}),
	).Return(&fakeWorkflowRun{id: "project-add-user-p1-u1-admin"}, nil).Once()

	id, err := ex.StartProjectAddUser("p1", types.ProjectMembershipInput{UserId: "u1", Role: "admin"})
	require.NoError(t, err)
	assert.Equal(t, "project-add-user-p1-u1-admin", id)
}

func TestExecutor_StartProjectAddUser_TemporalError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectAddUserWorkflow", mock.Anything).
		Return(nil, errors.New("temporal down")).Once()

	_, err := ex.StartProjectAddUser("p1", types.ProjectMembershipInput{UserId: "u1", Role: "admin"})
	require.Error(t, err)
}

func TestExecutor_StartProjectRemoveUser_Success(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "project-remove-user-p1-u1"
		}),
		"ProjectRemoveUserWorkflow",
		mock.MatchedBy(func(input types.ProjectMembershipInput) bool {
			return input.ProjectId == "p1" && input.UserId == "u1"
		}),
	).Return(&fakeWorkflowRun{id: "project-remove-user-p1-u1"}, nil).Once()

	id, err := ex.StartProjectRemoveUser("p1", types.ProjectMembershipInput{UserId: "u1"})
	require.NoError(t, err)
	assert.Equal(t, "project-remove-user-p1-u1", id)
}

func TestExecutor_StartProjectChangeRole_Success(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(opts client.StartWorkflowOptions) bool {
			return opts.ID == "project-change-role-p1-u1" && opts.WorkflowExecutionErrorWhenAlreadyStarted
		}),
		"ProjectChangeRoleWorkflow",
		mock.MatchedBy(func(input types.ProjectMembershipInput) bool {
			return input.ProjectId == "p1" && input.UserId == "u1" && input.Role == "viewer"
		}),
	).Return(&fakeWorkflowRun{id: "project-change-role-p1-u1"}, nil).Once()

	id, err := ex.StartProjectChangeRole("p1", types.ProjectMembershipInput{UserId: "u1", Role: "viewer"})
	require.NoError(t, err)
	assert.Equal(t, "project-change-role-p1-u1", id)
}

func TestExecutor_SignalWorkflowByID_Delegates(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("SignalWorkflow",
		mock.Anything, "wf-1", "run-1", "my-signal", map[string]string{"k": "v"},
	).Return(nil).Once()

	require.NoError(t, ex.SignalWorkflowByID(context.Background(), "wf-1", "run-1", "my-signal", map[string]string{"k": "v"}))
}

func TestExecutor_SignalWorkflowByID_ErrorPropagated(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("SignalWorkflow", mock.Anything, "wf-1", "run-1", "sig", mock.Anything).
		Return(errors.New("signal failed")).Once()

	err := ex.SignalWorkflowByID(context.Background(), "wf-1", "run-1", "sig", nil)
	require.Error(t, err)
}
