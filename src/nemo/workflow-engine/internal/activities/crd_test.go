package activities

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
)

func withFakeDynamic(t *testing.T, objs ...runtime.Object) {
	t.Helper()
	oldCfg := inClusterConfig
	oldDyn := newDynamicClient
	t.Cleanup(func() {
		inClusterConfig = oldCfg
		newDynamicClient = oldDyn
	})
	inClusterConfig = func() (*rest.Config, error) { return &rest.Config{}, nil }
	newDynamicClient = func(*rest.Config) (dynamic.Interface, error) {
		return fake.NewSimpleDynamicClient(runtime.NewScheme(), objs...), nil
	}
}

func TestCreateCrdActivity_Success(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "test.io", Version: "v1", Resource: "widgets"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "test.io/v1", "kind": "Widget", "metadata": map[string]interface{}{"name": "w1"},
	}}
	withFakeDynamic(t)
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateCrdActivity)
	_, err := env.ExecuteActivity(CreateCrdActivity, gvr, "ns", obj)
	require.NoError(t, err)
}

func TestGetCrdStatusActivity_Success(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "test.io", Version: "v1", Resource: "widgets"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "test.io/v1", "kind": "Widget",
		"metadata": map[string]interface{}{"name": "w1", "namespace": "ns"},
		"status":   map[string]interface{}{"phase": "Ready"},
	}}
	obj.SetGroupVersionKind(schema.GroupVersionKind{Group: "test.io", Version: "v1", Kind: "Widget"})
	withFakeDynamic(t, obj)
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetCrdStatusActivity)
	val, err := env.ExecuteActivity(GetCrdStatusActivity, gvr, "ns", "w1")
	require.NoError(t, err)
	var got map[string]interface{}
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "w1", got["metadata"].(map[string]interface{})["name"])
}

func TestDeleteCrdActivity_Success(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "test.io", Version: "v1", Resource: "widgets"}
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "test.io/v1", "kind": "Widget",
		"metadata": map[string]interface{}{"name": "w1", "namespace": "ns"},
	}}
	obj.SetGroupVersionKind(schema.GroupVersionKind{Group: "test.io", Version: "v1", Kind: "Widget"})
	withFakeDynamic(t, obj)
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteCrdActivity)
	_, err := env.ExecuteActivity(DeleteCrdActivity, gvr, "ns", "w1")
	require.NoError(t, err)
}
