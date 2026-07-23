package clients

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

// ErrNotFound is returned by lookup methods when Keycloak responds with 404
// or an empty result set. Callers should use errors.Is to distinguish this
// idempotent "already absent" case from transient/server errors.
var ErrNotFound = errors.New("keycloak: not found")

// KeycloakAuthzClient handles Keycloak Authorization Services API calls.
// All operations go through the Admin Authz API on behalf of agent-studio-svc-config.
// The Protection API is not used because it requires the calling client to be the
// resource server itself (agent-studio-api), whereas svc-config is a separate client
// holding the manage-authorization role on realm-management.
type KeycloakAuthzClient struct {
	// issuer is the realm URL, e.g. http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo
	issuer        string
	clientID      string
	clientUUID    string                // resource-server ID (client UUID in Keycloak)
	adminSAClient *ServiceAccountClient // Admin Authz API client (audience=realm-management)
	httpClient    *http.Client
}

// NewKeycloakAuthzClient creates a new Keycloak Authorization Services client.
// issuer must include /realms/{realm}.
// clientUUID is the UUID of the resource-server client (agent-studio-api).
func NewKeycloakAuthzClient(issuer, clientID, clientSecret, clientUUID string) (*KeycloakAuthzClient, error) {
	adminSAClient, err := NewServiceAccountClientWithAudience(issuer, clientID, clientSecret, "realm-management")
	if err != nil {
		return nil, fmt.Errorf("failed to create admin service account client: %w", err)
	}

	return &KeycloakAuthzClient{
		issuer:        issuer,
		clientID:      clientID,
		clientUUID:    clientUUID,
		adminSAClient: adminSAClient,
		httpClient:    &http.Client{Timeout: 30 * time.Second},
	}, nil
}

// ---- Resources (Admin Authz API) ----

// resourceBaseURL returns the Admin Authz API base URL for resources.
func (k *KeycloakAuthzClient) resourceBaseURL() string {
	return fmt.Sprintf("%s/resource", k.adminAuthzBaseURL())
}

// CreateResource creates a resource via the Admin Authz API.
// Returns the resource ID. Treats 409 as success (fetches existing by name).
func (k *KeycloakAuthzClient) CreateResource(resource types.KeycloakResource) (string, error) {
	body, err := json.Marshal(resource)
	if err != nil {
		return "", fmt.Errorf("failed to marshal resource: %w", err)
	}

	req, err := http.NewRequest("POST", k.resourceBaseURL(), bytes.NewBuffer(body))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to create resource: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		log.Printf("[KeycloakAuthzClient] Resource %q already exists (409), fetching by name", resource.Name)
		return k.GetResourceByName(resource.Name)
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to create resource: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	respBody, _ := io.ReadAll(resp.Body)
	if len(bytes.TrimSpace(respBody)) == 0 {
		// Some Keycloak builds return 201 with an empty body — fall back to a
		// name lookup so the create stays idempotent.
		return k.GetResourceByName(resource.Name)
	}
	var result struct {
		ID string `json:"_id"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("failed to decode create resource response: %w", err)
	}
	if result.ID == "" {
		return k.GetResourceByName(resource.Name)
	}
	return result.ID, nil
}

// GetResourceByName looks up a resource by exact name via the Admin Authz API.
// Unlike the Protection API which returns just an array of IDs, the Admin API
// returns an array of full resource objects, so we read the _id field of the
// first matching entry.
func (k *KeycloakAuthzClient) GetResourceByName(name string) (string, error) {
	u := fmt.Sprintf("%s?name=%s&exactName=true", k.resourceBaseURL(), url.QueryEscape(name))

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to get resource by name: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to get resource by name: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var resources []struct {
		ID   string `json:"_id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&resources); err != nil {
		return "", fmt.Errorf("failed to decode resources: %w", err)
	}
	for _, r := range resources {
		if r.Name == name {
			return r.ID, nil
		}
	}
	return "", fmt.Errorf("%w: resource %s", ErrNotFound, name)
}

