package clients

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

type LakekeeperClient struct {
	baseURL            string
	httpClient         *http.Client
	serviceAccountAuth *ServiceAccountClient // primary: Lakekeeper client credentials
	fallbackAuth       *ServiceAccountClient // fallback: workflow-engine credentials (used when primary fails, e.g. clean install before keycloak-setup)
}

// NewLakekeeperClientWithHTTPClient returns a Lakekeeper client backed by the
// provided *http.Client. Used by tests to point at httptest.Server. Auth is
// left unconfigured.
func NewLakekeeperClientWithHTTPClient(baseURL string, httpClient *http.Client) *LakekeeperClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &LakekeeperClient{
		baseURL:    baseURL,
		httpClient: httpClient,
	}
}

func NewLakekeeperClient(baseURL string) *LakekeeperClient {
	client := &LakekeeperClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}

	issuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	lakekeeperClientID := os.Getenv("LAKEKEEPER_CLIENT_ID")
	lakekeeperClientSecret := os.Getenv("LAKEKEEPER_CLIENT_SECRET")

	// Prefer Lakekeeper-specific credentials so Lakekeeper can identify the caller
	if lakekeeperClientID != "" && lakekeeperClientSecret != "" && issuer != "" {
		if saClient, err := NewServiceAccountClientWithCredentials(issuer, lakekeeperClientID, lakekeeperClientSecret); err == nil {
			client.serviceAccountAuth = saClient
			log.Printf("[LakekeeperClient] Service account authentication enabled (lakekeeper client)")
		} else {
			log.Printf("[LakekeeperClient] Lakekeeper client credentials not usable: %v", err)
		}
	} else if lakekeeperClientID != "" || lakekeeperClientSecret != "" {
		log.Printf("[LakekeeperClient] Lakekeeper client credentials incomplete or KEYCLOAK_INTERNAL_ISSUER not set")
	}

	// Fallback to workflow-engine service account so first project creation works before keycloak-setup populates lakekeeper secret
	if client.serviceAccountAuth == nil {
		if saClient, err := NewServiceAccountClient(); err == nil {
			client.serviceAccountAuth = saClient
			log.Printf("[LakekeeperClient] Service account authentication enabled (workflow-engine fallback)")
		} else {
			log.Printf("[LakekeeperClient] Service account authentication disabled: %v", err)
		}
	} else if fallback, err := NewServiceAccountClient(); err == nil {
		client.fallbackAuth = fallback
		log.Printf("[LakekeeperClient] Fallback to workflow-engine credentials configured")
	}
	return client
}

// addAuthHeader adds authentication header; uses fallback if primary token fetch fails (e.g. lakekeeper client not yet in Keycloak on clean install)
func (c *LakekeeperClient) addAuthHeader(req *http.Request) error {
	if c.serviceAccountAuth != nil {
		if err := c.serviceAccountAuth.AddAuthHeader(req); err == nil {
			return nil
		}
		// Primary failed (e.g. invalid lakekeeper client secret before keycloak-setup); try fallback
		if c.fallbackAuth != nil {
			if err := c.fallbackAuth.AddAuthHeader(req); err == nil {
				log.Printf("[LakekeeperClient] Using workflow-engine credentials after primary auth failed")
				return nil
			}
		}
		return fmt.Errorf("failed to add auth header (primary and fallback failed)")
	}
	return nil
}

// CreateWarehouse creates a warehouse in Lakekeeper's default project
func (c *LakekeeperClient) CreateWarehouse(request types.RegisterWarehouseRequest) (string, error) {
	url := fmt.Sprintf("%s/management/v1/warehouse", c.baseURL)

	log.Printf("[LakekeeperClient] Creating warehouse: %s", request.WarehouseName)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	body, err := json.Marshal(request)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to marshal request: %v", err)
		return "", fmt.Errorf("failed to marshal warehouse request: %w", err)
	}

	log.Printf("[LakekeeperClient] Request body: %s", string(body))

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to create warehouse: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return "", fmt.Errorf("failed to create warehouse: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	bodyBytes, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		log.Printf("[LakekeeperClient] INFO: Warehouse %s already exists (409), looking up ID...", request.WarehouseName)
		log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))
		// If warehouse already exists, look it up by name to get the ID
		warehouseId, err := c.GetWarehouseByName(request.WarehouseName)
		if err != nil {
			log.Printf("[LakekeeperClient] WARN: Failed to look up existing warehouse ID: %v", err)
			return "", fmt.Errorf("warehouse exists but failed to get ID: %w", err)
		}
		return warehouseId, nil
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		log.Printf("[LakekeeperClient] ERROR: Failed to create warehouse: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return "", fmt.Errorf("failed to create warehouse: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[LakekeeperClient] Warehouse %s created successfully", request.WarehouseName)
	log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))

	// Parse response to extract warehouse-id
	var response struct {
		WarehouseId string `json:"warehouse-id"`
	}
	if err := json.Unmarshal(bodyBytes, &response); err != nil {
		log.Printf("[LakekeeperClient] WARN: Failed to parse warehouse ID from response: %v", err)
		// Try to look it up by name as fallback
		warehouseId, lookupErr := c.GetWarehouseByName(request.WarehouseName)
		if lookupErr != nil {
			return "", fmt.Errorf("failed to parse warehouse ID and lookup failed: %w", err)
		}
		return warehouseId, nil
	}

	if response.WarehouseId == "" {
		log.Printf("[LakekeeperClient] WARN: Warehouse ID not in response, looking up by name...")
		warehouseId, err := c.GetWarehouseByName(request.WarehouseName)
		if err != nil {
			return "", fmt.Errorf("warehouse created but ID not found in response and lookup failed: %w", err)
		}
		return warehouseId, nil
	}

	log.Printf("[LakekeeperClient] Warehouse ID: %s", response.WarehouseId)
	return response.WarehouseId, nil
}

