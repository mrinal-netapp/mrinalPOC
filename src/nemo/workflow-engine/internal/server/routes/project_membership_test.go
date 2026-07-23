package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
)

// --- Fake Keycloak server for requireProjectAdmin + conflict check ----------

type fakeKCServerOpts struct {
	adminPolicyExists bool
	memberPolicies    []map[string]string // policies returned by ListPolicies (search=true)
}

func fakeKeycloakServer(t *testing.T, policyExists bool) *httptest.Server {
	t.Helper()
	return fakeKeycloakServerWithOpts(t, fakeKCServerOpts{
		adminPolicyExists: policyExists,
		memberPolicies:    nil,
	})
}

func fakeKeycloakServerWithOpts(t *testing.T, opts fakeKCServerOpts) *httptest.Server {
	t.Helper()
	policyPath := "/admin/realms/nemo/clients/client-uuid-test/authz/resource-server/policy"
	permPath := "/admin/realms/nemo/clients/client-uuid-test/authz/resource-server/permission/scope"
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/realms/nemo/protocol/openid-connect/token":
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "test-token",
				"expires_in":   3600,
				"token_type":   "Bearer",
			})

		case r.Method == "GET" && r.URL.Path == policyPath:
			w.Header().Set("Content-Type", "application/json")
			// ListPolicies (search=true) vs GetPolicyByName (no search param)
			if r.URL.Query().Get("search") == "true" {
				if opts.memberPolicies != nil {
					json.NewEncoder(w).Encode(opts.memberPolicies)
				} else {
					json.NewEncoder(w).Encode([]map[string]string{})
				}
				return
			}
			// GetPolicyByName: exact lookup. The caller's admin policy exists
			// only when opts.adminPolicyExists is set; per-target conflict
			// policies (usr-<target>-proj-...-<role>) are looked up against
			// opts.memberPolicies so the conflict-check tests still work.
			name := r.URL.Query().Get("name")
			if opts.adminPolicyExists && name == "usr-00000000-0000-0000-0000-000000000001-proj-p1-admin" {
				json.NewEncoder(w).Encode([]map[string]string{{"id": "pol-admin", "name": name}})
				return
			}
			for _, p := range opts.memberPolicies {
				if p["name"] == name {
					json.NewEncoder(w).Encode([]map[string]string{p})
					return
				}
			}
			w.WriteHeader(http.StatusNotFound)

		case r.Method == "GET" && r.URL.Path == permPath:
			w.Header().Set("Content-Type", "application/json")
			name := r.URL.Query().Get("name")
			// The admin permission for project p1 exists only when the caller
			// is supposed to be an admin (mirrors adminPolicyExists).
			if opts.adminPolicyExists && name == "perm-proj-p1-admin" {
				json.NewEncoder(w).Encode([]map[string]string{{"id": "perm-1", "name": name}})
				return
			}
			w.WriteHeader(http.StatusNotFound)

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

// overrideKcClient replaces the package-level Keycloak client factory with one
// that points at the given fake server. It returns a cleanup function that
// restores the original factory and clears the cached singleton.
func overrideKcClient(t *testing.T, srv *httptest.Server) {
	t.Helper()
	origFactory := routeKcClientFactory
	routeKcClientMu.Lock()
	routeKcClient = nil
	routeKcClientMu.Unlock()

	routeKcClientFactory = func() (*clients.KeycloakAuthzClient, error) {
		return clients.NewKeycloakAuthzClient(
			srv.URL+"/realms/nemo",
			"test-client",
			"test-secret",
			"client-uuid-test",
		)
	}

	t.Cleanup(func() {
		routeKcClientFactory = origFactory
		routeKcClientMu.Lock()
		routeKcClient = nil
		routeKcClientMu.Unlock()
	})
}

// --- email -> userId resolution (config-service) ----------------------------

// testMemberEmail resolves to the existing member userId "u1" via the default
// stub resolver, so workflow-id expectations (project-*-p1-u1) are unchanged.
const testMemberEmail = "u1@example.com"

// overrideResolver swaps the package-level email->userId resolver and restores
// it on cleanup, so handlers can be exercised without a live config-service.
func overrideResolver(t *testing.T, fn func(email string, create bool) (string, bool, error)) {
	t.Helper()
	orig := resolveMemberEmail
	resolveMemberEmail = fn
	t.Cleanup(func() { resolveMemberEmail = orig })
}

