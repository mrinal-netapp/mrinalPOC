package middleware

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// --- shouldSkipAuth ---

func TestShouldSkipAuth_PublicPaths(t *testing.T) {
	publicPaths := []string{"/health", "/ready", "/metrics"}
	for _, p := range publicPaths {
		if !shouldSkipAuth(p) {
			t.Errorf("expected shouldSkipAuth(%q) = true", p)
		}
	}
}

func TestShouldSkipAuth_PrivatePaths(t *testing.T) {
	privatePaths := []string{"/api/query", "/api/v1/agent/query", "/", "/healthz"}
	for _, p := range privatePaths {
		if shouldSkipAuth(p) {
			t.Errorf("expected shouldSkipAuth(%q) = false", p)
		}
	}
}

// --- GetUserClaims ---

func TestGetUserClaims_NoContext(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if GetUserClaims(req) != nil {
		t.Error("expected nil when no claims in context")
	}
}

func TestGetUserClaims_WithClaims(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	claims := &UserClaims{UserID: "user-1", ProjectID: "proj-1"}
	ctx := context.WithValue(req.Context(), userClaimsKey, claims)
	req = req.WithContext(ctx)
	got := GetUserClaims(req)
	if got == nil {
		t.Fatal("expected non-nil claims")
	}
	if got.UserID != "user-1" {
		t.Errorf("expected UserID %q, got %q", "user-1", got.UserID)
	}
	if got.ProjectID != "proj-1" {
		t.Errorf("expected ProjectID %q, got %q", "proj-1", got.ProjectID)
	}
}

// --- getPublicKey ---

func TestGetPublicKey_ValidRSA(t *testing.T) {
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	n := base64.RawURLEncoding.EncodeToString(privKey.PublicKey.N.Bytes())
	e := encodeExponent(privKey.PublicKey.E)

	jwk := &JWK{Kty: "RSA", N: n, E: e}
	pubKey, err := jwk.getPublicKey()
	if err != nil {
		t.Fatalf("getPublicKey: %v", err)
	}
	if pubKey.E != privKey.PublicKey.E {
		t.Errorf("exponent mismatch: got %d, want %d", pubKey.E, privKey.PublicKey.E)
	}
}

func TestGetPublicKey_WrongKeyType(t *testing.T) {
	jwk := &JWK{Kty: "EC", N: "abc", E: "AQAB"}
	_, err := jwk.getPublicKey()
	if err == nil {
		t.Error("expected error for non-RSA key type")
	}
}

func TestGetPublicKey_InvalidBase64N(t *testing.T) {
	jwk := &JWK{Kty: "RSA", N: "!!!not-base64!!!", E: "AQAB"}
	_, err := jwk.getPublicKey()
	if err == nil {
		t.Error("expected error for invalid base64 modulus")
	}
}

func TestGetPublicKey_InvalidBase64E(t *testing.T) {
	privKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	n := base64.RawURLEncoding.EncodeToString(privKey.PublicKey.N.Bytes())
	jwk := &JWK{Kty: "RSA", N: n, E: "!!!not-base64!!!"}
	_, err := jwk.getPublicKey()
	if err == nil {
		t.Error("expected error for invalid base64 exponent")
	}
}

// --- AuthMiddleware ---

func TestAuthMiddleware_Disabled(t *testing.T) {
	// When KEYCLOAK_INTERNAL_ISSUER is unset, auth is disabled (pass-through)
	os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
	os.Unsetenv("KEYCLOAK_ISSUER")

	called := false
	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if !called {
		t.Error("expected handler to be called when auth is disabled")
	}
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestAuthMiddleware_SkipsPublicPaths(t *testing.T) {
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://keycloak/realms/test")
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	for _, path := range []string{"/health", "/ready", "/metrics"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Errorf("expected 200 for public path %q, got %d", path, rr.Code)
		}
	}
}

func TestAuthMiddleware_MissingAuthHeader(t *testing.T) {
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://keycloak/realms/test")
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing auth header, got %d", rr.Code)
	}
}

