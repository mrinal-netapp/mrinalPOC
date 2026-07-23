package activities

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"
)

// fakeMembershipStateServer models Keycloak authz state across grant + revoke
// steps (add member, then promote to admin). GET /permission/scope/{id} omits
// policies, matching real Keycloak behaviour.
type fakeMembershipStateServer struct {
	t        *testing.T
	project  string
	policies map[string]string // policy name -> policy id
	perms    map[string]struct {
		id       string
		policies []string
	}
}

func newFakeMembershipStateServer(t *testing.T, project string) *fakeMembershipStateServer {
	ownerPolicy := "usr-owner-proj-" + project + "-admin"
	return &fakeMembershipStateServer{
		t:       t,
		project: project,
		policies: map[string]string{
			ownerPolicy: "pol-" + ownerPolicy,
		},
		perms: map[string]struct {
			id       string
			policies []string
		}{
			"perm-proj-" + project + "-admin":  {id: "perm-admin", policies: []string{ownerPolicy}},
			"perm-proj-" + project + "-member": {id: "perm-member", policies: nil},
		},
	}
}

func (f *fakeMembershipStateServer) seedPolicy(name string) {
	if _, ok := f.policies[name]; !ok {
		f.policies[name] = "pol-" + name
	}
}

func (f *fakeMembershipStateServer) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/protocol/openid-connect/token"):
			json.NewEncoder(w).Encode(map[string]interface{}{
				"access_token": "mock-token",
				"expires_in":   3600,
			})

		case strings.Contains(r.URL.Path, "/authz/resource-server/policy") &&
			r.Method == "GET" &&
			r.URL.Query().Get("search") == "true":
			prefix := r.URL.Query().Get("name")
			var out []clients.PolicyInfo
			for name, id := range f.policies {
				if strings.Contains(name, prefix) {
					out = append(out, clients.PolicyInfo{ID: id, Name: name})
				}
			}
			json.NewEncoder(w).Encode(out)

		case strings.Contains(r.URL.Path, "/policy/perm-admin/associatedPolicies") && r.Method == "GET":
			f.writeAssoc(w, "perm-proj-"+f.project+"-admin")
		case strings.Contains(r.URL.Path, "/policy/perm-member/associatedPolicies") && r.Method == "GET":
			f.writeAssoc(w, "perm-proj-"+f.project+"-member")

		case strings.Contains(r.URL.Path, "/authz/resource-server/policy") && r.Method == "GET":
			name := r.URL.Query().Get("name")
			if id, ok := f.policies[name]; ok {
				json.NewEncoder(w).Encode([]clients.PolicyInfo{{ID: id, Name: name}})
				return
			}
			w.WriteHeader(http.StatusNotFound)

		case strings.Contains(r.URL.Path, "/policy/user") && r.Method == "POST":
			var body struct {
				Name string `json:"name"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			f.policies[body.Name] = "pol-" + body.Name
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": f.policies[body.Name]})

		case strings.Contains(r.URL.Path, "/permission/scope") && r.Method == "GET" && r.URL.Query().Get("name") != "":
			name := r.URL.Query().Get("name")
			if perm, ok := f.perms[name]; ok {
				json.NewEncoder(w).Encode([]map[string]string{{"id": perm.id, "name": name}})
				return
			}
			w.WriteHeader(http.StatusNotFound)

		case strings.Contains(r.URL.Path, "/permission/scope/perm-admin") && r.Method == "GET":
			json.NewEncoder(w).Encode(types.KeycloakScopePermission{ID: "perm-admin", Name: "perm-proj-" + f.project + "-admin"})
		case strings.Contains(r.URL.Path, "/permission/scope/perm-member") && r.Method == "GET":
			json.NewEncoder(w).Encode(types.KeycloakScopePermission{ID: "perm-member", Name: "perm-proj-" + f.project + "-member"})

		case strings.Contains(r.URL.Path, "/permission/scope/perm-admin") && r.Method == "PUT":
			f.applyPermPut(r, "perm-proj-"+f.project+"-admin")
			w.WriteHeader(http.StatusOK)
		case strings.Contains(r.URL.Path, "/permission/scope/perm-member") && r.Method == "PUT":
			f.applyPermPut(r, "perm-proj-"+f.project+"-member")
			w.WriteHeader(http.StatusOK)

		case strings.Contains(r.URL.Path, "/permission/scope/perm-member") && r.Method == "DELETE":
			perm := f.perms["perm-proj-"+f.project+"-member"]
			perm.policies = nil
			f.perms["perm-proj-"+f.project+"-member"] = perm
			w.WriteHeader(http.StatusNoContent)
		case strings.Contains(r.URL.Path, "/permission/scope/perm-admin") && r.Method == "DELETE":
			perm := f.perms["perm-proj-"+f.project+"-admin"]
			perm.policies = nil
			f.perms["perm-proj-"+f.project+"-admin"] = perm
			w.WriteHeader(http.StatusNoContent)

		case strings.Contains(r.URL.Path, "/permission/scope") && r.Method == "POST":
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{"id": "perm-new"})

		case strings.Contains(r.URL.Path, "/authz/resource-server/policy/") && r.Method == "DELETE":
			parts := strings.Split(r.URL.Path, "/")
			delID := parts[len(parts)-1]
			for name, pid := range f.policies {
				if pid == delID {
					delete(f.policies, name)
				}
			}
			w.WriteHeader(http.StatusNoContent)

		default:
			f.t.Logf("unhandled: %s %s", r.Method, r.URL.String())
			w.WriteHeader(http.StatusNotFound)
		}
	}
}

func (f *fakeMembershipStateServer) writeAssoc(w http.ResponseWriter, permName string) {
	perm := f.perms[permName]
	assoc := make([]map[string]string, 0, len(perm.policies))
	for _, name := range perm.policies {
		assoc = append(assoc, map[string]string{"name": name})
	}
	json.NewEncoder(w).Encode(assoc)
}

func (f *fakeMembershipStateServer) applyPermPut(r *http.Request, permName string) {
	var body types.KeycloakScopePermission
	json.NewDecoder(r.Body).Decode(&body)
	perm := f.perms[permName]
	perm.policies = body.Policies
	f.perms[permName] = perm
}

// TestAddMemberThenPromoteToAdmin_PreservesExistingAdmins exercises the UI flow:
// POST /members (viewer/member) then PUT /members/role (admin). The promote path
// revokes the old role then grants admin into a permission that already has admins.
func TestAddMemberThenPromoteToAdmin_PreservesExistingAdmins(t *testing.T) {
	project := "proj1"
	userID := "user-promote"
	fake := newFakeMembershipStateServer(t, project)
	srv := httptest.NewServer(fake.handler())
	defer srv.Close()
	setupKeycloakEnv(t, srv.URL)

	testSuite := &testsuite.WorkflowTestSuite{}
	env := testSuite.NewTestActivityEnvironment()
	env.RegisterActivity(GrantProjectRoleActivity)
	env.RegisterActivity(RevokeProjectRoleActivity)

	// Step 1: add as member (permission already exists empty for member scope)
	_, err := env.ExecuteActivity(GrantProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: project,
		UserId:    userID,
		Role:      "member",
	})
	require.NoError(t, err)
	memberPolicy := "usr-" + userID + "-proj-" + project + "-member"
	assert.Contains(t, fake.perms["perm-proj-"+project+"-member"].policies, memberPolicy)
	assert.Equal(t, []string{"usr-owner-proj-" + project + "-admin"}, fake.perms["perm-proj-"+project+"-admin"].policies)

	// Step 2: promote to admin — revoke member, then grant admin
	_, err = env.ExecuteActivity(RevokeProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: project,
		UserId:    userID,
		Role:      "member",
	})
	require.NoError(t, err)
	assert.NotContains(t, fake.perms["perm-proj-"+project+"-member"].policies, memberPolicy)
	assert.Equal(t, []string{"usr-owner-proj-" + project + "-admin"}, fake.perms["perm-proj-"+project+"-admin"].policies)

	_, err = env.ExecuteActivity(GrantProjectRoleActivity, types.ProjectMembershipInput{
		ProjectId: project,
		UserId:    userID,
		Role:      "admin",
	})
	require.NoError(t, err)
	adminPolicy := "usr-" + userID + "-proj-" + project + "-admin"
	assert.Equal(t, []string{
		"usr-owner-proj-" + project + "-admin",
		adminPolicy,
	}, fake.perms["perm-proj-"+project+"-admin"].policies)
}
