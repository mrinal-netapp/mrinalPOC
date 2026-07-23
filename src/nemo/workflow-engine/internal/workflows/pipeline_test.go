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

func registerPipelinePersistStubs(env *testsuite.TestWorkflowEnvironment) {
	registerStubsArgs(env, 1, "PersistExecutionStatus", "PersistStepResult", "SendHILNotification")
}

func mockPipelinePersistActivities(env *testsuite.TestWorkflowEnvironment) {
	env.OnActivity("PersistExecutionStatus", mock.Anything, mock.Anything).Return(nil, nil).Maybe()
	env.OnActivity("PersistStepResult", mock.Anything, mock.Anything).Return(nil, nil).Maybe()
	env.OnActivity("SendHILNotification", mock.Anything, mock.Anything).Return(nil, nil).Maybe()
}

func pipelineInput(nodes []types.PipelineNode, edges []types.PipelineEdge) types.PipelineWorkflowInput {
	return types.PipelineWorkflowInput{
		PipelineId:  "pipe-1",
		ProjectId:   "p1",
		ExecutionId: "exec-1",
		Pipeline: &types.Pipeline{
			ID: "pipe-1", ProjectId: "p1",
			Graph: types.PipelineGraph{Nodes: nodes, Edges: edges},
		},
	}
}

// --- pure helpers -----------------------------------------------------------

func TestInterpolateVariables_SubstitutesNestedFields(t *testing.T) {
	outputs := map[string]map[string]interface{}{
		"n1": {"message": "hello", "count": 3, "nested": map[string]interface{}{"x": "deep"}},
	}
	got := interpolateVariables("msg={{n1.message}} cnt={{n1.count}} deep={{n1.nested.x}} missing={{nope.field}}", outputs)
	assert.Equal(t, "msg=hello cnt=3 deep=deep missing={{nope.field}}", got)
}

func TestResolveFieldPath(t *testing.T) {
	data := map[string]interface{}{"a": map[string]interface{}{"b": "val"}}
	assert.Equal(t, "val", resolveFieldPath(data, "a.b"))
	assert.Nil(t, resolveFieldPath(data, "a.missing"))
	assert.Nil(t, resolveFieldPath(data, "a.b.c"))
}

func TestBuildPreviousOutputs(t *testing.T) {
	edges := []types.PipelineEdge{{From: "a", To: "b"}, {From: "c", To: "b"}}
	outputs := map[string]map[string]interface{}{
		"a": {"k": 1},
		"c": {"k": 2},
	}
	got := buildPreviousOutputs("b", edges, outputs)
	assert.Len(t, got, 2)
	assert.Equal(t, 1, got["a"]["k"])
}

func TestDetermineTargetClusterV2(t *testing.T) {
	p := &types.Pipeline{}
	assert.Equal(t, "", determineTargetClusterV2(types.PipelineNode{Type: "agent"}, p))
	assert.Equal(t, "", determineTargetClusterV2(types.PipelineNode{Type: "schedule"}, p))
	assert.Equal(t, "custom-q", determineTargetClusterV2(types.PipelineNode{
		Type: "pod", Config: map[string]interface{}{"taskQueue": "custom-q"},
	}, p))
	assert.Equal(t, "us-east-1", determineTargetClusterV2(types.PipelineNode{Type: "pod"}, p))
}

func TestFilterRecommendationsByIds(t *testing.T) {
	analysis := map[string]interface{}{
		"recommendations": []interface{}{
			map[string]interface{}{"id": "r1", "name": "one"},
			map[string]interface{}{"id": "r2", "name": "two"},
			"not-a-map",
		},
	}
	got := filterRecommendationsByIds(analysis, []string{"r2"})
	require.Len(t, got, 1)
	assert.Equal(t, "r2", got[0].(map[string]interface{})["id"])
	assert.Nil(t, filterRecommendationsByIds(nil, []string{"r1"}))
	assert.Nil(t, filterRecommendationsByIds(map[string]interface{}{}, []string{"r1"}))
}

func TestExecuteResponseBlock_MergesOutputsAndTemplate(t *testing.T) {
	outputs := map[string]map[string]interface{}{
		"a": {"msg": "hi"},
	}
	node := types.PipelineNode{
		ID: "resp", Type: "response",
		Config: map[string]interface{}{
			"template": map[string]interface{}{
				"summary": "{{a.msg}}",
				"static":  42,
			},
		},
	}
	got := executeResponseBlock(node, outputs)
	require.Equal(t, "completed", got.Status)
	assert.Equal(t, "hi", got.Output["summary"])
	assert.Equal(t, 42, got.Output["static"])
	assert.Equal(t, outputs["a"], got.Output["a"])
}

