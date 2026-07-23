package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

func TestBuildLineageGraphActivity_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/internal/reference-edges/graph-data":
			_ = json.NewEncoder(w).Encode(types.GraphDataResponse{
				Projects: map[string]types.ProjectGraphData{
					"p1": {
						Edges: []types.GraphDataEdge{{
							SourceType: "dataset", SourceID: "a",
							TargetType: "dataset", TargetID: "b",
						}},
						Entities: []types.GraphDataEntity{
							{Kind: "dataset", ID: "a"},
							{Kind: "dataset", ID: "b"},
						},
					},
				},
			})
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/internal/reference-edges/lineage-facet/p1":
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("CONFIG_SERVICE_URL", srv.URL)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(BuildLineageGraphActivity)
	val, err := env.ExecuteActivity(BuildLineageGraphActivity, types.ReferenceEdgeReconcileInput{
		ConfigServiceURL: srv.URL, ProjectID: "p1",
	})
	require.NoError(t, err)
	var got types.BuildLineageGraphResult
	require.NoError(t, val.Get(&got))
	assert.Equal(t, 1, got.ProjectsProcessed)
}

func TestBuildLineageGraphActivity_GraphDataError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	ts := &testsuite.WorkflowTestSuite{}
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(BuildLineageGraphActivity)
	_, err := env.ExecuteActivity(BuildLineageGraphActivity, types.ReferenceEdgeReconcileInput{
		ConfigServiceURL: srv.URL,
	})
	require.Error(t, err)
}