// defaultResolver maps testMemberEmail -> "u1" (an existing user). Any other
// email is unknown: resolve-only (create=false) yields "" (handler -> 404),
// resolve-or-create (create=true) yields a freshly created id.
func defaultResolver(email string, create bool) (string, bool, error) {
	if email == testMemberEmail {
		return "u1", false, nil
	}
	if create {
		return "u-new", true, nil
	}
	return "", false, nil
}

// newMembershipRouter creates a Gin router with SetupProjectMembershipRoutes
// wired to a mocked Temporal client and pre-injected user claims. It installs
// the default email resolver; tests needing other behaviour call overrideResolver.
func newMembershipRouter(t *testing.T, claims *middleware.UserClaims) (*gin.Engine, *mocks.Client) {
	t.Helper()
	mt := &mocks.Client{}
	stub := newConfigStub(t)
	cc := clients.NewConfigClientWithHTTPClient(stub.server.URL, http.DefaultClient)
	hs := services.NewHistoryServiceWithClient(cc)
	executor := services.NewExecutorServiceWithDeps(mt, cc, hs)

	overrideResolver(t, defaultResolver)

	r := gin.New()
	if claims != nil {
		r.Use(func(c *gin.Context) {
			c.Set("userClaims", claims)
			c.Next()
		})
	}
	api := r.Group("/api/v1")
	SetupProjectMembershipRoutes(api, executor)
	t.Cleanup(func() { mt.AssertExpectations(t) })
	return r, mt
}

// --- POST /projects/:projectId/members (addProjectMember) -------------------

func TestAddMember_Returns401WhenNoClaims(t *testing.T) {
	r, _ := newMembershipRouter(t, nil)
	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "authentication required")
}

func TestAddMember_Returns403WhenNotAdmin(t *testing.T) {
	srv := fakeKeycloakServer(t, false)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "admin scope required")
}

func TestAddMember_Returns400ForInvalidRole(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail, "role": "superadmin"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "role must be one of")
}

func TestAddMember_Returns400ForMissingBody(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAddMember_Returns400ForMissingEmail(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"role": "member"} // no email
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAddMember_Returns400ForMalformedEmail(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	// A malformed (non-empty) email is a 400 at the handler, before the
	// config-service resolve call — so a client typo is not surfaced as a 502.
	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": "not-an-email", "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid email address")
}

func TestAddMember_Returns502OnResolveFailure(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	overrideResolver(t, func(string, bool) (string, bool, error) {
		return "", false, errors.New("config-service unreachable")
	})

	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadGateway, w.Code)
	assert.Contains(t, w.Body.String(), "failed to resolve member")
}

func TestAddMember_Returns202OnSuccess(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "project-add-user-p1-u1-member"
		}),
		"ProjectAddUserWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-add-1", runID: "r1"}, nil).Once()

	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code)
	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "wf-add-1", resp["workflowId"])
	assert.Equal(t, "running", resp["status"])
	assert.Equal(t, testMemberEmail, resp["email"])
	assert.Equal(t, "member", resp["role"])
	assert.Equal(t, false, resp["created"])
	// The resolved userId must NOT be echoed back to the caller.
	assert.NotContains(t, w.Body.String(), "\"userId\"")
}

func TestAddMember_Returns202WithCreatedTrueForNewInvitee(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	overrideResolver(t, func(email string, create bool) (string, bool, error) {
		if create {
			return "u2", true, nil // freshly created invitee
		}
		return "", false, nil
	})
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "project-add-user-p1-u2-member"
		}),
		"ProjectAddUserWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-add-2", runID: "r1"}, nil).Once()

	body := map[string]string{"email": "new@example.com", "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code)
	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "new@example.com", resp["email"])
	assert.Equal(t, true, resp["created"])
}

func TestAddMember_Returns500OnTemporalError(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectAddUserWorkflow", mock.Anything).
		Return(nil, errors.New("temporal down")).Once()

	body := map[string]string{"email": testMemberEmail, "role": "admin"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- DELETE /projects/:projectId/members (removeProjectMember) --------------

func TestRemoveMember_Returns401WhenNoClaims(t *testing.T) {
	r, _ := newMembershipRouter(t, nil)
	body := map[string]string{"email": testMemberEmail}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestRemoveMember_Returns403WhenNotAdmin(t *testing.T) {
	srv := fakeKeycloakServer(t, false)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestRemoveMember_Returns400ForMissingEmail(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, map[string]string{}))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestRemoveMember_Returns404WhenUnknownEmail(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": "ghost@example.com"} // default resolver -> not found
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "no member with that email")
}

func TestRemoveMember_Returns502OnResolveFailure(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	overrideResolver(t, func(string, bool) (string, bool, error) {
		return "", false, errors.New("config-service unreachable")
	})

	body := map[string]string{"email": testMemberEmail}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadGateway, w.Code)
	assert.Contains(t, w.Body.String(), "failed to resolve member")
}

func TestRemoveMember_Returns202OnSuccess(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "project-remove-user-p1-u1"
		}),
		"ProjectRemoveUserWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-rm-1", runID: "r1"}, nil).Once()

	body := map[string]string{"email": testMemberEmail}
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code)
	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "wf-rm-1", resp["workflowId"])
	assert.Equal(t, testMemberEmail, resp["email"])
	assert.NotContains(t, w.Body.String(), "\"userId\"")
}

