package clients

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type lkStub struct {
	mu     sync.Mutex
	server *httptest.Server
	routes []route
}

func newLkStub(t *testing.T) *lkStub {
	t.Helper()
	s := &lkStub{}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		var match http.HandlerFunc
		var matchLen int
		for _, route := range s.routes {
			if route.method != "" && route.method != r.Method {
				continue
			}
			if strings.HasPrefix(r.URL.Path, route.prefix) && len(route.prefix) > matchLen {
				match = route.handler
				matchLen = len(route.prefix)
			}
		}
		s.mu.Unlock()
		if match != nil {
			match(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *lkStub) on(method, prefix string, h http.HandlerFunc) {
	s.routes = append(s.routes, route{method: method, prefix: prefix, handler: h})
}

func (s *lkStub) client() *LakekeeperClient {
	return NewLakekeeperClientWithHTTPClient(s.server.URL, http.DefaultClient)
}

func TestLakekeeperClient_NewLakekeeperClient_AuthDisabledByDefault(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_CLIENT_ID", "")
	t.Setenv("KEYCLOAK_CLIENT_SECRET", "")
	t.Setenv("LAKEKEEPER_CLIENT_ID", "")
	t.Setenv("LAKEKEEPER_CLIENT_SECRET", "")
	c := NewLakekeeperClient("http://example")
	require.NotNil(t, c)
}

func TestLakekeeperClient_CreateWarehouse_Success(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"warehouse-id": "wh-1"})
	})
	id, err := s.client().CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	assert.Equal(t, "wh-1", id)
}

func TestLakekeeperClient_CreateWarehouse_ConflictTriggersLookup(t *testing.T) {
	s := newLkStub(t)
	// First POST returns 409, then GET (list) returns the warehouse with id.
	s.on(http.MethodPost, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"warehouses": []map[string]interface{}{
				{"warehouse-name": "wh", "warehouse-id": "wh-existing"},
			},
		})
	})
	id, err := s.client().CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	assert.Equal(t, "wh-existing", id)
}

func TestLakekeeperClient_CreateWarehouse_OtherError(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	_, err := s.client().CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.Error(t, err)
}

func TestLakekeeperClient_CreateWarehouse_BadJSON_FallsBackToLookup(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"warehouses": []map[string]interface{}{
				{"warehouse-name": "wh", "warehouse-id": "wh-fallback"},
			},
		})
	})
	id, err := s.client().CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	assert.Equal(t, "wh-fallback", id)
}

func TestLakekeeperClient_CreateWarehouse_EmptyIDInResponse_TriggersLookup(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{}) // empty
	})
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"warehouses": []map[string]interface{}{
				{"warehouse-name": "wh", "warehouse-id": "via-lookup"},
			},
		})
	})
	id, err := s.client().CreateWarehouse(types.RegisterWarehouseRequest{WarehouseName: "wh"})
	require.NoError(t, err)
	assert.Equal(t, "via-lookup", id)
}

func TestLakekeeperClient_GetWarehouseByName_NotFound(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"warehouses": []map[string]interface{}{}})
	})
	_, err := s.client().GetWarehouseByName("missing")
	require.Error(t, err)
}

func TestLakekeeperClient_GetWarehouseByName_AlternateFieldNames(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		// Test that alternate field names are recognised.
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"warehouses": []map[string]interface{}{
				{"name": "alt-wh", "id": "alt-id"},
			},
		})
	})
	id, err := s.client().GetWarehouseByName("alt-wh")
	require.NoError(t, err)
	assert.Equal(t, "alt-id", id)
}

func TestLakekeeperClient_GetWarehouseByName_ServerError(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	_, err := s.client().GetWarehouseByName("wh")
	require.Error(t, err)
}

func TestLakekeeperClient_GetWarehouseByName_BadJSON(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().GetWarehouseByName("wh")
	require.Error(t, err)
}

func TestLakekeeperClient_DeleteWarehouse(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodDelete, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	require.NoError(t, s.client().DeleteWarehouse("wh-1"))
}

func TestLakekeeperClient_DeleteWarehouse_NotFoundIsIdempotent(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodDelete, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	require.NoError(t, s.client().DeleteWarehouse("wh-1"))
}

func TestLakekeeperClient_DeleteWarehouse_OtherError(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodDelete, "/management/v1/warehouse", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().DeleteWarehouse("wh-1"))
}

func TestLakekeeperClient_CreateNamespace_Success(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	require.NoError(t, s.client().CreateNamespace(types.CreateNamespaceRequest{
		WarehouseId: "wh", Namespace: []string{"a", "b"},
	}))
}

func TestLakekeeperClient_CreateNamespace_409Idempotent(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	require.NoError(t, s.client().CreateNamespace(types.CreateNamespaceRequest{WarehouseId: "wh", Namespace: []string{"x"}}))
}

func TestLakekeeperClient_CreateNamespace_OtherError(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().CreateNamespace(types.CreateNamespaceRequest{WarehouseId: "wh", Namespace: []string{"x"}}))
}

func TestLakekeeperClient_GetTable_Success(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1/wh/namespaces/ns/tables/t", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"name": "t"})
	})
	got, err := s.client().GetTable("wh", "ns", "t")
	require.NoError(t, err)
	assert.Equal(t, "t", got["name"])
}

