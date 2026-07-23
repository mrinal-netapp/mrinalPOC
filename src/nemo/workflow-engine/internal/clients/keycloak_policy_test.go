package clients

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetPolicyByName_Found(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Query().Get("name") == "usr-u1-proj-p1-admin" {
			_ = json.NewEncoder(w).Encode([]PolicyInfo{
				{ID: "pol-1", Name: "usr-u1-proj-p1-admin"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.GetPolicyByName("usr-u1-proj-p1-admin")
	require.NoError(t, err)
	assert.Equal(t, "pol-1", id)
}

func TestGetPolicyByName_NotFound(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetPolicyByName("missing-policy")
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestDeletePolicy_Success(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	require.NoError(t, client.DeletePolicy("pol-1"))
}

func TestDeletePolicy_404Idempotent(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	require.NoError(t, client.DeletePolicy("gone"))
}

func TestGetPermissionByName_Found(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodGet && r.URL.Query().Get("name") == "perm-proj-p1-admin" {
			_ = json.NewEncoder(w).Encode([]map[string]string{
				{"id": "perm-1", "name": "perm-proj-p1-admin"},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	id, err := client.GetPermissionByName("perm-proj-p1-admin")
	require.NoError(t, err)
	assert.Equal(t, "perm-1", id)
}

func TestGetPermissionByName_NotFound(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetPermissionByName("missing-perm")
	require.Error(t, err)
	assert.ErrorIs(t, err, ErrNotFound)
}

func TestCreateResource_Error(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.CreateResource(types.KeycloakResource{Name: "proj-p1"})
	require.Error(t, err)
}

func TestGetResourceByName_NotFound(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]string{})
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.GetResourceByName("missing")
	require.Error(t, err)
}
