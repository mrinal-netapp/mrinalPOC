// Package configsvc provides a lightweight client for the config-service
// project-membership read endpoints.
package configsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// UserProject is a single entry from GET /api/v1/projects. The endpoint joins
// the caller's Keycloak memberships onto config-service project metadata and
// annotates each entry with the caller's role, so the project identifier is the
// metadata `id` field (same value space as the Keycloak policy projectId).
type UserProject struct {
	ProjectID string `json:"id"`
	Role      string `json:"role"`
}

type userProjectsResponse struct {
	Projects []UserProject `json:"projects"`
}

// Client calls config-service with a user's Bearer token.
type Client struct {
	baseURL    string
	httpClient *http.Client
}

// New creates a Client pointing at the given config-service base URL.
func New(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ListUserProjects calls the caller-scoped GET /api/v1/projects using the
// provided Bearer access token. config-service derives the user from the
// token's `sub`, so the path carries no userId. The `sub` argument is retained
// for call-site logging/diagnostics. Returns the project list on success.
func (c *Client) ListUserProjects(ctx context.Context, sub, accessToken string) ([]UserProject, error) {
	url := fmt.Sprintf("%s/api/v1/projects", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("configsvc: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("configsvc: request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("configsvc: unexpected status %d for user %s", resp.StatusCode, sub)
	}

	var body userProjectsResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("configsvc: decode response: %w", err)
	}
	return body.Projects, nil
}