func TestAuthMiddleware_InvalidAuthHeaderFormat(t *testing.T) {
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://keycloak/realms/test")
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	req.Header.Set("Authorization", "InvalidFormat")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for invalid auth format, got %d", rr.Code)
	}
}

func TestAuthMiddleware_InvalidToken(t *testing.T) {
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://keycloak/realms/test")
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	req.Header.Set("Authorization", "Bearer notavalidtoken")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for invalid token, got %d", rr.Code)
	}
}

func TestAuthMiddleware_ValidToken(t *testing.T) {
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	// Set up a mock JWKS server
	kid := "test-key-id"
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/certs") {
			jwks := buildJWKS(kid, &privKey.PublicKey)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(jwks)
			return
		}
		http.NotFound(w, r)
	}))
	defer jwksServer.Close()

	issuer := jwksServer.URL + "/realms/test"
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
	os.Unsetenv("KEYCLOAK_ISSUER")

	// Reset the global JWKS cache so it fetches fresh; restore on cleanup.
	jwksCache.mu.Lock()
	savedJWKS, savedExpiry := jwksCache.jwks, jwksCache.expiresAt
	jwksCache.jwks = nil
	jwksCache.expiresAt = time.Time{}
	jwksCache.mu.Unlock()
	t.Cleanup(func() {
		jwksCache.mu.Lock()
		jwksCache.jwks, jwksCache.expiresAt = savedJWKS, savedExpiry
		jwksCache.mu.Unlock()
	})

	token := buildJWT(t, privKey, kid, issuer, "user-123", "proj-abc", time.Now().Add(time.Hour))

	handler := AuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := GetUserClaims(r)
		if claims == nil {
			http.Error(w, "no claims", http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Test-UserID", claims.UserID)
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for valid token, got %d: %s", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("X-Test-UserID") != "user-123" {
		t.Errorf("expected X-Test-UserID header to be set, got %q", rr.Header().Get("X-Test-UserID"))
	}
}

// --- JWKSCache ---

func TestJWKSCache_Hit(t *testing.T) {
	cache := &JWKSCache{ttl: time.Hour}
	testJWKS := &JWKS{Keys: []JWK{{Kty: "RSA", Kid: "k1"}}}
	cache.mu.Lock()
	cache.jwks = testJWKS
	cache.expiresAt = time.Now().Add(time.Hour)
	cache.mu.Unlock()

	// Should return cached JWKS without hitting network
	got, err := cache.getJWKS("http://should-not-be-called")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Keys) != 1 || got.Keys[0].Kid != "k1" {
		t.Error("expected cached JWKS to be returned")
	}
}

func TestJWKSCache_Miss_ServerError(t *testing.T) {
	cache := &JWKSCache{ttl: time.Hour}
	// Cache is empty

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "server error", http.StatusInternalServerError)
	}))
	defer server.Close()

	_, err := cache.getJWKS(server.URL)
	if err == nil {
		t.Error("expected error when server returns 500")
	}
}

func TestJWKSCache_Miss_ValidServer(t *testing.T) {
	privKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jwks := buildJWKS("kid1", &privKey.PublicKey)
		json.NewEncoder(w).Encode(jwks)
	}))
	defer server.Close()

	cache := &JWKSCache{ttl: time.Hour}
	got, err := cache.getJWKS(server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got.Keys) == 0 {
		t.Error("expected non-empty JWKS")
	}
}

// --- validateToken ---