// DeleteResource deletes a resource by ID via the Admin Authz API.
// Returns nil on 404 (already deleted).
func (k *KeycloakAuthzClient) DeleteResource(resourceId string) error {
	u := fmt.Sprintf("%s/%s", k.resourceBaseURL(), resourceId)

	req, err := http.NewRequest("DELETE", u, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete resource: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[KeycloakAuthzClient] Resource %q already deleted (404)", resourceId)
		return nil
	}
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete resource: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// ---- Admin Authz API (policies and permissions) ----

// adminAuthzBaseURL returns the Admin REST API base for the resource server.
func (k *KeycloakAuthzClient) adminAuthzBaseURL() string {
	// Admin REST API: /admin/realms/{realm}/clients/{clientUUID}/authz/resource-server
	realmName := extractRealmFromIssuer(k.issuer)
	baseHost := extractBaseFromIssuer(k.issuer)
	return fmt.Sprintf("%s/admin/realms/%s/clients/%s/authz/resource-server", baseHost, realmName, k.clientUUID)
}

// CreateUserPolicy creates a user-based policy via the Admin Authz API.
// Returns the policy ID. Treats 409 as success (fetches existing by name).
func (k *KeycloakAuthzClient) CreateUserPolicy(policy types.KeycloakUserPolicy) (string, error) {
	u := fmt.Sprintf("%s/policy/user", k.adminAuthzBaseURL())

	if policy.Logic == "" {
		policy.Logic = "POSITIVE"
	}
	if policy.DecisionStrategy == "" {
		policy.DecisionStrategy = "UNANIMOUS"
	}

	body, err := json.Marshal(policy)
	if err != nil {
		return "", fmt.Errorf("failed to marshal policy: %w", err)
	}

	req, err := http.NewRequest("POST", u, bytes.NewBuffer(body))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to create user policy: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		log.Printf("[KeycloakAuthzClient] Policy %q already exists (409), fetching by name", policy.Name)
		return k.GetPolicyByName(policy.Name)
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to create user policy: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	respBody, _ := io.ReadAll(resp.Body)
	if len(bytes.TrimSpace(respBody)) == 0 {
		return k.GetPolicyByName(policy.Name)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("failed to decode policy response: %w", err)
	}
	if result.ID == "" {
		return k.GetPolicyByName(policy.Name)
	}
	return result.ID, nil
}

// GetPolicyByName finds a policy by name.
func (k *KeycloakAuthzClient) GetPolicyByName(name string) (string, error) {
	u := fmt.Sprintf("%s/policy?name=%s", k.adminAuthzBaseURL(), url.QueryEscape(name))

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to get policy by name: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("%w: policy %s", ErrNotFound, name)
	}
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to get policy by name: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var policies []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&policies); err != nil {
		return "", fmt.Errorf("failed to decode policies: %w", err)
	}

	for _, p := range policies {
		if p.Name == name {
			return p.ID, nil
		}
	}

	return "", fmt.Errorf("%w: policy %s", ErrNotFound, name)
}

// PolicyInfo represents a policy returned by the search/list endpoint.
type PolicyInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
}

// ListPolicies searches for policies by name prefix using the Admin Authz API.
// Uses ?type=user&name={prefix}&search=true to find user policies matching a prefix.
// This is the §6.1/§6.2 read path — one call per listing request.
func (k *KeycloakAuthzClient) ListPolicies(namePrefix string, max int) ([]PolicyInfo, error) {
	if max <= 0 {
		max = 200
	}
	u := fmt.Sprintf("%s/policy?type=user&name=%s&permission=false&search=true&max=%d",
		k.adminAuthzBaseURL(), url.QueryEscape(namePrefix), max)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list policies: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to list policies: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var policies []PolicyInfo
	if err := json.NewDecoder(resp.Body).Decode(&policies); err != nil {
		return nil, fmt.Errorf("failed to decode policies list: %w", err)
	}

	return policies, nil
}

// DeletePolicy deletes a policy by ID. Returns nil on 404.
func (k *KeycloakAuthzClient) DeletePolicy(policyId string) error {
	u := fmt.Sprintf("%s/policy/%s", k.adminAuthzBaseURL(), policyId)

	req, err := http.NewRequest("DELETE", u, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete policy: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete policy: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// CreateScopePermission creates a scope-based permission via the Admin Authz API.
// Returns the permission ID. Treats 409 as success (fetches existing by name).
func (k *KeycloakAuthzClient) CreateScopePermission(perm types.KeycloakScopePermission) (string, error) {
	u := fmt.Sprintf("%s/permission/scope", k.adminAuthzBaseURL())

	if perm.Logic == "" {
		perm.Logic = "POSITIVE"
	}
	if perm.DecisionStrategy == "" {
		perm.DecisionStrategy = "AFFIRMATIVE"
	}

	body, err := json.Marshal(perm)
	if err != nil {
		return "", fmt.Errorf("failed to marshal permission: %w", err)
	}

	req, err := http.NewRequest("POST", u, bytes.NewBuffer(body))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to create scope permission: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusConflict {
		log.Printf("[KeycloakAuthzClient] Permission %q already exists (409), fetching by name", perm.Name)
		return k.GetPermissionByName(perm.Name)
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to create scope permission: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	respBody, _ := io.ReadAll(resp.Body)
	if len(bytes.TrimSpace(respBody)) == 0 {
		return k.GetPermissionByName(perm.Name)
	}
	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return "", fmt.Errorf("failed to decode permission response: %w", err)
	}
	if result.ID == "" {
		return k.GetPermissionByName(perm.Name)
	}
	return result.ID, nil
}

// GetPermissionByName finds a scope permission by name.
// Uses the /permission/scope endpoint to match the rest of the file
// (create/get/update/delete all operate on /permission/scope) and the
// smoke spec contract; the generic /permission endpoint is inconsistent
// and may behave differently across Keycloak versions.
func (k *KeycloakAuthzClient) GetPermissionByName(name string) (string, error) {
	u := fmt.Sprintf("%s/permission/scope?name=%s", k.adminAuthzBaseURL(), url.QueryEscape(name))

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to get permission by name: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", fmt.Errorf("%w: permission %s", ErrNotFound, name)
	}
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to get permission by name: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var permissions []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&permissions); err != nil {
		return "", fmt.Errorf("failed to decode permissions: %w", err)
	}

	for _, p := range permissions {
		if p.Name == name {
			return p.ID, nil
		}
	}

	return "", fmt.Errorf("%w: permission %s", ErrNotFound, name)
}

