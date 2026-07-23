package middleware

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// UserClaims represents the JWT claims extracted from the token
type UserClaims struct {
	UserID      string `json:"sub"`
	Email       string `json:"email"`
	Username    string `json:"preferred_username"`
	Name        string `json:"name"`
	ProjectID   string `json:"agentstudio.project_id,omitempty"`
	WorkspaceID string `json:"agentstudio.workspace_id,omitempty"`
	NamespaceID string `json:"agentstudio.namespace_id,omitempty"`
	jwt.RegisteredClaims
}

// Context key for user claims
type contextKey string

const userClaimsKey contextKey = "userClaims"

// GetUserClaims extracts user claims from request context
func GetUserClaims(r *http.Request) *UserClaims {
	if claims, ok := r.Context().Value(userClaimsKey).(*UserClaims); ok {
		return claims
	}
	return nil
}

// JWKS represents the JSON Web Key Set
type JWKS struct {
	Keys []JWK `json:"keys"`
}

type JWK struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKSCache caches JWKS with TTL
type JWKSCache struct {
	mu        sync.RWMutex
	jwks      *JWKS
	expiresAt time.Time
	ttl       time.Duration
}

var jwksCache = &JWKSCache{
	ttl: 1 * time.Hour, // Cache JWKS for 1 hour
}

// getJWKS fetches JWKS from Keycloak and caches it
func (c *JWKSCache) getJWKS(issuer string) (*JWKS, error) {
	c.mu.RLock()
	if c.jwks != nil && time.Now().Before(c.expiresAt) {
		jwks := c.jwks
		c.mu.RUnlock()
		return jwks, nil
	}
	c.mu.RUnlock()

	// Fetch JWKS from Keycloak (format: /realms/{realm}/protocol/openid-connect/certs)
	jwksURL := fmt.Sprintf("%s/protocol/openid-connect/certs", issuer)
	resp, err := http.Get(jwksURL)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to fetch JWKS: status %d", resp.StatusCode)
	}

	var jwks JWKS
	if err := json.NewDecoder(resp.Body).Decode(&jwks); err != nil {
		return nil, fmt.Errorf("failed to decode JWKS: %w", err)
	}

	// Cache the JWKS
	c.mu.Lock()
	c.jwks = &jwks
	c.expiresAt = time.Now().Add(c.ttl)
	c.mu.Unlock()

	return &jwks, nil
}

// getPublicKey converts JWK to RSA public key
func (jwk *JWK) getPublicKey() (*rsa.PublicKey, error) {
	if jwk.Kty != "RSA" {
		return nil, fmt.Errorf("unsupported key type: %s", jwk.Kty)
	}

	// Decode base64url encoded modulus and exponent
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, fmt.Errorf("failed to decode modulus: %w", err)
	}

	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return nil, fmt.Errorf("failed to decode exponent: %w", err)
	}

	// Convert exponent bytes to int
	var eInt int
	for _, b := range eBytes {
		eInt = eInt<<8 | int(b)
	}

	// Create RSA public key
	pubKey := &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: eInt,
	}

	return pubKey, nil
}

