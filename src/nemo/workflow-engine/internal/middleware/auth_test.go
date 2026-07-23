package middleware

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func init() {
	gin.SetMode(gin.TestMode)
}

// resetJWKSCache wipes the package-level JWKS cache so each test starts clean.
func resetJWKSCache() {
	jwksCache.mu.Lock()
	jwksCache.jwks = nil
	jwksCache.expiresAt = time.Time{}
	jwksCache.mu.Unlock()
}

type signingKit struct {
	priv *rsa.PrivateKey
	kid  string
}

func newSigningKit(t *testing.T) *signingKit {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	return &signingKit{priv: priv, kid: "test-kid"}
}

// jwksJSON returns the JSON representation of the public key as a JWKS document.
func (k *signingKit) jwksJSON(t *testing.T) []byte {
	t.Helper()
	pub := k.priv.PublicKey
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	// Encode E in big-endian and strip leading zeros.
	eBytes := []byte{byte(pub.E >> 16), byte(pub.E >> 8), byte(pub.E)}
	for len(eBytes) > 1 && eBytes[0] == 0 {
		eBytes = eBytes[1:]
	}
	e := base64.RawURLEncoding.EncodeToString(eBytes)
	body, err := json.Marshal(JWKS{Keys: []JWK{{Kty: "RSA", Kid: k.kid, Use: "sig", N: n, E: e}}})
	require.NoError(t, err)
	return body
}

func (k *signingKit) sign(t *testing.T, claims jwt.Claims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = k.kid
	signed, err := tok.SignedString(k.priv)
	require.NoError(t, err)
	return signed
}

// startKeycloakStub starts a server that serves the JWKS at .../protocol/openid-connect/certs.
func startKeycloakStub(t *testing.T, kit *signingKit) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/protocol/openid-connect/certs") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(kit.jwksJSON(t))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func protectedRouter() *gin.Engine {
	r := gin.New()
	r.Use(AuthMiddleware())
	r.GET("/private", func(c *gin.Context) {
		claims := GetUserClaims(c)
		c.JSON(http.StatusOK, gin.H{"user": claims})
	})
	r.GET("/health", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/api/v1/workflows/wf-1/progress", func(c *gin.Context) { c.Status(http.StatusOK) })
	return r
}

func TestAuthMiddleware_Disabled_WhenIssuerUnset(t *testing.T) {
	resetJWKSCache()
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	t.Setenv("KEYCLOAK_ISSUER", "")

	r := gin.New()
	r.Use(AuthMiddleware())
	r.GET("/anywhere", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/anywhere", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code, "auth disabled should let everything through")
}

func TestAuthMiddleware_HappyPath_AcceptsValidToken(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_ISSUER", "")

	tok := kit.sign(t, &UserClaims{
		UserID: "u1", Email: "u@example.com", Name: "U",
		ProjectID: "p1",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(5 * time.Minute)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	})

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, "u1", req.Header.Get("X-User-ID"))
	assert.Equal(t, "u@example.com", req.Header.Get("X-User-Email"))
	assert.Equal(t, "p1", req.Header.Get("X-Project-ID"))
}

func TestAuthMiddleware_MissingHeader(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", startKeycloakStub(t, kit))

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_BadHeaderFormat(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", startKeycloakStub(t, kit))

	r := protectedRouter()
	for _, h := range []string{"NotBearer abc", "Bearer", "Basic abc"} {
		req := httptest.NewRequest(http.MethodGet, "/private", nil)
		req.Header.Set("Authorization", h)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		assert.Equalf(t, http.StatusUnauthorized, w.Code, "header=%q", h)
	}
}

func TestAuthMiddleware_RejectsExpiredToken(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)

	tok := kit.sign(t, &UserClaims{
		UserID: "u1",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
		},
	})

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_RejectsBadIssuer(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)
	t.Setenv("KEYCLOAK_ISSUER", "")

	tok := kit.sign(t, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "https://attacker.example.com/realms/x",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})
	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_AcceptsExternalIssuerWhenConfigured(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	internal := startKeycloakStub(t, kit)
	external := "https://public.example.com/realms/n"
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", internal)
	t.Setenv("KEYCLOAK_ISSUER", external)

	tok := kit.sign(t, &UserClaims{
		UserID: "u",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    external,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})
	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code, "tokens issued by KEYCLOAK_ISSUER must be accepted alongside internal issuer")
}

