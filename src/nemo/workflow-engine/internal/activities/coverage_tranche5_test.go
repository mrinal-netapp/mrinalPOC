package activities

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func TestExecuteStepActivity_NodeTypeBranches(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ExecuteStepActivity)

	base := types.StepExecutionInput{
		NodeId: "n1", PipelineId: "pipe-1",
		Config: map[string]interface{}{},
	}

	for _, nodeType := range []string{"pod", "container", "service", "scale", "crd", "custom-resource", "response", "schedule", "human_in_the_loop"} {
		t.Run(nodeType, func(t *testing.T) {
			in := base
			in.NodeType = nodeType
			val, err := env.ExecuteActivity(ExecuteStepActivity, in)
			require.NoError(t, err)
			var got types.StepResult
			require.NoError(t, val.Get(&got))
			assert.Equal(t, "completed", got.Status)
			assert.Equal(t, "n1", got.NodeId)
		})
	}
}

func TestExecuteStepActivity_AgentBranch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "/invoke/async") {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"response": `{"ok":true}`,
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	agentServiceURL = srv.URL

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ExecuteStepActivity)
	val, err := env.ExecuteActivity(ExecuteStepActivity, types.StepExecutionInput{
		NodeId: "agent-node", NodeType: "agent", PipelineId: "p",
		Config: map[string]interface{}{
			"agentId": "a1", "projectId": "proj", "message": "hi",
		},
	})
	require.NoError(t, err)
	var got types.StepResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestExecuteStepActivity_GenericBranchFailsWithoutK8s(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ExecuteStepActivity)
	_, err := env.ExecuteActivity(ExecuteStepActivity, types.StepExecutionInput{
		NodeId: "gen", NodeType: "transform", PipelineId: "p",
		Config: map[string]interface{}{"image": "busybox"},
	})
	require.Error(t, err)
}

func TestScaleDeploymentActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ScaleDeploymentActivity)
	_, err := env.ExecuteActivity(ScaleDeploymentActivity, "default", "dep", int32(2))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "in-cluster config")
}

func TestScaleStatefulSetActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ScaleStatefulSetActivity)
	_, err := env.ExecuteActivity(ScaleStatefulSetActivity, "default", "sts", int32(1))
	require.Error(t, err)
}

func TestUpdateReplicasActivity_DelegatesToDeployment(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateReplicasActivity)
	_, err := env.ExecuteActivity(UpdateReplicasActivity, "default", "dep", "Deployment", int32(2))
	require.Error(t, err)
	assert.Contains(t, err.Error(), "in-cluster config")
}

func TestCreateCrdActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateCrdActivity)
	obj := &unstructured.Unstructured{}
	obj.SetName("demo")
	obj.SetKind("Demo")
	gvr := schema.GroupVersionResource{Group: "demo.io", Version: "v1", Resource: "demos"}
	_, err := env.ExecuteActivity(CreateCrdActivity, gvr, "default", obj)
	require.Error(t, err)
}

func TestUpdateCrdActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(UpdateCrdActivity)
	obj := &unstructured.Unstructured{}
	obj.SetName("demo")
	obj.SetKind("Demo")
	gvr := schema.GroupVersionResource{Group: "demo.io", Version: "v1", Resource: "demos"}
	_, err := env.ExecuteActivity(UpdateCrdActivity, gvr, "default", obj)
	require.Error(t, err)
}

func TestDeleteCrdActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteCrdActivity)
	gvr := schema.GroupVersionResource{Group: "demo.io", Version: "v1", Resource: "demos"}
	_, err := env.ExecuteActivity(DeleteCrdActivity, gvr, "default", "demo")
	require.Error(t, err)
}

func TestGetCrdStatusActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetCrdStatusActivity)
	gvr := schema.GroupVersionResource{Group: "demo.io", Version: "v1", Resource: "demos"}
	_, err := env.ExecuteActivity(GetCrdStatusActivity, gvr, "default", "demo")
	require.Error(t, err)
}

func TestCheckPodStatusActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckPodStatusActivity)
	_, err := env.ExecuteActivity(CheckPodStatusActivity, "default", "pod-1")
	require.Error(t, err)
}

func TestCheckServiceStatusActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckServiceStatusActivity)
	_, err := env.ExecuteActivity(CheckServiceStatusActivity, "default", "svc-1")
	require.Error(t, err)
}

func TestCollectLogsActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CollectLogsActivity)
	_, err := env.ExecuteActivity(CollectLogsActivity, "default", "pod-1", "container")
	require.Error(t, err)
}

func TestCreatePodActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreatePodActivity)
	_, err := env.ExecuteActivity(CreatePodActivity, types.PodCreationInput{
		Name: "p1", Image: "busybox", Namespace: "default",
	})
	require.Error(t, err)
}

func startKBDeleteS3Server(t *testing.T, keys []string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("list-type") == "2" {
			var contents strings.Builder
			for _, k := range keys {
				fmt.Fprintf(&contents, "<Contents><Key>%s</Key></Contents>", k)
			}
			body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>bucket</Name><Prefix>%s</Prefix>%s<IsTruncated>false</IsTruncated></ListBucketResult>`,
				query.Get("prefix"), contents.String())
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, body)
			return
		}
		if r.Method == http.MethodPost && query.Get("delete") != "" {
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, `<?xml version="1.0"?><DeleteResult></DeleteResult>`)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")
	return srv
}

func TestDeleteKBFilesActivity_DeletesObjects(t *testing.T) {
	startKBDeleteS3Server(t, []string{
		"knowledgebases/kb1/lancedb/data.parquet",
		"knowledgebases/kb1/metadata.json",
	})

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteKBFilesActivity)
	val, err := env.ExecuteActivity(DeleteKBFilesActivity, types.DeleteKBFilesRequest{
		ProjectId: "p1", KnowledgeBaseId: "kb1", BucketName: "bucket",
	})
	require.NoError(t, err)
	var got types.DeleteKBFilesResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Success)
	assert.Equal(t, 2, got.FilesDeleted)
}

func TestDeleteKBFilesActivity_EmptyPrefixSucceeds(t *testing.T) {
	startKBDeleteS3Server(t, nil)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteKBFilesActivity)
	val, err := env.ExecuteActivity(DeleteKBFilesActivity, types.DeleteKBFilesRequest{
		ProjectId: "p1", KnowledgeBaseId: "kb-empty",
	})
	require.NoError(t, err)
	var got types.DeleteKBFilesResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Success)
	assert.Equal(t, 0, got.FilesDeleted)
}

func startBucketS3Server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			w.WriteHeader(http.StatusOK)
		case http.MethodHead:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")
	return srv
}

func TestCheckBucketStatusActivity_Ready(t *testing.T) {
	startBucketS3Server(t)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CheckBucketStatusActivity)
	val, err := env.ExecuteActivity(CheckBucketStatusActivity, "my-bucket")
	require.NoError(t, err)
	var got types.BucketStatusResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Ready)
	assert.True(t, got.Exists)
}

func TestWaitForBucketReadyActivity_Success(t *testing.T) {
	startBucketS3Server(t)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(WaitForBucketReadyActivity)
	_, err := env.ExecuteActivity(WaitForBucketReadyActivity, "p1", "new-bucket", 5)
	require.NoError(t, err)
}
