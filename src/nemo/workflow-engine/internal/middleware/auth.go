package middleware

import (
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

	"github.com/gin-gonic/gin"
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

// GetUserClaims extracts user claims from Gin context
func GetUserClaims(c *gin.Context) *UserClaims {
	if claims, exists := c.Get("userClaims"); exists {
		if userClaims, ok := claims.(*UserClaims); ok {
			return userClaims
		}
	}
	return nil
}

// AuthMiddleware validates JWT tokens and extracts user claims (Gin middleware)
// Uses KEYCLOAK_INTERNAL_ISSUER for all JWKS fetching and validation
// Accepts tokens with either internal or external issuer in iss claim (for backward compatibility)
func AuthMiddleware() gin.HandlerFunc {
	// Use internal issuer for all service-to-service communication
	internalIssuer := getKeycloakInternalIssuer()
	if internalIssuer == "" {
		log.Println("WARNING: KEYCLOAK_INTERNAL_ISSUER not set, authentication disabled")
		return func(c *gin.Context) {
			c.Next()
		}
	}

	// Get valid issuers (internal and external for backward compatibility)
	validIssuers := getValidIssuers(internalIssuer)

	return func(c *gin.Context) {
		// Skip auth for public endpoints
		if shouldSkipAuth(c.Request.URL.Path) {
			c.Next()
			return
		}

		// Extract token from Authorization header
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized", "message": "Missing Authorization header"})
			c.Abort()
			return
		}

		// Parse Bearer token
		parts := strings.Split(authHeader, " ")
		if len(parts) != 2 || parts[0] != "Bearer" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized", "message": "Invalid Authorization header format"})
			c.Abort()
			return
		}

		tokenString := parts[1]

		// Parse and validate token
		// Always use internal issuer for JWKS fetching
		claims, err := validateToken(tokenString, internalIssuer, validIssuers)
		if err != nil {
			log.Printf("Token validation failed: %v", err)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Unauthorized", "message": err.Error()})
			c.Abort()
			return
		}

		// Inject user identity headers for service-to-service communication
		if claims.UserID != "" {
			c.Request.Header.Set("X-User-ID", claims.UserID)
		}
		if claims.Email != "" {
			c.Request.Header.Set("X-User-Email", claims.Email)
		}
		if claims.Name != "" {
			c.Request.Header.Set("X-User-Name", claims.Name)
		}
		if claims.ProjectID != "" {
			c.Request.Header.Set("X-Project-ID", claims.ProjectID)
		}

		// Add claims to context
		c.Set("userClaims", claims)
		c.Next()
	}
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

	// Verify issuer - accept any of the valid issuers (normalize trailing slash / whitespace)
	tokenIss := normalizeIssuerURL(claims.Issuer)
	issuerValid := false
	for _, validIssuer := range validIssuers {
		if tokenIss == validIssuer {
			issuerValid = true
			break
		}
	}

	if !issuerValid {
		return nil, fmt.Errorf("invalid issuer: %s (expected one of: %v)", claims.Issuer, validIssuers)
	}

	return claims, nil
}

// shouldSkipAuth checks if authentication should be skipped for a path.
// Internal-only endpoints (health checks, progress store) are exempted.
func shouldSkipAuth(path string) bool {
	publicPaths := []string{
		"/health",
		"/ready",
	}

	for _, publicPath := range publicPaths {
		if path == publicPath {
			return true
		}
	}

	// Progress store endpoints are internal-only (activity self-calls and
	// config-service polling). They don't carry user JWTs.
	if strings.HasPrefix(path, "/api/v1/workflows/") && strings.HasSuffix(path, "/progress") {
		return true
	}

	return false
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

func normalizeIssuerURL(s string) string {
	s = strings.TrimSpace(s)
	return strings.TrimSuffix(s, "/")
}

// getValidIssuers returns a list of valid issuer URLs that tokens might have
// This includes both internal and external issuers for backward compatibility
func getValidIssuers(internalIssuer string) []string {
	validIssuers := []string{normalizeIssuerURL(internalIssuer)}

	// Browser / gateway tokens use iss = KEYCLOAK_ISSUER (public auth URL); JWKS still comes from internal Keycloak.
	externalIssuer := os.Getenv("KEYCLOAK_ISSUER")
	if ext := normalizeIssuerURL(externalIssuer); ext != "" && ext != validIssuers[0] {
		validIssuers = append(validIssuers, ext)
	}

	return validIssuers
}
