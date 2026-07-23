package clients

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"
)

// ServiceAccountClient handles machine-to-machine authentication with Keycloak
type ServiceAccountClient struct {
	issuer       string
	clientID     string
	clientSecret string
	audience     string // optional: request token with this audience (e.g. "realm-management" for Admin API access)
	accessToken  string
	expiresAt    time.Time
	mu           sync.RWMutex
	httpClient   *http.Client
}

// TokenResponse represents the OAuth2 token response
type TokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Scope       string `json:"scope"`
}

// NewServiceAccountClient creates a new service account client
// Always uses KEYCLOAK_INTERNAL_ISSUER for service-to-service authentication
func NewServiceAccountClient() (*ServiceAccountClient, error) {
	// Always use internal issuer for service-to-service authentication (resolves inside Kubernetes)
	issuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	clientID := os.Getenv("KEYCLOAK_CLIENT_ID")
	clientSecret := os.Getenv("KEYCLOAK_CLIENT_SECRET")

	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil, fmt.Errorf("KEYCLOAK_INTERNAL_ISSUER, KEYCLOAK_CLIENT_ID, and KEYCLOAK_CLIENT_SECRET must be set")
	}

	// Keycloak issuer already includes /realms/{realm}, use as-is

	return &ServiceAccountClient{
		issuer:       issuer,
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

// NewServiceAccountClientWithCredentials creates a service account client with explicit credentials.
// The issuer should include /realms/{realm} (e.g., http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo).
func NewServiceAccountClientWithCredentials(issuer, clientID, clientSecret string) (*ServiceAccountClient, error) {
	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil, fmt.Errorf("issuer, client ID, and client secret must be set")
	}

	return &ServiceAccountClient{
		issuer:       issuer,
		clientID:     clientID,
		clientSecret: clientSecret,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

// NewServiceAccountClientWithHTTPClient creates a service-account client backed
// by the provided *http.Client. Tests use this to point Keycloak token requests
// at an httptest.Server.
func NewServiceAccountClientWithHTTPClient(issuer, clientID, clientSecret string, httpClient *http.Client) (*ServiceAccountClient, error) {
	c, err := NewServiceAccountClientWithCredentials(issuer, clientID, clientSecret)
	if err != nil {
		return nil, err
	}
	if httpClient != nil {
		c.httpClient = httpClient
	}
	return c, nil
}

// NewServiceAccountClientWithAudience creates a service account client that requests tokens
// with a specific audience. Required for Admin REST API access where the token must target
// "realm-management" to include manage-authorization/manage-clients roles.
func NewServiceAccountClientWithAudience(issuer, clientID, clientSecret, audience string) (*ServiceAccountClient, error) {
	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil, fmt.Errorf("issuer, client ID, and client secret must be set")
	}

	return &ServiceAccountClient{
		issuer:       issuer,
		clientID:     clientID,
		clientSecret: clientSecret,
		audience:     audience,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}, nil
}

// GetAccessToken gets an access token (with caching and automatic refresh)
func (c *ServiceAccountClient) GetAccessToken() (string, error) {
	c.mu.RLock()
	if c.accessToken != "" && time.Now().Before(c.expiresAt) {
		token := c.accessToken
		c.mu.RUnlock()
		return token, nil
	}
	c.mu.RUnlock()

	// Fetch new token
	c.mu.Lock()
	defer c.mu.Unlock()

	// Double-check after acquiring write lock
	if c.accessToken != "" && time.Now().Before(c.expiresAt) {
		return c.accessToken, nil
	}

	// Keycloak token endpoint: /realms/{realm}/protocol/openid-connect/token
	tokenURL := fmt.Sprintf("%s/protocol/openid-connect/token", c.issuer)
	data := url.Values{}
	data.Set("grant_type", "client_credentials")
	data.Set("client_id", c.clientID)
	data.Set("client_secret", c.clientSecret)
	data.Set("scope", "openid profile email")
	if c.audience != "" {
		data.Set("audience", c.audience)
	}

	req, err := http.NewRequest("POST", tokenURL, bytes.NewBufferString(data.Encode()))
	if err != nil {
		return "", fmt.Errorf("failed to create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("failed to get token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to get token: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var tokenResp TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return "", fmt.Errorf("failed to decode token response: %w", err)
	}

	c.accessToken = tokenResp.AccessToken
	expiresIn := tokenResp.ExpiresIn
	if expiresIn == 0 {
		expiresIn = 3600 // Default to 1 hour
	}
	c.expiresAt = time.Now().Add(time.Duration(expiresIn)*time.Second - 1*time.Minute) // Refresh 1 minute before expiry

	return c.accessToken, nil
}

// AddAuthHeader adds the Authorization header to an HTTP request
func (c *ServiceAccountClient) AddAuthHeader(req *http.Request) error {
	token, err := c.GetAccessToken()
	if err != nil {
		return fmt.Errorf("failed to get access token: %w", err)
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
	return nil
}

// removeOIDCSuffix is no longer needed for Keycloak
// Keycloak issuer format already includes /realms/{realm}
// This function is kept for backward compatibility but does nothing
func removeOIDCSuffix(issuer string) string {
	// Keycloak issuer is already in correct format, return as-is
	return issuer
}
