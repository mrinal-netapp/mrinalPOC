package services

import (
	"errors"
	"os"
	"testing"
)

// --- getEnvOr ---

func TestGetEnvOr_WithValue(t *testing.T) {
	os.Setenv("TEST_KEY_123", "myvalue")
	defer os.Unsetenv("TEST_KEY_123")
	got := getEnvOr("TEST_KEY_123", "fallback")
	if got != "myvalue" {
		t.Errorf("expected %q, got %q", "myvalue", got)
	}
}

func TestGetEnvOr_WithFallback(t *testing.T) {
	os.Unsetenv("TEST_KEY_MISSING")
	got := getEnvOr("TEST_KEY_MISSING", "default")
	if got != "default" {
		t.Errorf("expected %q, got %q", "default", got)
	}
}

func TestGetEnvOr_EmptyValue(t *testing.T) {
	os.Setenv("TEST_KEY_EMPTY", "")
	defer os.Unsetenv("TEST_KEY_EMPTY")
	got := getEnvOr("TEST_KEY_EMPTY", "fallback")
	if got != "fallback" {
		t.Errorf("expected fallback when env is empty, got %q", got)
	}
}

// --- escapeSQLString ---

func TestEscapeSQLString_Plain(t *testing.T) {
	got := escapeSQLString("hello")
	if got != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestEscapeSQLString_Apostrophe(t *testing.T) {
	got := escapeSQLString("it's")
	if got != "it''s" {
		t.Errorf("expected %q, got %q", "it''s", got)
	}
}

func TestEscapeSQLString_MultipleApostrophes(t *testing.T) {
	got := escapeSQLString("a'b'c")
	if got != "a''b''c" {
		t.Errorf("expected %q, got %q", "a''b''c", got)
	}
}

func TestEscapeSQLString_Empty(t *testing.T) {
	got := escapeSQLString("")
	if got != "" {
		t.Errorf("expected empty string, got %q", got)
	}
}

func TestEscapeSQLString_NoSpecialChars(t *testing.T) {
	input := "warehouse_name_123"
	got := escapeSQLString(input)
	if got != input {
		t.Errorf("expected %q unchanged, got %q", input, got)
	}
}

// --- isAuthError ---

func TestIsAuthError_Contains401(t *testing.T) {
	if !isAuthError(errors.New("HTTP 401 Unauthorized")) {
		t.Error("expected true for error containing '401'")
	}
}

func TestIsAuthError_ContainsUnauthorized(t *testing.T) {
	if !isAuthError(errors.New("unauthorized access")) {
		t.Error("expected true for error containing 'unauthorized'")
	}
}

func TestIsAuthError_CaseInsensitive(t *testing.T) {
	if !isAuthError(errors.New("UNAUTHORIZED")) {
		t.Error("expected true for uppercase UNAUTHORIZED")
	}
}

func TestIsAuthError_NotAuthError(t *testing.T) {
	if isAuthError(errors.New("connection refused")) {
		t.Error("expected false for non-auth error")
	}
}

func TestIsAuthError_EmptyError(t *testing.T) {
	if isAuthError(errors.New("")) {
		t.Error("expected false for empty error")
	}
}

// --- NewCatalogConfigFromEnv ---

func TestNewCatalogConfigFromEnv_Defaults(t *testing.T) {
	// Clear relevant env vars
	os.Unsetenv("WAREHOUSE_NAME")
	os.Unsetenv("LAKEKEEPER_CATALOG_URL")
	os.Unsetenv("DUCKDB_EXTENSION_DIR")

	cfg := NewCatalogConfigFromEnv()

	if cfg.WarehouseName != "nemo" {
		t.Errorf("expected default warehouse 'nemo', got %q", cfg.WarehouseName)
	}
	if cfg.LakekeeperURL != "http://lakekeeper:8181/catalog" {
		t.Errorf("expected default LakekeeperURL, got %q", cfg.LakekeeperURL)
	}
	if cfg.ExtensionDir != "/opt/duckdb/extensions" {
		t.Errorf("expected default ExtensionDir, got %q", cfg.ExtensionDir)
	}
	if cfg.RefreshMarginSecs != 60 {
		t.Errorf("expected RefreshMarginSecs 60, got %d", cfg.RefreshMarginSecs)
	}
}

func TestNewCatalogConfigFromEnv_Override(t *testing.T) {
	os.Setenv("WAREHOUSE_NAME", "test-warehouse")
	os.Setenv("LAKEKEEPER_CATALOG_URL", "http://test-server/catalog")
	os.Setenv("DUCKDB_EXTENSION_DIR", "/tmp/extensions")
	os.Setenv("KEYCLOAK_TOKEN_URL", "http://keycloak/token")
	os.Setenv("LAKEKEEPER_CLIENT_ID", "client-id")
	os.Setenv("LAKEKEEPER_CLIENT_SECRET", "secret")
	os.Setenv("S3_ENDPOINT", "http://minio:9000")
	defer func() {
		os.Unsetenv("WAREHOUSE_NAME")
		os.Unsetenv("LAKEKEEPER_CATALOG_URL")
		os.Unsetenv("DUCKDB_EXTENSION_DIR")
		os.Unsetenv("KEYCLOAK_TOKEN_URL")
		os.Unsetenv("LAKEKEEPER_CLIENT_ID")
		os.Unsetenv("LAKEKEEPER_CLIENT_SECRET")
		os.Unsetenv("S3_ENDPOINT")
	}()

	cfg := NewCatalogConfigFromEnv()

	if cfg.WarehouseName != "test-warehouse" {
		t.Errorf("expected %q, got %q", "test-warehouse", cfg.WarehouseName)
	}
	if cfg.LakekeeperURL != "http://test-server/catalog" {
		t.Errorf("expected %q, got %q", "http://test-server/catalog", cfg.LakekeeperURL)
	}
	if cfg.ExtensionDir != "/tmp/extensions" {
		t.Errorf("expected %q, got %q", "/tmp/extensions", cfg.ExtensionDir)
	}
	if cfg.KeycloakTokenURL != "http://keycloak/token" {
		t.Errorf("expected %q, got %q", "http://keycloak/token", cfg.KeycloakTokenURL)
	}
	if cfg.ClientID != "client-id" {
		t.Errorf("expected %q, got %q", "client-id", cfg.ClientID)
	}
	if cfg.ClientSecret != "secret" {
		t.Errorf("expected %q, got %q", "secret", cfg.ClientSecret)
	}
	if cfg.S3Endpoint != "http://minio:9000" {
		t.Errorf("expected %q, got %q", "http://minio:9000", cfg.S3Endpoint)
	}
}