// AuthMiddleware validates JWT tokens and extracts user claims
// Uses KEYCLOAK_INTERNAL_ISSUER for all JWKS fetching and validation
// Accepts tokens with either internal or external issuer in iss claim (for backward compatibility)
func AuthMiddleware(next http.Handler) http.Handler {
	// Use internal issuer for all service-to-service communication
	internalIssuer := getKeycloakInternalIssuer()
	if internalIssuer == "" {
		log.Println("WARNING: KEYCLOAK_INTERNAL_ISSUER not set, authentication disabled")
		return next
	}

	// Get external issuer for backward compatibility (accept tokens with either issuer)
	externalIssuer := getKeycloakIssuer()
	validIssuers := []string{internalIssuer}
	if externalIssuer != "" && externalIssuer != internalIssuer {
		validIssuers = append(validIssuers, externalIssuer)
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for public endpoints
		if shouldSkipAuth(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		// Extract token from Authorization header
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"Unauthorized","message":"Missing Authorization header"}`, http.StatusUnauthorized)
			return
		}

		// Parse Bearer token
		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || parts[0] != "Bearer" {
			http.Error(w, `{"error":"Unauthorized","message":"Invalid Authorization header format"}`, http.StatusUnauthorized)
			return
		}

		tokenString := parts[1]

		// Parse and validate token
		// Always use internal issuer for JWKS fetching
		claims, err := validateToken(tokenString, internalIssuer, validIssuers)
		if err != nil {
			log.Printf("Token validation failed: %v", err)
			http.Error(w, fmt.Sprintf(`{"error":"Unauthorized","message":"%s"}`, err.Error()), http.StatusUnauthorized)
			return
		}

		// Inject user identity headers for service-to-service communication
		if claims.UserID != "" {
			r.Header.Set("X-User-ID", claims.UserID)
		}
		if claims.Email != "" {
			r.Header.Set("X-User-Email", claims.Email)
		}
		if claims.Name != "" {
			r.Header.Set("X-User-Name", claims.Name)
		}
		if claims.ProjectID != "" {
			r.Header.Set("X-Project-ID", claims.ProjectID)
		}

		// Add claims to request context
		ctx := context.WithValue(r.Context(), userClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// validateToken validates a JWT token and returns the claims
// jwksIssuer is used for JWKS fetching (always internal service URL)
// validIssuers is a list of acceptable issuer values from the token's iss claim
func validateToken(tokenString, jwksIssuer string, validIssuers []string) (*UserClaims, error) {
	// Parse token without validation to get the kid
	token, err := jwt.ParseWithClaims(tokenString, &UserClaims{}, func(token *jwt.Token) (interface{}, error) {
		// Verify signing method
		if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}

		// Get kid from token header
		kid, ok := token.Header["kid"].(string)
		if !ok {
			return nil, fmt.Errorf("missing kid in token header")
		}

		// Get JWKS using the internal issuer URL
		jwks, err := jwksCache.getJWKS(jwksIssuer)
		if err != nil {
			return nil, fmt.Errorf("failed to get JWKS: %w", err)
		}

		// Find the key with matching kid
		var jwk *JWK
		for i := range jwks.Keys {
			if jwks.Keys[i].Kid == kid {
				jwk = &jwks.Keys[i]
				break
			}
		}

		if jwk == nil {
			return nil, fmt.Errorf("key not found for kid: %s", kid)
		}

		// Convert JWK to public key
		return jwk.getPublicKey()
	}, jwt.WithValidMethods([]string{"RS256"}))

	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	claims, ok := token.Claims.(*UserClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	// Verify issuer - accept any of the valid issuers (internal or external)
	issuerValid := false
	for _, validIssuer := range validIssuers {
		if claims.Issuer == validIssuer {
			issuerValid = true
			break
		}
	}

	if !issuerValid {
		return nil, fmt.Errorf("invalid issuer: %s (expected one of: %v)", claims.Issuer, validIssuers)
	}

	return claims, nil
}

// shouldSkipAuth checks if authentication should be skipped for a path
func shouldSkipAuth(path string) bool {
	publicPaths := []string{
		"/health",
		"/ready",
		"/metrics",
	}

	for _, publicPath := range publicPaths {
		if path == publicPath {
			return true
		}
	}

	return false
}

// getKeycloakIssuer returns the external Keycloak issuer URL from environment
// This is only used for backward compatibility (accepting tokens with external issuer)
// Keycloak issuer format: https://auth.agentstudio.local/realms/nemo
func getKeycloakIssuer() string {
	issuer := os.Getenv("KEYCLOAK_ISSUER")
	if issuer == "" {
		return ""
	}
	// Keycloak issuer already includes /realms/{realm}, return as-is
	return issuer
}

// getKeycloakInternalIssuer returns the internal Keycloak issuer URL from environment
// This should be the internal Kubernetes service URL (e.g., http://keycloak.agentstudio-identity.svc.cluster.local:8080/realms/nemo)
// Used for all JWKS fetching and token validation (service-to-service)
func getKeycloakInternalIssuer() string {
	internalIssuer := os.Getenv("KEYCLOAK_INTERNAL_ISSUER")
	if internalIssuer == "" {
		return ""
	}
	// Internal issuer already includes /realms/{realm}, return as-is
	return internalIssuer
}
