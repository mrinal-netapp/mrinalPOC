// agent-studio-grafana-proxy sits in front of Grafana and handles:
//   - OIDC authorization-code flow (Keycloak `agentstudio-grafana-proxy` client)
//   - Project membership fetch from config-service after login
//   - Session caching (encrypted cookie)
//   - Header injection for Grafana auth.proxy (X-WEBAUTH-USER / ROLE / EMAIL / NAME)
//   - GET /.auth/projects endpoint for the Infinity datasource $project variable
//
// Environment variables (all required unless noted):
//
//	KEYCLOAK_ISSUER            Internal/backchannel URL for server-side token exchange.
//	                           e.g. http://keycloak.agent-studio-identity.svc.cluster.local:8080/realms/nemo
//	KEYCLOAK_PUBLIC_ISSUER     (optional) Browser-facing HTTPS URL for the authorization redirect.
//	                           Must be the external HTTPS hostname so Keycloak sets Secure cookies.
//	                           e.g. https://auth.agentstudio.local:8443/realms/nemo
//	                           Defaults to KEYCLOAK_ISSUER when unset.
//	KEYCLOAK_CLIENT_ID         agentstudio-grafana-proxy
//	KEYCLOAK_CLIENT_SECRET     (from K8s Secret)
//	KEYCLOAK_REDIRECT_URI      e.g. https://grafana.agentstudio.local:8443/oauth2/callback
//	CONFIG_SERVICE_URL         e.g. http://config-service.agentstudio.svc.cluster.local:8080
//	GRAFANA_UPSTREAM_URL       e.g. http://prometheus-grafana.monitoring.svc.cluster.local:80
//	SESSION_HASH_KEY           hex or raw bytes for gorilla/securecookie HMAC (min 32 bytes)
//	SESSION_BLOCK_KEY          hex or raw bytes for AES encryption (16, 24 or 32 bytes)
//	LISTEN_ADDR                (optional) default :8080
//	SESSION_TTL_HOURS          (optional) default 8
//	PROJECT_CACHE_TTL_SECONDS  (optional) default 300
//	PLATFORM_ADMIN_ROLE        (optional) default platform-admin
//	TLS_SKIP_VERIFY            (optional) set to "true" for local dev with self-signed certs
package main

import (
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"agentstudio/nemo/observability/grafana-proxy/internal/proxy"
)

func main() {
	cfg := proxy.Config{
		KeycloakIssuer:       mustEnv("KEYCLOAK_ISSUER"),
		KeycloakPublicIssuer: os.Getenv("KEYCLOAK_PUBLIC_ISSUER"), // optional
		ClientID:             mustEnv("KEYCLOAK_CLIENT_ID"),
		ClientSecret:         mustEnv("KEYCLOAK_CLIENT_SECRET"),
		RedirectURI:          mustEnv("KEYCLOAK_REDIRECT_URI"),
		ConfigServiceURL:     mustEnv("CONFIG_SERVICE_URL"),
		GrafanaUpstreamURL:   mustEnv("GRAFANA_UPSTREAM_URL"),
		SessionHashKey:       mustHashKeyBytes("SESSION_HASH_KEY"),
		SessionBlockKey:      mustBlockKeyBytes("SESSION_BLOCK_KEY"),
		PlatformAdminRole:    envOrDefault("PLATFORM_ADMIN_ROLE", "platform-admin"),
		TLSSkipVerify:        os.Getenv("TLS_SKIP_VERIFY") == "true",
		SessionTTL:           parseDurationHours("SESSION_TTL_HOURS", 8),
		ProjectCacheTTL:      parseDurationSeconds("PROJECT_CACHE_TTL_SECONDS", 300),
		// Shared secret for prometheus-proxy → /.internal/projects.
		// Required when prometheus-proxy is deployed alongside grafana-proxy.
		InternalToken: mustEnv("INTERNAL_TOKEN"),
	}

	srv, err := proxy.New(cfg)
	if err != nil {
		log.Fatalf("grafana-proxy: init failed: %v", err)
	}

	addr := envOrDefault("LISTEN_ADDR", ":8080")
	log.Printf("grafana-proxy: listening on %s", addr)
	log.Printf("grafana-proxy: upstream grafana    = %s", cfg.GrafanaUpstreamURL)
	log.Printf("grafana-proxy: keycloak issuer     = %s", cfg.KeycloakIssuer)
	if cfg.KeycloakPublicIssuer != "" {
		log.Printf("grafana-proxy: keycloak public     = %s", cfg.KeycloakPublicIssuer)
	}

	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      srv.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("grafana-proxy: server error: %v", err)
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("grafana-proxy: required env %s is not set", key)
	}
	return v
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// mustHashKeyBytes parses SESSION_HASH_KEY.  HMAC-SHA256 requires at least
// 32 bytes; shorter keys are rejected at startup.
func mustHashKeyBytes(key string) []byte {
	v := mustEnv(key)
	if decoded, err := hex.DecodeString(v); err == nil {
		if len(decoded) < 32 {
			log.Fatalf("grafana-proxy: %s decoded to %d bytes — must be at least 32 for HMAC-SHA256", key, len(decoded))
		}
		return decoded
	}
	b := []byte(v)
	if len(b) < 32 {
		log.Fatalf("grafana-proxy: %s is %d bytes — must be at least 32 for HMAC-SHA256", key, len(b))
	}
	return b
}

// mustBlockKeyBytes parses SESSION_BLOCK_KEY.  AES requires exactly 16, 24, or
// 32 bytes; any other size is rejected at startup.
func mustBlockKeyBytes(key string) []byte {
	v := mustEnv(key)
	if decoded, err := hex.DecodeString(v); err == nil {
		if decoded == nil || (len(decoded) != 16 && len(decoded) != 24 && len(decoded) != 32) {
			log.Fatalf("grafana-proxy: %s decoded to %d bytes — must be exactly 16, 24, or 32 for AES", key, len(decoded))
		}
		return decoded
	}
	b := []byte(v)
	if len(b) != 16 && len(b) != 24 && len(b) != 32 {
		log.Fatalf("grafana-proxy: %s is %d bytes — must be exactly 16, 24, or 32 for AES", key, len(b))
	}
	return b
}

func parseDurationHours(key string, defaultHours int) time.Duration {
	if v := os.Getenv(key); v != "" {
		if h, err := strconv.Atoi(v); err == nil && h > 0 {
			return time.Duration(h) * time.Hour
		}
	}
	return time.Duration(defaultHours) * time.Hour
}

func parseDurationSeconds(key string, defaultSeconds int) time.Duration {
	if v := os.Getenv(key); v != "" {
		if s, err := strconv.Atoi(v); err == nil && s > 0 {
			return time.Duration(s) * time.Second
		}
	}
	return time.Duration(defaultSeconds) * time.Second
}