func TestLakekeeperClient_GetTable_NotOK(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusInternalServerError) })
	_, err := s.client().GetTable("wh", "ns", "t")
	require.Error(t, err)
}

func TestLakekeeperClient_ListTables_HappyAndEmptyAnd404(t *testing.T) {
	s := newLkStub(t)
	mode := 0
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case 0:
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"identifiers": []map[string]interface{}{
					{"namespace": []string{"ns"}, "name": "t1"},
					{"namespace": []string{"ns"}, "name": "t2"},
				},
			})
		case 1:
			w.WriteHeader(http.StatusNotFound)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})

	got, err := s.client().ListTables("wh", "ns")
	require.NoError(t, err)
	assert.Equal(t, []string{"t1", "t2"}, got)

	mode = 1
	got, err = s.client().ListTables("wh", "ns")
	require.NoError(t, err)
	assert.Empty(t, got, "404 must return empty slice (idempotent)")

	mode = 2
	_, err = s.client().ListTables("wh", "ns")
	require.Error(t, err)
}

func TestLakekeeperClient_DeleteTable_AllStatuses(t *testing.T) {
	s := newLkStub(t)
	mode := 0
	s.on(http.MethodDelete, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case 0:
			w.WriteHeader(http.StatusNoContent)
		case 1:
			w.WriteHeader(http.StatusNotFound)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	require.NoError(t, s.client().DeleteTable("wh", "ns", "t"))
	mode = 1
	require.NoError(t, s.client().DeleteTable("wh", "ns", "t"))
	mode = 2
	require.Error(t, s.client().DeleteTable("wh", "ns", "t"))
}

func TestLakekeeperClient_DeleteNamespace_AllStatuses(t *testing.T) {
	s := newLkStub(t)
	mode := 0
	s.on(http.MethodDelete, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case 0:
			w.WriteHeader(http.StatusNoContent)
		case 1:
			w.WriteHeader(http.StatusNotFound)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	require.NoError(t, s.client().DeleteNamespace("wh", "ns"))
	mode = 1
	require.NoError(t, s.client().DeleteNamespace("wh", "ns"))
	mode = 2
	require.Error(t, s.client().DeleteNamespace("wh", "ns"))
}

func TestLakekeeperClient_ListNamespaces_AllStatuses(t *testing.T) {
	s := newLkStub(t)
	mode := 0
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case 0:
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"namespaces": [][]string{{"a"}, {"b", "c"}, {}},
			})
		case 1:
			w.WriteHeader(http.StatusNotFound)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		case 3:
			_, _ = w.Write([]byte("not-json"))
		}
	})

	got, err := s.client().ListNamespaces("wh")
	require.NoError(t, err)
	assert.Equal(t, []string{"a", "b.c"}, got)

	mode = 1
	got, err = s.client().ListNamespaces("wh")
	require.NoError(t, err)
	assert.Empty(t, got)

	mode = 2
	_, err = s.client().ListNamespaces("wh")
	require.Error(t, err)

	mode = 3
	_, err = s.client().ListNamespaces("wh")
	require.Error(t, err)
}

func TestLakekeeperClient_EnsureNamespace_ExistingSkips(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"namespaces": [][]string{{"existing"}}})
	})
	require.NoError(t, s.client().EnsureNamespace("wh", "existing"))
}

func TestLakekeeperClient_EnsureNamespace_CreatesWhenMissing(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"namespaces": [][]string{}})
	})
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	require.NoError(t, s.client().EnsureNamespace("wh", "a.b.c"))
}

func TestLakekeeperClient_EnsureNamespace_ListErrorContinues(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	})
	require.NoError(t, s.client().EnsureNamespace("wh", "x"))
}

func TestLakekeeperClient_EnsureNamespace_409(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"namespaces": [][]string{}})
	})
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	require.NoError(t, s.client().EnsureNamespace("wh", "ns"))
}

func TestLakekeeperClient_EnsureNamespace_CreateError(t *testing.T) {
	s := newLkStub(t)
	s.on(http.MethodGet, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"namespaces": [][]string{}})
	})
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().EnsureNamespace("wh", "ns"))
}

func TestLakekeeperClient_CreateTable_VariousStatuses(t *testing.T) {
	s := newLkStub(t)
	mode := 0
	s.on(http.MethodPost, "/catalog/v1", func(w http.ResponseWriter, _ *http.Request) {
		switch mode {
		case 0:
			w.WriteHeader(http.StatusCreated)
		case 1:
			w.WriteHeader(http.StatusConflict)
		case 2:
			w.WriteHeader(http.StatusInternalServerError)
		}
	})
	req := CreateTableRequest{
		Name: "t", Location: "s3://b/p", Schema: map[string]interface{}{},
		DatasetId: "d", DatasetKind: "object", StageCreate: true,
	}
	require.NoError(t, s.client().CreateTable("wh", "ns", req))
	mode = 1
	require.NoError(t, s.client().CreateTable("wh", "ns", req))
	mode = 2
	require.Error(t, s.client().CreateTable("wh", "ns", req))
}
