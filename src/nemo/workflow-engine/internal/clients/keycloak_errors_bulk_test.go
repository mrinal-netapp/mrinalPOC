package clients

import (
	"net/http"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCreateResource_ServerError(t *testing.T) {
	resourcePath := "/admin/realms/nemo/clients/client-uuid-123/authz/resource-server/resource"
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == resourcePath {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	_, err := client.CreateResource(types.KeycloakResource{Name: "project:p1"})
	require.Error(t, err)
}

func TestDeleteResource_ServerError(t *testing.T) {
	srv := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/realms/nemo/protocol/openid-connect/token" {
			tokenHandler(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	defer srv.Close()

	client := newTestClient(t, srv.URL)
	require.Error(t, client.DeleteResource("res-1"))
}

func TestExtractBaseFromIssuer_TrailingSlash(t *testing.T) {
	base := extractBaseFromIssuer("https://kc.example.com/realms/nemo/")
	assert.Equal(t, "https://kc.example.com", base)
}
