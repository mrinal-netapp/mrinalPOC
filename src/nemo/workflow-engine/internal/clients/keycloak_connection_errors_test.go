package clients

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/require"
)

func TestKeycloakAuthzClient_AllHTTPDoErrorsPropagate(t *testing.T) {
	url := closedServer(t)
	client, err := NewKeycloakAuthzClient(url+"/realms/nemo", "id", "secret", "uuid")
	require.NoError(t, err)

	_, err = client.CreateResource(types.KeycloakResource{Name: "project:p"})
	require.Error(t, err)
	_, err = client.GetResourceByName("project:p")
	require.Error(t, err)
	require.Error(t, client.DeleteResource("r"))
	_, err = client.CreateUserPolicy(types.KeycloakUserPolicy{Name: "pol"})
	require.Error(t, err)
	_, err = client.GetPolicyByName("pol")
	require.Error(t, err)
	_, err = client.ListPolicies("usr-", 10)
	require.Error(t, err)
	require.Error(t, client.DeletePolicy("pol"))
	_, err = client.CreateScopePermission(types.KeycloakScopePermission{Name: "perm"})
	require.Error(t, err)
	_, err = client.GetPermissionByName("perm")
	require.Error(t, err)
	_, err = client.GetScopePermission("perm-id")
	require.Error(t, err)
	require.Error(t, client.UpdateScopePermission("perm-id", types.KeycloakScopePermission{}))
	require.Error(t, client.DeletePermission("perm-id"))
}