func TestValidateToken_ExpiredToken(t *testing.T) {
	privKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	kid := "k1"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jwks := buildJWKS(kid, &privKey.PublicKey)
		json.NewEncoder(w).Encode(jwks)
	}))
	defer server.Close()

	issuer := server.URL + "/realms/test"
	cache := &JWKSCache{ttl: time.Hour}
	cache.mu.Lock()
	jwks := buildJWKS(kid, &privKey.PublicKey)
	cache.jwks = &jwks
	cache.expiresAt = time.Now().Add(time.Hour)
	cache.mu.Unlock()

	// Reset global cache; restore on cleanup.
	jwksCache.mu.Lock()
	savedJWKS2, savedExpiry2 := jwksCache.jwks, jwksCache.expiresAt
	jwksCache.jwks = &jwks
	jwksCache.expiresAt = time.Now().Add(time.Hour)
	jwksCache.mu.Unlock()
	t.Cleanup(func() {
		jwksCache.mu.Lock()
		jwksCache.jwks, jwksCache.expiresAt = savedJWKS2, savedExpiry2
		jwksCache.mu.Unlock()
	})

	// Build token that expired 1 hour ago
	token := buildJWT(t, privKey, kid, issuer, "user-1", "proj-1", time.Now().Add(-time.Hour))
	_, err := validateToken(token, server.URL+"/realms/test", []string{issuer})
	if err == nil {
		t.Error("expected error for expired token")
	}
}

func TestValidateToken_WrongIssuer(t *testing.T) {
	privKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	kid := "k1"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		jwks := buildJWKS(kid, &privKey.PublicKey)
		json.NewEncoder(w).Encode(jwks)
	}))
	defer server.Close()

	issuer := server.URL + "/realms/test"
	jwks := buildJWKS(kid, &privKey.PublicKey)
	jwksCache.mu.Lock()
	savedJWKS3, savedExpiry3 := jwksCache.jwks, jwksCache.expiresAt
	jwksCache.jwks = &jwks
	jwksCache.expiresAt = time.Now().Add(time.Hour)
	jwksCache.mu.Unlock()
	t.Cleanup(func() {
		jwksCache.mu.Lock()
		jwksCache.jwks, jwksCache.expiresAt = savedJWKS3, savedExpiry3
		jwksCache.mu.Unlock()
	})

	token := buildJWT(t, privKey, kid, "http://wrong-issuer/realms/test", "user-1", "proj-1", time.Now().Add(time.Hour))
	_, err := validateToken(token, issuer, []string{issuer})
	if err == nil {
		t.Error("expected error for wrong issuer")
	}
	if !strings.Contains(err.Error(), "issuer") {
		t.Errorf("expected issuer error, got: %v", err)
	}
}

// --- helpers ---

func buildJWKS(kid string, pubKey *rsa.PublicKey) JWKS {
	return JWKS{Keys: []JWK{{
		Kty: "RSA",
		Kid: kid,
		Use: "sig",
		N:   base64.RawURLEncoding.EncodeToString(pubKey.N.Bytes()),
		E:   encodeExponent(pubKey.E),
	}}}
}

func encodeExponent(e int) string {
	b := big.NewInt(int64(e)).Bytes()
	return base64.RawURLEncoding.EncodeToString(b)
}

func buildJWT(t *testing.T, privKey *rsa.PrivateKey, kid, issuer, userID, projectID string, exp time.Time) string {
	t.Helper()
	claims := &UserClaims{
		UserID:    userID,
		ProjectID: projectID,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   userID,
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = kid
	signed, err := token.SignedString(privKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// --- getKeycloakIssuer / getKeycloakInternalIssuer ---

func TestGetKeycloakIssuer_Empty(t *testing.T) {
	os.Unsetenv("KEYCLOAK_ISSUER")
	if got := getKeycloakIssuer(); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestGetKeycloakIssuer_Set(t *testing.T) {
	os.Setenv("KEYCLOAK_ISSUER", "http://keycloak/realms/myrealm")
	defer os.Unsetenv("KEYCLOAK_ISSUER")
	got := getKeycloakIssuer()
	if got != "http://keycloak/realms/myrealm" {
		t.Errorf("expected issuer URL, got %q", got)
	}
}

func TestGetKeycloakInternalIssuer_Empty(t *testing.T) {
	os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
	if got := getKeycloakInternalIssuer(); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestGetKeycloakInternalIssuer_Set(t *testing.T) {
	os.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://internal-keycloak/realms/myrealm")
	defer os.Unsetenv("KEYCLOAK_INTERNAL_ISSUER")
	got := getKeycloakInternalIssuer()
	if got != "http://internal-keycloak/realms/myrealm" {
		t.Errorf("expected %q, got %q", "http://internal-keycloak/realms/myrealm", got)
	}
}
