package clients

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConfigClient_SetupProjectLLMGateway_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-setup", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	require.NoError(t, s.client().SetupProjectLLMGateway("p1"))
}

func TestConfigClient_SetupProjectLLMGateway_ErrorStatus(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-setup", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("gateway boom"))
	})
	require.Error(t, s.client().SetupProjectLLMGateway("p1"))
}

func TestConfigClient_ReportProjectInitStatus_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/init-status", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"status":"ready"`)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().ReportProjectInitStatus("p1", "ready", ""))
}

func TestConfigClient_ReportProjectInitStatus_WithError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/init-status", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"error":"init failed"`)
		w.WriteHeader(http.StatusCreated)
	})
	require.NoError(t, s.client().ReportProjectInitStatus("p1", "failed", "init failed"))
}

func TestConfigClient_ReportProjectInitStatus_ServerError(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/init-status", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
	})
	require.Error(t, s.client().ReportProjectInitStatus("p1", "failed", "x"))
}

func TestConfigClient_TeardownProjectLLMGateway_NoMeta(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-teardown", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Empty(t, body)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().TeardownProjectLLMGateway("p1", nil))
}

func TestConfigClient_TeardownProjectLLMGateway_WithMeta(t *testing.T) {
	s := newStub(t)
	meta := &types.ProjectGatewayMeta{TeamId: "team-1", VirtualKeyId: "vk-1"}
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-teardown", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), `"teamId":"team-1"`)
		w.WriteHeader(http.StatusOK)
	})
	require.NoError(t, s.client().TeardownProjectLLMGateway("p1", meta))
}

func TestConfigClient_TeardownProjectLLMGateway_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-teardown", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	require.Error(t, s.client().TeardownProjectLLMGateway("p1", nil))
}

func TestConfigClient_ResolveOrCreateUsers_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve-or-create", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		assert.Contains(t, string(body), "alice@example.com")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"resolved": []types.ResolvedMember{{Email: "alice@example.com", UserId: "u1"}},
		})
	})
	got, err := s.client().ResolveOrCreateUsers([]string{"alice@example.com"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "u1", got[0].UserId)
}

func TestConfigClient_ResolveOrCreateUsers_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve-or-create", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	_, err := s.client().ResolveOrCreateUsers([]string{"a@b.com"})
	require.Error(t, err)
}

func TestConfigClient_ResolveOrCreateUsers_BadJSON(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve-or-create", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	})
	_, err := s.client().ResolveOrCreateUsers([]string{"a@b.com"})
	require.Error(t, err)
}

func TestConfigClient_ResolveUsers_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"resolved": []types.ResolvedMember{{Email: "bob@example.com", UserId: ""}},
		})
	})
	got, err := s.client().ResolveUsers([]string{"bob@example.com"})
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Empty(t, got[0].UserId)
}

func TestConfigClient_ResolveUsers_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/users/resolve", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	_, err := s.client().ResolveUsers([]string{"missing@example.com"})
	require.Error(t, err)
}

func TestConfigClient_ListProjectsForVKRotation_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/internal/projects/gateway-rotation-targets", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.ListProjectsForVKRotationResult{
			ProjectIds: []string{"p1"},
		})
	})
	got, err := s.client().ListProjectsForVKRotation()
	require.NoError(t, err)
	require.Len(t, got.ProjectIds, 1)
}

func TestConfigClient_ListProjectsForVKRotation_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodGet, "/api/v1/internal/projects/gateway-rotation-targets", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	_, err := s.client().ListProjectsForVKRotation()
	require.Error(t, err)
}

func TestConfigClient_RotateProjectVirtualKey_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.RotateProjectVirtualKeyResult{ProjectId: "p1"})
	})
	got, err := s.client().RotateProjectVirtualKey("p1")
	require.NoError(t, err)
	assert.Equal(t, "p1", got.ProjectId)
}

func TestConfigClient_RotateProjectVirtualKey_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	})
	_, err := s.client().RotateProjectVirtualKey("p1")
	require.Error(t, err)
}

func TestConfigClient_CompleteProjectVirtualKeyRotation_Success(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate-complete", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(types.DeleteRetiredProjectVirtualKeyResult{ProjectId: "p1"})
	})
	got, err := s.client().CompleteProjectVirtualKeyRotation("p1")
	require.NoError(t, err)
	assert.Equal(t, "p1", got.ProjectId)
}

func TestConfigClient_CompleteProjectVirtualKeyRotation_Error(t *testing.T) {
	s := newStub(t)
	s.on(http.MethodPost, "/api/v1/internal/projects/p1/gateway-rotate-complete", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	})
	_, err := s.client().CompleteProjectVirtualKeyRotation("p1")
	require.Error(t, err)
}