func TestGetInboundSourceNode(t *testing.T) {
	edges := []types.PipelineEdge{{From: "src", To: "dst"}}
	assert.Equal(t, "src", getInboundSourceNode("dst", edges))
	assert.Equal(t, "", getInboundSourceNode("missing", edges))
}

// --- PipelineWorkflow integration ------------------------------------------

func TestPipelineWorkflow_ScheduleAndResponseHappyPath(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)

	in := pipelineInput(
		[]types.PipelineNode{
			{ID: "sched", Type: "schedule"},
			{ID: "resp", Type: "response"},
		},
		[]types.PipelineEdge{{From: "sched", To: "resp"}},
	)
	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	var got types.PipelineExecutionResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	assert.NotEmpty(t, got.FinalOutput)
}

func TestPipelineWorkflow_AgentBlockSuccess(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)
	registerStubs(env, "InvokeAgentActivity")
	env.OnActivity("InvokeAgentActivity", mock.Anything, mock.Anything).
		Return(map[string]interface{}{"answer": "42"}, nil)

	in := pipelineInput(
		[]types.PipelineNode{{ID: "agent1", Type: "agent", Config: map[string]interface{}{
			"agentId": "a1", "message": "go",
		}}},
		nil,
	)
	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.NoError(t, env.GetWorkflowError())
	var got types.PipelineExecutionResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
	require.Len(t, got.Steps, 1)
	assert.Equal(t, "completed", got.Steps[0].Status)
	assert.Equal(t, "42", got.Steps[0].Output["answer"])
}

func TestPipelineWorkflow_AgentBlockFailureStopsPipeline(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)
	registerStubs(env, "InvokeAgentActivity")
	env.OnActivity("InvokeAgentActivity", mock.Anything, mock.Anything).
		Return(nil, errors.New("agent down"))

	in := pipelineInput(
		[]types.PipelineNode{{ID: "agent1", Type: "agent", Config: map[string]interface{}{
			"agentId": "a1", "message": "go",
		}}},
		nil,
	)
	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "agent down")
}

func TestPipelineWorkflow_ExecuteStepActivityDefaultType(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)
	registerStubs(env, "ExecuteStepActivity")
	env.OnActivity("ExecuteStepActivity", mock.Anything, mock.Anything).
		Return(types.StepResult{NodeId: "step1", Status: "completed", Output: map[string]interface{}{"ok": true}}, nil)
	mockPipelinePersistActivities(env)

	in := pipelineInput(
		[]types.PipelineNode{{ID: "step1", Type: "custom-pod", Config: map[string]interface{}{"image": "img"}}},
		nil,
	)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.NoError(t, env.GetWorkflowError())
	var got types.PipelineExecutionResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestPipelineWorkflow_DeadlockWhenCycle(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)

	in := pipelineInput(
		[]types.PipelineNode{
			{ID: "a", Type: "schedule"},
			{ID: "b", Type: "schedule"},
		},
		[]types.PipelineEdge{{From: "a", To: "b"}, {From: "b", To: "a"}},
	)
	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "deadlock")
}

func TestPipelineWorkflow_HILResumeWithSignal(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)

	env.RegisterDelayedCallback(func() {
		env.SignalWorkflow("hil_resume", types.HILResumePayload{ApprovedIds: []string{"r1"}})
	}, time.Millisecond)

	in := pipelineInput(
		[]types.PipelineNode{
			{ID: "analysis", Type: "agent", Config: map[string]interface{}{"agentId": "a", "message": "x"}},
			{ID: "hil", Type: "human_in_the_loop", Config: map[string]interface{}{"timeout": "5s"}},
		},
		[]types.PipelineEdge{{From: "analysis", To: "hil"}},
	)
	// Pre-seed isn't possible; HIL reads outputs from executed nodes. Run agent first via mock.
	registerStubs(env, "InvokeAgentActivity")
	env.OnActivity("InvokeAgentActivity", mock.Anything, mock.Anything).
		Return(map[string]interface{}{
			"recommendations": []interface{}{
				map[string]interface{}{"id": "r1"},
				map[string]interface{}{"id": "r2"},
			},
		}, nil)

	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.NoError(t, env.GetWorkflowError())
	var got types.PipelineExecutionResult
	require.NoError(t, env.GetWorkflowResult(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestPipelineWorkflow_HILTimesOut(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestWorkflowEnvironment()
	registerPipelinePersistStubs(env)

	in := pipelineInput(
		[]types.PipelineNode{
			{ID: "hil", Type: "human_in_the_loop", Config: map[string]interface{}{"timeout": "50ms"}},
		},
		nil,
	)
	mockPipelinePersistActivities(env)
	env.ExecuteWorkflow(PipelineWorkflow, in)
	require.Error(t, env.GetWorkflowError())
	assert.Contains(t, env.GetWorkflowError().Error(), "timed out")
}