// GetWarehouseByName looks up a warehouse by name and returns its ID
func (c *LakekeeperClient) GetWarehouseByName(warehouseName string) (string, error) {
	url := fmt.Sprintf("%s/management/v1/warehouse", c.baseURL)

	log.Printf("[LakekeeperClient] Looking up warehouse by name: %s", warehouseName)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return "", fmt.Errorf("failed to list warehouses: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return "", fmt.Errorf("failed to list warehouses: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[LakekeeperClient] ERROR: Failed to list warehouses: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return "", fmt.Errorf("failed to list warehouses: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var response struct {
		Warehouses []map[string]interface{} `json:"warehouses"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to decode response: %v", err)
		return "", fmt.Errorf("failed to decode warehouses response: %w", err)
	}

	// Search for warehouse by name
	for _, warehouse := range response.Warehouses {
		name := ""
		if n, ok := warehouse["warehouse-name"].(string); ok {
			name = n
		} else if n, ok := warehouse["name"].(string); ok {
			name = n
		}

		if name == warehouseName {
			// Extract warehouse ID - check multiple possible field names
			warehouseId := ""
			if id, ok := warehouse["warehouse-id"].(string); ok {
				warehouseId = id
			} else if id, ok := warehouse["warehouseId"].(string); ok {
				warehouseId = id
			} else if id, ok := warehouse["id"].(string); ok {
				warehouseId = id
			}

			if warehouseId != "" {
				log.Printf("[LakekeeperClient] Found warehouse %s with ID: %s", warehouseName, warehouseId)
				return warehouseId, nil
			}
		}
	}

	log.Printf("[LakekeeperClient] WARN: Warehouse %s not found in list", warehouseName)
	return "", fmt.Errorf("warehouse %s not found", warehouseName)
}

func (c *LakekeeperClient) DeleteWarehouse(warehouseId string) error {
	url := fmt.Sprintf("%s/management/v1/warehouse/%s", c.baseURL, warehouseId)

	log.Printf("[LakekeeperClient] Deleting warehouse by ID: %s", warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create delete request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to delete warehouse: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to delete warehouse: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == 404 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[LakekeeperClient] INFO: Warehouse %s not found (404), continuing...", warehouseId)
		log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))
		return nil // Idempotent - warehouse already deleted
	}

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[LakekeeperClient] ERROR: Failed to delete warehouse: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to delete warehouse: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Warehouse %s deleted successfully", warehouseId)
	log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))

	return nil
}

// CreateNamespace creates a namespace in Lakekeeper catalog
func (c *LakekeeperClient) CreateNamespace(request types.CreateNamespaceRequest) error {
	// Use warehouse ID as the prefix in the catalog path: /catalog/v1/{warehouse-id}/namespaces
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces", c.baseURL, request.WarehouseId)

	log.Printf("[LakekeeperClient] Creating namespace: %v in warehouse: %s", request.Namespace, request.WarehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	requestBody := map[string]interface{}{
		"namespace": request.Namespace,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal namespace request: %w", err)
	}

	log.Printf("[LakekeeperClient] Request body: %s", string(body))

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to create namespace: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to create namespace: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	bodyBytes, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		log.Printf("[LakekeeperClient] INFO: Namespace %v already exists (409), continuing...", request.Namespace)
		log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))
		return nil // Idempotent - namespace already exists
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		log.Printf("[LakekeeperClient] ERROR: Failed to create namespace: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to create namespace: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[LakekeeperClient] Namespace %v created successfully", request.Namespace)
	log.Printf("[LakekeeperClient] Response body: %s", string(bodyBytes))

	return nil
}

// GetTable gets table metadata from catalog
func (c *LakekeeperClient) GetTable(warehouseId, namespace, tableName string) (map[string]interface{}, error) {
	// Format: /catalog/v1/{warehouse-id}/namespaces/{namespace}/tables/{table}
	namespacePath := namespace
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s/tables/%s", c.baseURL, warehouseId, namespacePath, tableName)

	log.Printf("[LakekeeperClient] Getting table: %s in namespace: %s, warehouse: %s", tableName, namespace, warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to get table: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to get table: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[LakekeeperClient] ERROR: Failed to get table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to get table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var table map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&table); err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to decode table response: %v", err)
		return nil, fmt.Errorf("failed to decode table: %w", err)
	}

	log.Printf("[LakekeeperClient] Table %s retrieved successfully", tableName)
	return table, nil
}

// ListTables lists all tables in a namespace
func (c *LakekeeperClient) ListTables(warehouseId, namespace string) ([]string, error) {
	// Format: GET /catalog/v1/{warehouse-id}/namespaces/{namespace}/tables
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s/tables", c.baseURL, warehouseId, namespace)

	log.Printf("[LakekeeperClient] Listing tables in namespace: %s, warehouse: %s", namespace, warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to list tables: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to list tables: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[LakekeeperClient] Namespace %s not found (may be empty or deleted)", namespace)
		return []string{}, nil
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("[LakekeeperClient] ERROR: Failed to list tables: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to list tables: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	// Parse response - Iceberg REST spec returns {"identifiers": [{"namespace": [...], "name": "tableName"}, ...]}
	var response struct {
		Identifiers []struct {
			Namespace []string `json:"namespace"`
			Name      string   `json:"name"`
		} `json:"identifiers"`
	}
	if err := json.Unmarshal(bodyBytes, &response); err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to decode tables response: %v", err)
		return nil, fmt.Errorf("failed to decode tables: %w", err)
	}

	tables := make([]string, 0, len(response.Identifiers))
	for _, id := range response.Identifiers {
		tables = append(tables, id.Name)
	}

	log.Printf("[LakekeeperClient] Found %d tables in namespace %s: %v", len(tables), namespace, tables)
	return tables, nil
}

// DeleteTable deletes a table from the catalog
func (c *LakekeeperClient) DeleteTable(warehouseId, namespace, tableName string) error {
	// Format: DELETE /catalog/v1/{warehouse-id}/namespaces/{namespace}/tables/{table}?purgeRequested=true
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s/tables/%s?purgeRequested=true", c.baseURL, warehouseId, namespace, tableName)

	log.Printf("[LakekeeperClient] Deleting table: %s in namespace: %s, warehouse: %s", tableName, namespace, warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to delete table: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to delete table: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK {
		log.Printf("[LakekeeperClient] Table %s deleted successfully", tableName)
		return nil
	}

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[LakekeeperClient] Table %s not found (may already be deleted)", tableName)
		return nil // Idempotent - table already deleted
	}

	log.Printf("[LakekeeperClient] ERROR: Failed to delete table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	return fmt.Errorf("failed to delete table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
}

// DeleteNamespace deletes a namespace from the catalog
func (c *LakekeeperClient) DeleteNamespace(warehouseId, namespace string) error {
	// Format: DELETE /catalog/v1/{warehouse-id}/namespaces/{namespace}
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s", c.baseURL, warehouseId, namespace)

	log.Printf("[LakekeeperClient] Deleting namespace: %s, warehouse: %s", namespace, warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("DELETE", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to delete namespace: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to delete namespace: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusOK {
		log.Printf("[LakekeeperClient] Namespace %s deleted successfully", namespace)
		return nil
	}

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[LakekeeperClient] Namespace %s not found (may already be deleted)", namespace)
		return nil // Idempotent - namespace already deleted
	}

	log.Printf("[LakekeeperClient] ERROR: Failed to delete namespace: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	return fmt.Errorf("failed to delete namespace: status %d, body: %s", resp.StatusCode, string(bodyBytes))
}

// ListNamespaces lists all namespaces in a warehouse
func (c *LakekeeperClient) ListNamespaces(warehouseId string) ([]string, error) {
	// Format: GET /catalog/v1/{warehouse-id}/namespaces
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces", c.baseURL, warehouseId)

	log.Printf("[LakekeeperClient] Listing namespaces in warehouse: %s", warehouseId)
	log.Printf("[LakekeeperClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		return nil, fmt.Errorf("failed to list namespaces: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[LakekeeperClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to list namespaces: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNotFound {
		log.Printf("[LakekeeperClient] Warehouse %s not found", warehouseId)
		return []string{}, nil
	}

	if resp.StatusCode != http.StatusOK {
		log.Printf("[LakekeeperClient] ERROR: Failed to list namespaces: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to list namespaces: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	// Parse response - Iceberg REST spec returns {"namespaces": [["namespace1"], ["namespace2"], ...]}
	var response struct {
		Namespaces [][]string `json:"namespaces"`
	}
	if err := json.Unmarshal(bodyBytes, &response); err != nil {
		log.Printf("[LakekeeperClient] ERROR: Failed to decode namespaces response: %v", err)
		return nil, fmt.Errorf("failed to decode namespaces: %w", err)
	}

	// Convert nested arrays to flat namespace strings
	namespaces := make([]string, 0, len(response.Namespaces))
	for _, ns := range response.Namespaces {
		if len(ns) > 0 {
			// Join multi-level namespace with dots
			nsName := ""
			for i, part := range ns {
				if i > 0 {
					nsName += "."
				}
				nsName += part
			}
			namespaces = append(namespaces, nsName)
		}
	}

	log.Printf("[LakekeeperClient] Found %d namespaces in warehouse %s: %v", len(namespaces), warehouseId, namespaces)
	return namespaces, nil
}

// EnsureNamespace creates namespace if it doesn't exist
func (c *LakekeeperClient) EnsureNamespace(warehouseId, namespace string) error {
	log.Printf("[LakekeeperClient] Ensuring namespace exists: %s in warehouse: %s", namespace, warehouseId)

	// Check if namespace exists
	namespaces, err := c.ListNamespaces(warehouseId)
	if err != nil {
		log.Printf("[LakekeeperClient] Warning: Failed to list namespaces: %v", err)
		// Continue to try creating - it might work
	} else {
		for _, ns := range namespaces {
			if ns == namespace {
				log.Printf("[LakekeeperClient] Namespace %s already exists", namespace)
				return nil
			}
		}
	}

	// Create namespace
	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces", c.baseURL, warehouseId)

	namespaceParts := []string{namespace}
	// Handle multi-level namespace (e.g., "a.b.c" -> ["a", "b", "c"])
	if len(namespace) > 0 {
		parts := []string{}
		current := ""
		for _, ch := range namespace {
			if ch == '.' {
				if current != "" {
					parts = append(parts, current)
					current = ""
				}
			} else {
				current += string(ch)
			}
		}
		if current != "" {
			parts = append(parts, current)
		}
		if len(parts) > 0 {
			namespaceParts = parts
		}
	}

	requestBody := map[string]interface{}{
		"namespace": namespaceParts,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("failed to marshal namespace request: %w", err)
	}

	log.Printf("[LakekeeperClient] Creating namespace: %s, body: %s", namespace, string(body))

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to create namespace: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to create namespace: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d, body: %s", resp.StatusCode, string(bodyBytes))

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		log.Printf("[LakekeeperClient] Namespace %s already exists (409)", namespace)
		return nil
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("failed to create namespace: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[LakekeeperClient] Namespace %s created successfully", namespace)
	return nil
}

// CreateTableRequest represents a request to create an Iceberg table
type CreateTableRequest struct {
	Name        string                 `json:"name"`
	Location    string                 `json:"location"`
	Schema      map[string]interface{} `json:"schema"`
	DatasetId   string                 `json:"datasetId"`
	DatasetKind string                 `json:"datasetKind"`
	StageCreate bool                   `json:"stageCreate"` // Use stage_create for external data
}

// CreateTable creates an Iceberg table in Lakekeeper
func (c *LakekeeperClient) CreateTable(warehouseId, namespace string, request CreateTableRequest) error {
	log.Printf("[LakekeeperClient] Creating table: %s in namespace: %s, warehouse: %s", request.Name, namespace, warehouseId)

	url := fmt.Sprintf("%s/catalog/v1/%s/namespaces/%s/tables", c.baseURL, warehouseId, namespace)

	// Build Iceberg table creation request per Iceberg REST spec
	tableRequest := map[string]interface{}{
		"name":   request.Name,
		"schema": request.Schema,
		"properties": map[string]string{
			"agentstudio.dataset.id":   request.DatasetId,
			"agentstudio.dataset.kind": request.DatasetKind,
		},
	}

	// For external data, use stage_create=true
	if request.StageCreate {
		tableRequest["stage-create"] = true
	}

	// Set location for external data
	if request.Location != "" {
		tableRequest["location"] = request.Location
	}

	body, err := json.Marshal(tableRequest)
	if err != nil {
		return fmt.Errorf("failed to marshal table request: %w", err)
	}

	log.Printf("[LakekeeperClient] Request URL: %s", url)
	log.Printf("[LakekeeperClient] Request body: %s", string(body))

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to create table: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to create table: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[LakekeeperClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		log.Printf("[LakekeeperClient] Table %s already exists (409), attempting update", request.Name)
		// Table exists, could update metadata here if needed
		return nil
	}

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("[LakekeeperClient] ERROR: Failed to create table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to create table: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[LakekeeperClient] Table %s created successfully in %s.%s", request.Name, warehouseId, namespace)
	return nil
}
