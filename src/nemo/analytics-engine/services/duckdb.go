package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"agentstudio/nemo/analytics-engine/utils"

	duckdb "github.com/duckdb/duckdb-go/v2"
)

// CatalogConfig holds Iceberg catalog connection settings from environment.
type CatalogConfig struct {
	WarehouseName     string
	LakekeeperURL     string
	KeycloakTokenURL  string
	ClientID          string
	ClientSecret      string
	ExtensionDir      string
	RefreshMarginSecs int
	S3Endpoint        string
	S3AccessKey       string
	S3SecretKey       string
}

func NewCatalogConfigFromEnv() *CatalogConfig {
	margin := 60
	return &CatalogConfig{
		WarehouseName:     getEnvOr("WAREHOUSE_NAME", "nemo"),
		LakekeeperURL:     getEnvOr("LAKEKEEPER_CATALOG_URL", "http://lakekeeper:8181/catalog"),
		KeycloakTokenURL:  os.Getenv("KEYCLOAK_TOKEN_URL"),
		ClientID:          os.Getenv("LAKEKEEPER_CLIENT_ID"),
		ClientSecret:      os.Getenv("LAKEKEEPER_CLIENT_SECRET"),
		ExtensionDir:      getEnvOr("DUCKDB_EXTENSION_DIR", "/opt/duckdb/extensions"),
		RefreshMarginSecs: margin,
		S3Endpoint:        os.Getenv("S3_ENDPOINT"),
		S3AccessKey:       os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:       os.Getenv("S3_SECRET_KEY"),
	}
}

func getEnvOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DuckDBManager wraps an in-process DuckDB with catalog attach and token refresh.
type DuckDBManager struct {
	mu              sync.Mutex
	connector       *duckdb.Connector
	db              *sql.DB
	arrowConn       *duckdb.Conn
	catalogAttached bool
	tokenFetchedAt  time.Time
	tokenLifetime   int
	lifetimeProbed  bool
	refreshTimer    *time.Timer
	cfg             *CatalogConfig
}