// --- PUT /projects/:projectId/members/role (changeProjectMemberRole) --------

func TestChangeRole_Returns401WhenNoClaims(t *testing.T) {
	r, _ := newMembershipRouter(t, nil)
	body := map[string]string{"email": testMemberEmail, "role": "viewer"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestChangeRole_Returns403WhenNotAdmin(t *testing.T) {
	srv := fakeKeycloakServer(t, false)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail, "role": "viewer"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
}

func TestChangeRole_Returns400ForInvalidRole(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail, "role": "owner"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "role must be one of")
}

func TestChangeRole_Returns400ForMissingRole(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail} // no role
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestChangeRole_Returns404WhenUnknownEmail(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": "ghost@example.com", "role": "viewer"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "no member with that email")
}

func TestChangeRole_Returns202OnSuccess(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "project-change-role-p1-u1"
		}),
		"ProjectChangeRoleWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-cr-1", runID: "r1"}, nil).Once()

	body := map[string]string{"email": testMemberEmail, "role": "viewer"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code)
	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, "wf-cr-1", resp["workflowId"])
	assert.Equal(t, testMemberEmail, resp["email"])
	assert.Equal(t, "viewer", resp["role"])
	assert.NotContains(t, w.Body.String(), "\"userId\"")
}

func TestChangeRole_Returns409WhenAlreadyStarted(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectChangeRoleWorkflow", mock.Anything).
		Return(nil, serviceerror.NewWorkflowExecutionAlreadyStarted("already running", "", "")).Once()

	body := map[string]string{"email": testMemberEmail, "role": "admin"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusConflict, w.Code)
	assert.Contains(t, w.Body.String(), "already in progress")
}

func TestChangeRole_Returns500OnTemporalError(t *testing.T) {
	srv := fakeKeycloakServer(t, true)
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, "ProjectChangeRoleWorkflow", mock.Anything).
		Return(nil, errors.New("temporal unreachable")).Once()

	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPut, "/api/v1/projects/p1/members/role", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusInternalServerError, w.Code)
}

// --- Conflict pre-check (one role per user per project) ---------------------

func TestAddMember_Returns409WhenUserAlreadyHasDifferentRole(t *testing.T) {
	srv := fakeKeycloakServerWithOpts(t, fakeKCServerOpts{
		adminPolicyExists: true,
		memberPolicies: []map[string]string{
			{"id": "pol-existing", "name": "usr-u1-proj-p1-viewer"},
		},
	})
	defer srv.Close()
	overrideKcClient(t, srv)

	r, _ := newMembershipRouter(t, testUserClaims())
	body := map[string]string{"email": testMemberEmail, "role": "admin"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusConflict, w.Code)
	var resp map[string]interface{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Equal(t, activities.ErrAlreadyAssignedDifferentRole, resp["error"])
	assert.Contains(t, resp["message"], "viewer")
	assert.Contains(t, resp["message"], "change-role endpoint")
}

func TestAddMember_Passes409CheckWhenSameRole(t *testing.T) {
	srv := fakeKeycloakServerWithOpts(t, fakeKCServerOpts{
		adminPolicyExists: true,
		memberPolicies: []map[string]string{
			{"id": "pol-existing", "name": "usr-u1-proj-p1-member"},
		},
	})
	defer srv.Close()
	overrideKcClient(t, srv)

	r, mt := newMembershipRouter(t, testUserClaims())
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return o.ID == "project-add-user-p1-u1-member"
		}),
		"ProjectAddUserWorkflow",
		mock.Anything,
	).Return(&fakeWorkflowRun{id: "wf-idem-1", runID: "r1"}, nil).Once()

	body := map[string]string{"email": testMemberEmail, "role": "member"}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/p1/members", jsonReader(t, body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusAccepted, w.Code, "same role should proceed (idempotent)")
}
