package clients

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLakekeeperClient_ListNamespaces_Success(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"namespaces": []interface{}{[]string{"ns"}},
		})
	})
	got, err := s.client().ListNamespaces("wh-1")
	require.NoError(t, err)
	assert.NotEmpty(t, got)
}

func TestLakekeeperClient_CreateTable_ConflictUpdates(t *testing.T) {
	s := newLkStub(t)
	calls := 0
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusCreated)
	})
	s.on(http.MethodPut, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().CreateTable("wh-1", "ns", CreateTableRequest{
		Name: "t", Location: "s3://b/p", Schema: map[string]interface{}{},
		DatasetId: "d", DatasetKind: "object",
	}))
}

func TestLakekeeperClient_NewLakekeeperClientWithHTTPClient_NilUsesDefault(t *testing.T) {
	c := NewLakekeeperClientWithHTTPClient("http://x", nil)
	require.NotNil(t, c)
}
