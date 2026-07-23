package types

// KeycloakResource represents a Keycloak Authorization resource.
type KeycloakResource struct {
	ID                 string          `json:"_id,omitempty"`
	Name               string          `json:"name"`
	Type               string          `json:"type,omitempty"`
	URIs               []string        `json:"uris,omitempty"`
	Scopes             []KeycloakScope `json:"scopes,omitempty"`
	OwnerManagedAccess bool            `json:"ownerManagedAccess"`
}

// KeycloakScope represents a scope in Keycloak Authorization.
type KeycloakScope struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name"`
}

// KeycloakUserPolicy represents a user-based policy in Keycloak Authorization.
type KeycloakUserPolicy struct {
	ID               string   `json:"id,omitempty"`
	Name             string   `json:"name"`
	Description      string   `json:"description,omitempty"`
	Type             string   `json:"type,omitempty"`
	Logic            string   `json:"logic,omitempty"`
	DecisionStrategy string   `json:"decisionStrategy,omitempty"`
	Users            []string `json:"users"`
}

// KeycloakScopePermission represents a scope-based permission in Keycloak Authorization.
type KeycloakScopePermission struct {
	ID               string   `json:"id,omitempty"`
	Name             string   `json:"name"`
	Description      string   `json:"description,omitempty"`
	Type             string   `json:"type,omitempty"`
	Logic            string   `json:"logic,omitempty"`
	DecisionStrategy string   `json:"decisionStrategy,omitempty"`
	Resources        []string `json:"resources,omitempty"`
	Scopes           []string `json:"scopes,omitempty"`
	Policies         []string `json:"policies,omitempty"`
}

// RegisterProjectResourceInput is the input for the RegisterProjectResourceActivity.
type RegisterProjectResourceInput struct {
	ProjectId   string `json:"projectId"`
	OwnerUserId string `json:"ownerUserId"`
}

// RegisterProjectResourceResult is the result of RegisterProjectResourceActivity.
type RegisterProjectResourceResult struct {
	ResourceId string `json:"resourceId"`
}

// PersistKeycloakResourceIdInput is the input for PersistKeycloakResourceIdActivity.
type PersistKeycloakResourceIdInput struct {
	ProjectId  string `json:"projectId"`
	ResourceId string `json:"resourceId"`
}

// GrantInitialAdminInput is the input for GrantInitialAdminActivity.
type GrantInitialAdminInput struct {
	ProjectId   string `json:"projectId"`
	OwnerUserId string `json:"ownerUserId"`
}

// DeleteProjectResourceInput is the input for DeleteProjectResourceActivity.
type DeleteProjectResourceInput struct {
	ProjectId string `json:"projectId"`
}

// ProjectMembershipInput is the input for membership workflows.
type ProjectMembershipInput struct {
	ProjectId string `json:"projectId"`
	UserId    string `json:"userId"`
	Role      string `json:"role,omitempty"` // admin, member, viewer
}
