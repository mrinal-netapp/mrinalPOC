package activities

import (
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

func withFakeK8s(t *testing.T, objs ...runtime.Object) kubernetes.Interface {
	t.Helper()
	oldCfg := inClusterConfig
	oldNew := newK8sClientset
	t.Cleanup(func() {
		inClusterConfig = oldCfg
		newK8sClientset = oldNew
	})
	inClusterConfig = func() (*rest.Config, error) { return &rest.Config{}, nil }
	cs := fake.NewSimpleClientset(objs...)
	newK8sClientset = func(*rest.Config) (kubernetes.Interface, error) { return cs, nil }
	return cs
}

func TestCheckPodStatusActivity_Succeeded(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status:     corev1.PodStatus{Phase: corev1.PodSucceeded},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)
	val, err := env.ExecuteActivity(CheckPodStatusActivity, "ns", "pod-1")
	require.NoError(t, err)
	var got types.PodStatusResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Ready)
	assert.True(t, got.IsCompleted)
}

func TestCheckPodStatusActivity_Failed(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status:     corev1.PodStatus{Phase: corev1.PodFailed},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)
	val, err := env.ExecuteActivity(CheckPodStatusActivity, "ns", "pod-1")
	require.NoError(t, err)
	var got types.PodStatusResult
	require.NoError(t, val.Get(&got))
	assert.False(t, got.Ready)
	assert.True(t, got.IsCompleted)
}

func TestCheckPodStatusActivity_RunningReady(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodReady, Status: corev1.ConditionTrue},
			},
		},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)
	val, err := env.ExecuteActivity(CheckPodStatusActivity, "ns", "pod-1")
	require.NoError(t, err)
	var got types.PodStatusResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Ready)
	assert.False(t, got.IsCompleted)
}

func TestCheckPodStatusActivity_PendingNotReady(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status: corev1.PodStatus{
			Phase: corev1.PodPending,
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodReady, Status: corev1.ConditionFalse},
			},
		},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)
	val, err := env.ExecuteActivity(CheckPodStatusActivity, "ns", "pod-1")
	require.NoError(t, err)
	var got types.PodStatusResult
	require.NoError(t, val.Get(&got))
	assert.False(t, got.Ready)
}

func TestCheckServiceStatusActivity_WithEndpoints(t *testing.T) {
	withFakeK8s(t, &corev1.Endpoints{
		ObjectMeta: metav1.ObjectMeta{Name: "svc-1", Namespace: "ns"},
		Subsets: []corev1.EndpointSubset{
			{Addresses: []corev1.EndpointAddress{{IP: "10.0.0.1"}}},
		},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckServiceStatusActivity)
	val, err := env.ExecuteActivity(CheckServiceStatusActivity, "ns", "svc-1")
	require.NoError(t, err)
	var got types.ServiceStatusResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Ready)
	assert.Equal(t, 1, got.EndpointCount)
}

func TestCheckServiceStatusActivity_NoEndpoints(t *testing.T) {
	withFakeK8s(t)
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckServiceStatusActivity)
	val, err := env.ExecuteActivity(CheckServiceStatusActivity, "ns", "missing-svc")
	require.NoError(t, err)
	var got types.ServiceStatusResult
	require.NoError(t, val.Get(&got))
	assert.False(t, got.Ready)
}

func TestWaitForPodReadyActivity_SuccessViaCheck(t *testing.T) {
	withFakeK8s(t, &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pod-1", Namespace: "ns"},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodReady, Status: corev1.ConditionTrue},
			},
		},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForPodReadyActivity)
	_, err := env.ExecuteActivity(WaitForPodReadyActivity, "ns", "pod-1", 2*time.Second)
	require.NoError(t, err)
}

func TestCollectMetricsActivity_Placeholder(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CollectMetricsActivity)
	val, err := env.ExecuteActivity(CollectMetricsActivity, "ns", "pod", "pod-1")
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Contains(t, got["message"], "not implemented")
}

func TestWaitForServiceReadyActivity_SuccessViaCheck(t *testing.T) {
	withFakeK8s(t, &corev1.Endpoints{
		ObjectMeta: metav1.ObjectMeta{Name: "svc-1", Namespace: "ns"},
		Subsets: []corev1.EndpointSubset{
			{Addresses: []corev1.EndpointAddress{{IP: "10.0.0.2"}}},
		},
	})
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForServiceReadyActivity)
	_, err := env.ExecuteActivity(WaitForServiceReadyActivity, "ns", "svc-1", 2*time.Second)
	require.NoError(t, err)
}