// GetScopePermission fetches full permission details by ID.
func (k *KeycloakAuthzClient) GetScopePermission(permId string) (*types.KeycloakScopePermission, error) {
	u := fmt.Sprintf("%s/permission/scope/%s", k.adminAuthzBaseURL(), permId)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get permission: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: permission id %s", ErrNotFound, permId)
	}
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get permission: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var perm types.KeycloakScopePermission
	if err := json.NewDecoder(resp.Body).Decode(&perm); err != nil {
		return nil, fmt.Errorf("failed to decode permission: %w", err)
	}

	return &perm, nil
}

// GetPermissionAssociatedPolicyNames returns the policy *names* currently
// attached to a scope permission. Keycloak's GET /permission/scope/{id} omits
// the policies field; the only reliable source is /policy/{id}/associatedPolicies.
func (k *KeycloakAuthzClient) GetPermissionAssociatedPolicyNames(permId string) ([]string, error) {
	u := fmt.Sprintf("%s/policy/%s/associatedPolicies", k.adminAuthzBaseURL(), permId)

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get associated policies: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%w: scope permission id %s", ErrNotFound, permId)
	}
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get associated policies: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	var associated []struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&associated); err != nil {
		return nil, fmt.Errorf("failed to decode associated policies: %w", err)
	}

	names := make([]string, 0, len(associated))
	for _, p := range associated {
		if p.Name != "" {
			names = append(names, p.Name)
		}
	}
	return names, nil
}

// UpdateScopePermission updates an existing scope permission by ID.
func (k *KeycloakAuthzClient) UpdateScopePermission(permId string, perm types.KeycloakScopePermission) error {
	u := fmt.Sprintf("%s/permission/scope/%s", k.adminAuthzBaseURL(), permId)

	body, err := json.Marshal(perm)
	if err != nil {
		return fmt.Errorf("failed to marshal permission: %w", err)
	}

	req, err := http.NewRequest("PUT", u, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update permission: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update permission: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// DeletePermission deletes a scope permission by ID. Returns nil on 404.
func (k *KeycloakAuthzClient) DeletePermission(permId string) error {
	u := fmt.Sprintf("%s/permission/scope/%s", k.adminAuthzBaseURL(), permId)

	req, err := http.NewRequest("DELETE", u, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	if err := k.adminSAClient.AddAuthHeader(req); err != nil {
		return fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := k.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to delete permission: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil
	}
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete permission: status %d, body: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

// ---- Helpers ----

// extractRealmFromIssuer extracts the realm name from a Keycloak issuer URL.
// e.g. "http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo" -> "nemo"
func extractRealmFromIssuer(issuer string) string {
	u, err := url.Parse(issuer)
	if err != nil {
		return "nemo"
	}
	parts := splitPath(u.Path)
	for i, p := range parts {
		if p == "realms" && i+1 < len(parts) {
			return parts[i+1]
		}
	}
	return "nemo"
}

// extractBaseFromIssuer extracts the scheme+host from issuer.
// e.g. "http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo" -> "http://keycloak.agentstudio-identity.svc.cluster.local:8080"
func extractBaseFromIssuer(issuer string) string {
	u, err := url.Parse(issuer)
	if err != nil {
		return issuer
	}
	return fmt.Sprintf("%s://%s", u.Scheme, u.Host)
}

func splitPath(path string) []string {
	var parts []string
	for _, p := range splitOnSlash(path) {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return parts
}

func splitOnSlash(s string) []string {
	result := []string{}
	current := ""
	for _, c := range s {
		if c == '/' {
			result = append(result, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	result = append(result, current)
	return result
}
