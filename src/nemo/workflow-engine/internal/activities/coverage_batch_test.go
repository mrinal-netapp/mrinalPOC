package activities

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func startKBVersionsS3Server(t *testing.T, metadataJSON string, versionPrefixes []string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		if query.Get("list-type") == "2" {
			var cps strings.Builder
			for _, p := range versionPrefixes {
				fmt.Fprintf(&cps, "<CommonPrefixes><Prefix>%s</Prefix></CommonPrefixes>", p)
			}
			body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>bucket</Name><Prefix>%s</Prefix><Delimiter>/</Delimiter>%s
<Contents><Key>%smetadata.json</Key><LastModified>2026-06-01T12:00:00.000Z</LastModified></Contents>
<IsTruncated>false</IsTruncated></ListBucketResult>`,
				query.Get("prefix"), cps.String(), query.Get("prefix"))
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, body)
			return
		}
		if r.Method == http.MethodGet {
			if strings.HasSuffix(r.URL.Path, "metadata.json") {
				_, _ = w.Write([]byte(metadataJSON))
				return
			}
			_, _ = w.Write([]byte("{}"))
			return
		}
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")
	return srv
}

func TestListKBVersionsActivity_Success(t *testing.T) {
	meta := `{"lanceTablePath":"s3://bucket/knowledgebases/kb1/lancedb-run-abc"}`
	startKBVersionsS3Server(t, meta, []string{
		"knowledgebases/kb1/lancedb-run-abc/",
		"knowledgebases/kb1/lancedb-20260115-103000/",
	})

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ListKBVersionsActivity)
	val, err := env.ExecuteActivity(ListKBVersionsActivity, KBVersionsListInput{
		BucketName: "bucket", KnowledgeBaseId: "kb1",
	})
	require.NoError(t, err)
	var got KBVersionsListResult
	require.NoError(t, val.Get(&got))
	assert.Len(t, got.Versions, 2)
	assert.Equal(t, "lancedb-run-abc", got.ActiveVersionId)
}

func TestListKBVersionsActivity_NoCreds(t *testing.T) {
	t.Setenv("S3_ACCESS_KEY", "")
	t.Setenv("S3_SECRET_KEY", "")
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ListKBVersionsActivity)
	_, err := env.ExecuteActivity(ListKBVersionsActivity, KBVersionsListInput{KnowledgeBaseId: "kb1"})
	require.Error(t, err)
}

func TestRollbackKBVersionActivity_Success(t *testing.T) {
	meta := `{"lanceTablePath":"s3://bucket/knowledgebases/kb1/lancedb-run-old"}`
	startKBVersionsS3Server(t, meta, []string{
		"knowledgebases/kb1/lancedb-run-old/",
		"knowledgebases/kb1/lancedb-run-new/",
	})

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RollbackKBVersionActivity)
	val, err := env.ExecuteActivity(RollbackKBVersionActivity, KBVersionRollbackInput{
		BucketName: "bucket", KnowledgeBaseId: "kb1", TargetVersionId: "lancedb-run-old",
	})
	require.NoError(t, err)
	var got KBVersionRollbackResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "lancedb-run-old", got.RolledBackTo.VersionId)
}

func TestRollbackKBVersionActivity_InvalidTarget(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(RollbackKBVersionActivity)
	_, err := env.ExecuteActivity(RollbackKBVersionActivity, KBVersionRollbackInput{
		TargetVersionId: "not-valid",
	})
	require.Error(t, err)
}

func TestResolveConfigServiceURL(t *testing.T) {
	t.Setenv("CONFIG_SERVICE_URL", "")
	assert.Equal(t, "http://custom", resolveConfigServiceURL("http://custom"))
	t.Setenv("CONFIG_SERVICE_URL", "http://env")
	assert.Equal(t, "http://env", resolveConfigServiceURL(""))
}

func TestResolveProjectVKRotationGrace(t *testing.T) {
	assert.Equal(t, 5*time.Minute, resolveProjectVKRotationGrace(5*time.Minute))
	t.Setenv("PROJECT_VK_ROTATION_GRACE_PERIOD", "10m")
	assert.Equal(t, 10*time.Minute, resolveProjectVKRotationGrace(0))
}

func TestListProjectsForVKRotationActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.ListProjectsForVKRotationResult{ProjectIds: []string{"p1"}})
	})
	env.RegisterActivity(ListProjectsForVKRotationActivity)
	val, err := env.ExecuteActivity(ListProjectsForVKRotationActivity, types.ScheduledProjectVKRotationInput{})
	require.NoError(t, err)
	var got types.ListProjectsForVKRotationResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, []string{"p1"}, got.ProjectIds)
}

func TestRotateProjectVirtualKeyActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/gateway-rotate")
		_ = json.NewEncoder(w).Encode(types.RotateProjectVirtualKeyResult{ProjectId: "p1"})
	})
	env.RegisterActivity(RotateProjectVirtualKeyActivity)
	val, err := env.ExecuteActivity(RotateProjectVirtualKeyActivity, types.ProjectVKRotationInput{ProjectId: "p1"})
	require.NoError(t, err)
	var got types.RotateProjectVirtualKeyResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "p1", got.ProjectId)
}

func TestDeleteRetiredProjectVirtualKeyActivity_Success(t *testing.T) {
	env := configActivityEnv(t, func(w http.ResponseWriter, r *http.Request) {
		require.Contains(t, r.URL.Path, "/gateway-rotate-complete")
		_ = json.NewEncoder(w).Encode(types.DeleteRetiredProjectVirtualKeyResult{ProjectId: "p1", Deleted: true})
	})
	env.RegisterActivity(DeleteRetiredProjectVirtualKeyActivity)
	val, err := env.ExecuteActivity(DeleteRetiredProjectVirtualKeyActivity, types.ProjectVKRotationInput{ProjectId: "p1"})
	require.NoError(t, err)
	var got types.DeleteRetiredProjectVirtualKeyResult
	require.NoError(t, val.Get(&got))
	assert.True(t, got.Deleted)
}

func TestGetScatterGatherConfigActivity_ReturnsEnvDefaults(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(GetScatterGatherConfigActivity)
	val, err := env.ExecuteActivity(GetScatterGatherConfigActivity)
	require.NoError(t, err)
	var got types.ScatterGatherConfig
	require.NoError(t, val.Get(&got))
	assert.Greater(t, got.MaxWorkUnits, 0)
}

func TestExecuteStepActivity_ResponseNoOp(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ExecuteStepActivity)
	val, err := env.ExecuteActivity(ExecuteStepActivity, types.StepExecutionInput{
		NodeId: "n1", NodeType: "response",
	})
	require.NoError(t, err)
	var got types.StepResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestExecuteStepActivity_HILNoOp(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ExecuteStepActivity)
	val, err := env.ExecuteActivity(ExecuteStepActivity, types.StepExecutionInput{
		NodeId: "n1", NodeType: "human_in_the_loop",
	})
	require.NoError(t, err)
	var got types.StepResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, "completed", got.Status)
}

func TestCreateBucketInS3Activity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut {
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(CreateBucketInS3Activity)
	_, err := env.ExecuteActivity(CreateBucketInS3Activity, "bucket-1")
	require.NoError(t, err)
}

func TestDeleteDatasetFilesActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("list-type") == "2" {
			body := `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Contents><Key>datasets/d1/file.parquet</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`
			w.Header().Set("Content-Type", "application/xml")
			_, _ = io.WriteString(w, body)
			return
		}
		if r.Method == http.MethodPost && strings.Contains(r.URL.Path, "delete") {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("S3_ENDPOINT", srv.URL)
	t.Setenv("S3_ACCESS_KEY", "ak")
	t.Setenv("S3_SECRET_KEY", "sk")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteDatasetFilesActivity)
	_, err := env.ExecuteActivity(DeleteDatasetFilesActivity, types.DeleteDatasetFilesRequest{
		ProjectId: "p1", DataSetId: "d1", BucketName: "p1",
	})
	require.NoError(t, err)
}

func TestDeleteProjectCredentialSecretsActivity_OutOfCluster(t *testing.T) {
	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteProjectCredentialSecretsActivity)
	_, err := env.ExecuteActivity(DeleteProjectCredentialSecretsActivity, "p1")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get in-cluster config")
}