func TestAuthMiddleware_BypassesPublicPaths(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", startKeycloakStub(t, kit))

	r := protectedRouter()
	for _, path := range []string{"/health", "/api/v1/workflows/wf-1/progress"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		assert.Equalf(t, http.StatusOK, w.Code, "path %q must skip auth", path)
	}
}

func TestAuthMiddleware_RejectsHS256_OnlyRS256Allowed(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)

	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})
	hs.Header["kid"] = kit.kid
	signed, err := hs.SignedString([]byte("hmac-secret"))
	require.NoError(t, err)

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_RejectsTokenWithMissingKid(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)

	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})
	// no kid header
	signed, err := tok.SignedString(kit.priv)
	require.NoError(t, err)

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_RejectsUnknownKid(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	issuer := startKeycloakStub(t, kit)
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", issuer)

	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})
	tok.Header["kid"] = "unknown-kid"
	signed, err := tok.SignedString(kit.priv)
	require.NoError(t, err)

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_RejectsWhenJWKSFetchFails(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", bad.URL)

	tok := kit.sign(t, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    bad.URL,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestAuthMiddleware_RejectsBadJWKSJSON(t *testing.T) {
	resetJWKSCache()
	kit := newSigningKit(t)
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not-json"))
	}))
	defer bad.Close()
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", bad.URL)

	tok := kit.sign(t, &UserClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    bad.URL,
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
		},
	})

	r := protectedRouter()
	req := httptest.NewRequest(http.MethodGet, "/private", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

// --- Pure helper coverage ---------------------------------------------------

func TestNormalizeIssuerURL(t *testing.T) {
	assert.Equal(t, "http://x", normalizeIssuerURL("http://x"))
	assert.Equal(t, "http://x", normalizeIssuerURL("http://x/"))
	assert.Equal(t, "http://x", normalizeIssuerURL("  http://x/  "))
}

func TestShouldSkipAuth(t *testing.T) {
	assert.True(t, shouldSkipAuth("/health"))
	assert.True(t, shouldSkipAuth("/ready"))
	assert.True(t, shouldSkipAuth("/api/v1/workflows/abc/progress"))
	assert.False(t, shouldSkipAuth("/api/v1/projects/p/pipelines"))
	assert.False(t, shouldSkipAuth("/api/v1/workflows/abc/status"))
}

func TestGetValidIssuers(t *testing.T) {
	t.Setenv("KEYCLOAK_ISSUER", "")
	got := getValidIssuers("http://internal/realms/n")
	assert.Equal(t, []string{"http://internal/realms/n"}, got)

	t.Setenv("KEYCLOAK_ISSUER", "http://external/realms/n/")
	got = getValidIssuers("http://internal/realms/n")
	assert.ElementsMatch(t, []string{"http://internal/realms/n", "http://external/realms/n"}, got)

	// External equal to internal: no duplication.
	t.Setenv("KEYCLOAK_ISSUER", "http://internal/realms/n")
	got = getValidIssuers("http://internal/realms/n")
	assert.Len(t, got, 1)
}

func TestJWK_GetPublicKey_NonRSAErrors(t *testing.T) {
	jwk := JWK{Kty: "EC"}
	_, err := jwk.getPublicKey()
	require.Error(t, err)
}

func TestJWK_GetPublicKey_BadBase64(t *testing.T) {
	jwk := JWK{Kty: "RSA", N: "!@#$", E: "AQAB"}
	_, err := jwk.getPublicKey()
	require.Error(t, err)

	jwk = JWK{Kty: "RSA", N: base64.RawURLEncoding.EncodeToString([]byte{1, 2, 3}), E: "!@#$"}
	_, err = jwk.getPublicKey()
	require.Error(t, err)
}

func TestGetUserClaims_NotPresent(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	assert.Nil(t, GetUserClaims(c))
}

func TestGetKeycloakInternalIssuer_Empty(t *testing.T) {
	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "")
	assert.Equal(t, "", getKeycloakInternalIssuer())

	t.Setenv("KEYCLOAK_INTERNAL_ISSUER", "http://x/realms/n")
	assert.Equal(t, "http://x/realms/n", getKeycloakInternalIssuer())
}
