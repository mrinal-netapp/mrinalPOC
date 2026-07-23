package activities

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestCreatePodActivity_Success(t *testing.T) {
	withFakeK8s(t)
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreatePodActivity)
	val, err := env.ExecuteActivity(CreatePodActivity, types.PodCreationInput{
		Name: "pod-1", Namespace: "ns", Image: "img:latest",
		Env:       map[string]string{"K": "V"},
		Resources: types.ResourceRequirements{CPU: "100m", Memory: "128Mi"},
	})
	require.NoError(t, err)
	var got types.PodCreationResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "pod-1", got.PodName)
}

func TestDeletePodActivity_Success(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeletePodActivity)
	_, err := env.ExecuteActivity(DeletePodActivity, "ns", "pod-1")
	require.NoError(t, err)
}

func TestGetPodStatusActivity_Success(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status:     corev1.PodStatus{Phase: corev1.PodRunning},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetPodStatusActivity)
	val, err := env.ExecuteActivity(GetPodStatusActivity, "ns", "pod-1")
	require.NoError(t, err)
	var phase string
	require.NoError(t, val.Get(&phase))
	assert.Equal(t, "Running", phase)
}

func TestCreateServiceActivity_Placeholder(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateServiceActivity)
	val, err := env.ExecuteActivity(CreateServiceActivity, "ns", "svc", map[string]interface{}{})
	require.NoError(t, err)
	var got string
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "created", got)
}