// NewDuckDBManager creates and initialises the in-process DuckDB instance.
func NewDuckDBManager(cfg *CatalogConfig) (*DuckDBManager, error) {
	c, err := duckdb.NewConnector("", func(execer driver.ExecerContext) error {
		bootQueries := []string{
			fmt.Sprintf("SET extension_directory='%s'", cfg.ExtensionDir),
			"SET autoinstall_known_extensions=false",
			"LOAD avro",
			"LOAD iceberg",
			"LOAD httpfs",
		}
		if cfg.S3Endpoint != "" {
			host := cfg.S3Endpoint
			host = strings.TrimPrefix(host, "http://")
			host = strings.TrimPrefix(host, "https://")
			bootQueries = append(bootQueries,
				fmt.Sprintf("SET s3_endpoint='%s'", host),
				fmt.Sprintf("SET s3_access_key_id='%s'", cfg.S3AccessKey),
				fmt.Sprintf("SET s3_secret_access_key='%s'", cfg.S3SecretKey),
				"SET s3_url_style='path'",
				"SET s3_use_ssl=false",
			)
		}
		for _, q := range bootQueries {
			if _, err := execer.ExecContext(context.Background(), q, nil); err != nil {
				return fmt.Errorf("boot query %q: %w", q, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create DuckDB connector: %w", err)
	}

	db := sql.OpenDB(c)
	db.SetMaxOpenConns(1)

	rawConn, err := c.Connect(context.Background())
	if err != nil {
		db.Close()
		c.Close()
		return nil, fmt.Errorf("failed to create Arrow connection: %w", err)
	}
	arrowConn, ok := rawConn.(*duckdb.Conn)
	if !ok {
		rawConn.Close()
		db.Close()
		c.Close()
		return nil, fmt.Errorf("unexpected connection type: %T", rawConn)
	}

	m := &DuckDBManager{
		connector:     c,
		db:            db,
		arrowConn:     arrowConn,
		tokenLifetime: 300,
		cfg:           cfg,
	}

	return m, nil
}

// Init attaches the Iceberg catalog if credentials are configured.
// If the initial attach fails (e.g. Keycloak not yet ready), it schedules
// background retries so the service can start and serve non-catalog queries.
func (m *DuckDBManager) Init() {
	if m.cfg.ClientID == "" || m.cfg.ClientSecret == "" {
		utils.Info("No Lakekeeper credentials configured; skipping catalog attach")
		return
	}
	m.mu.Lock()
	err := m.attachCatalog()
	m.mu.Unlock()
	if err != nil {
		utils.Warn("Initial catalog attach failed (will retry in background): %v", err)
		m.scheduleRefresh(10)
	}
}

// Close shuts down the DuckDB manager.
func (m *DuckDBManager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.refreshTimer != nil {
		m.refreshTimer.Stop()
	}
	if m.arrowConn != nil {
		m.arrowConn.Close()
	}
	if m.db != nil {
		m.db.Close()
	}
	if m.connector != nil {
		m.connector.Close()
	}
	utils.Info("DuckDB manager closed")
}

// QueryContext executes a query and returns *sql.Rows (for JSON response path).
func (m *DuckDBManager) QueryContext(ctx context.Context, query string) (*sql.Rows, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureFresh()
	return m.db.QueryContext(ctx, query)
}

// WithArrowConn calls fn while holding the mutex with a fresh catalog.
// The handler uses this to create duckdb.NewArrowFromConn and query.
func (m *DuckDBManager) WithArrowConn(fn func(conn *duckdb.Conn) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureFresh()
	return fn(m.arrowConn)
}

// ExecContext executes DDL/DML (for uploads, table creation, etc.).
func (m *DuckDBManager) ExecContext(ctx context.Context, query string) (sql.Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ensureFresh()
	return m.db.ExecContext(ctx, query)
}

// QueryWithCountContext runs a COUNT query followed by a data query after a
// single ensureFresh() call. The mutex only protects the token refresh check;
// actual query serialization is guaranteed by SetMaxOpenConns(1) on the pool.
// Accepted risk: another goroutine could refresh the catalog between COUNT and
// SELECT, but the token refresh margin (default 60s) makes this negligible.
func (m *DuckDBManager) QueryWithCountContext(
	ctx context.Context,
	countSQL string, countArgs []interface{},
	dataSQL string, dataArgs []interface{},
) (totalCount int64, rows *sql.Rows, err error) {
	m.mu.Lock()
	m.ensureFresh()
	m.mu.Unlock()

	// countSQL/dataSQL are pre-built by the caller with identifiers escaped
	// and values passed separately as countArgs/dataArgs placeholders; a
	// single runCount/runData closure (rather than a duplicated call at each
	// retry site) keeps that query execution to one source location.
	runCount := func() error {
		return m.db.QueryRowContext(ctx, countSQL, countArgs...).Scan(&totalCount)
	}
	if err = runCount(); err != nil && isAuthError(err) {
		m.mu.Lock()
		refreshErr := m.attachCatalog()
		m.mu.Unlock()
		if refreshErr != nil {
			return 0, nil, fmt.Errorf("count query: catalog refresh failed after auth error: %w", refreshErr)
		}
		err = runCount()
	}
	if err != nil {
		return 0, nil, fmt.Errorf("count query: %w", err)
	}

	runData := func() (*sql.Rows, error) {
		return m.db.QueryContext(ctx, dataSQL, dataArgs...)
	}
	rows, err = runData()
	if err != nil && isAuthError(err) {
		m.mu.Lock()
		refreshErr := m.attachCatalog()
		m.mu.Unlock()
		if refreshErr != nil {
			return totalCount, nil, fmt.Errorf("data query: catalog refresh failed after auth error: %w", refreshErr)
		}
		rows, err = runData()
	}
	return totalCount, rows, err
}

// QueryRowContext executes a query expected to return a single row.
func (m *DuckDBManager) QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row {
	m.mu.Lock()
	m.ensureFresh()
	m.mu.Unlock()
	return m.db.QueryRowContext(ctx, query, args...)
}

// QueryContextArgs executes a parameterized query and returns *sql.Rows.
func (m *DuckDBManager) QueryContextArgs(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error) {
	m.mu.Lock()
	m.ensureFresh()
	m.mu.Unlock()
	// query is pre-built by the caller with identifiers escaped and values
	// passed separately via args placeholders; a single run() closure keeps
	// that query execution to one source location instead of duplicating it
	// at the retry call site.
	run := func() (*sql.Rows, error) {
		return m.db.QueryContext(ctx, query, args...)
	}
	rows, err := run()
	if err != nil && isAuthError(err) {
		utils.Warn("Auth error on parameterized query, refreshing token and retrying: %v", err)
		m.mu.Lock()
		refreshErr := m.attachCatalog()
		m.mu.Unlock()
		if refreshErr != nil {
			return nil, fmt.Errorf("catalog refresh failed after auth error: %w", refreshErr)
		}
		return run()
	}
	return rows, err
}

// DB returns the underlying *sql.DB for direct access when needed.
func (m *DuckDBManager) DB() *sql.DB {
	return m.db
}

// QueryContextWithRetry executes a query with a single retry on catalog auth errors.
// This implements the reactive 401 retry (layer 3) that the Python MCP server has
// but was missing in the Go engine.
func (m *DuckDBManager) QueryContextWithRetry(ctx context.Context, query string) (*sql.Rows, error) {
	m.mu.Lock()
	m.ensureFresh()
	m.mu.Unlock()

	rows, err := m.db.QueryContext(ctx, query)
	if err != nil && isAuthError(err) {
		utils.Warn("Auth error on query, refreshing token and retrying: %v", err)
		m.mu.Lock()
		refreshErr := m.attachCatalog()
		m.mu.Unlock()
		if refreshErr != nil {
			return nil, fmt.Errorf("catalog refresh failed after auth error: %w", refreshErr)
		}
		return m.db.QueryContext(ctx, query)
	}
	return rows, err
}

func isAuthError(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "401") || strings.Contains(msg, "unauthorized")
}

// --- Token refresh (2-layer, matching Python MCP server) ---

func (m *DuckDBManager) ensureFresh() {
	if m.cfg.ClientID == "" || !m.catalogAttached {
		return
	}
	remaining := m.tokenRemaining()
	if remaining < float64(m.cfg.RefreshMarginSecs) {
		utils.Info("Pre-query refresh (token has %.0fs left)", remaining)
		if err := m.attachCatalog(); err != nil {
			utils.Error("Pre-query catalog refresh failed: %v", err)
		}
	}
}

func (m *DuckDBManager) tokenRemaining() float64 {
	elapsed := time.Since(m.tokenFetchedAt).Seconds()
	return float64(m.tokenLifetime) - elapsed
}

func (m *DuckDBManager) attachCatalog() error {
	if m.catalogAttached {
		if _, err := m.db.ExecContext(context.Background(), "DETACH iceberg"); err != nil {
			utils.Warn("DETACH iceberg failed (may not exist): %v", err)
		}
		m.catalogAttached = false
	}

	if _, err := m.db.ExecContext(context.Background(), "DROP SECRET IF EXISTS lakekeeper_secret"); err != nil {
		utils.Warn("DROP SECRET failed: %v", err)
	}

	// Fetch the OAuth2 token ourselves (Go net/http) rather than letting
	// DuckDB's internal HTTP client do it -- DuckDB's iceberg extension
	// fails with "No message available" in some Kubernetes environments.
	token, lifetime, err := m.fetchToken()
	if err != nil {
		return fmt.Errorf("failed to fetch OAuth2 token: %w", err)
	}

	createSecret := fmt.Sprintf(
		"CREATE SECRET lakekeeper_secret (TYPE ICEBERG, TOKEN '%s')",
		escapeSQLString(token),
	)
	if _, err := m.db.ExecContext(context.Background(), createSecret); err != nil {
		return fmt.Errorf("CREATE SECRET failed: %w", err)
	}

	attach := fmt.Sprintf(
		"ATTACH '%s' AS iceberg (TYPE ICEBERG, ENDPOINT '%s', SECRET lakekeeper_secret, SUPPORT_NESTED_NAMESPACES true)",
		escapeSQLString(m.cfg.WarehouseName),
		escapeSQLString(m.cfg.LakekeeperURL),
	)
	if _, err := m.db.ExecContext(context.Background(), attach); err != nil {
		return fmt.Errorf("ATTACH catalog failed: %w", err)
	}
	m.catalogAttached = true

	m.tokenLifetime = lifetime
	m.tokenFetchedAt = time.Now()

	refreshIn := lifetime - m.cfg.RefreshMarginSecs
	if refreshIn < 30 {
		refreshIn = 30
	}
	utils.Info("Catalog attached (token valid %ds, next refresh in %ds)", lifetime, refreshIn)
	m.scheduleRefresh(refreshIn)

	return nil
}

// fetchToken obtains an OAuth2 access token from Keycloak using Go's net/http.
// Returns (access_token, expires_in_seconds, error).
func (m *DuckDBManager) fetchToken() (string, int, error) {
	if m.cfg.KeycloakTokenURL == "" {
		return "", 0, fmt.Errorf("KEYCLOAK_TOKEN_URL not configured")
	}

	params := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {m.cfg.ClientID},
		"client_secret": {m.cfg.ClientSecret},
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.PostForm(m.cfg.KeycloakTokenURL, params)
	if err != nil {
		return "", 0, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("token endpoint returned HTTP %d", resp.StatusCode)
	}

	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", 0, fmt.Errorf("failed to parse token response: %w", err)
	}
	if body.AccessToken == "" {
		return "", 0, fmt.Errorf("token response missing access_token")
	}

	lifetime := body.ExpiresIn
	if lifetime <= 0 {
		lifetime = 300
	}
	utils.Info("OAuth2 token fetched (expires in %ds)", lifetime)
	return body.AccessToken, lifetime, nil
}

func (m *DuckDBManager) scheduleRefresh(delaySecs int) {
	if m.refreshTimer != nil {
		m.refreshTimer.Stop()
	}
	m.refreshTimer = time.AfterFunc(time.Duration(delaySecs)*time.Second, m.backgroundRefresh)
}

func (m *DuckDBManager) backgroundRefresh() {
	m.mu.Lock()
	defer m.mu.Unlock()

	remaining := m.tokenRemaining()
	if remaining > float64(m.cfg.RefreshMarginSecs) {
		delay := int(remaining) - m.cfg.RefreshMarginSecs
		if delay < 30 {
			delay = 30
		}
		m.scheduleRefresh(delay)
		return
	}

	utils.Info("Background token refresh starting")
	if err := m.attachCatalog(); err != nil {
		utils.Error("Background refresh failed: %v; retrying in 30s", err)
		m.scheduleRefresh(30)
		return
	}
	utils.Info("Background token refresh completed")
}

func escapeSQLString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// InstallExtensions is a one-shot mode used during Docker build to pre-install extensions.
func InstallExtensions() error {
	extDir := getEnvOr("DUCKDB_EXTENSION_DIR", "/opt/duckdb/extensions")

	db, err := sql.Open("duckdb", "")
	if err != nil {
		return fmt.Errorf("failed to open DuckDB: %w", err)
	}
	defer db.Close()

	queries := []string{
		fmt.Sprintf("SET extension_directory='%s'", extDir),
		"INSTALL avro",
		"INSTALL iceberg",
		"INSTALL httpfs",
		"INSTALL json",
	}
	for _, q := range queries {
		utils.Info("Extension install: %s", q)
		if _, err := db.ExecContext(context.Background(), q); err != nil {
			return fmt.Errorf("extension install %q failed: %w", q, err)
		}
	}

	utils.Info("Extensions installed to %s", extDir)
	return nil
}
