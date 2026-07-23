package middleware

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// UnifiedGuard — the merged, decode-only authorization guard for workflow-engine.
//
// Decision order (simplified mesh-first model):
//  1. public route  → next()
//  2. JWT has email → user lane: set userClaims + X-User-* headers, enforce policy.user
//  3. no email      → next() — mesh AuthorizationPolicy is the gate for these callers
//     (covers both tokenless mTLS services and SA tokens pre-PR#249)
//
// Decode-only: this guard NEVER verifies a JWT signature. The Istio sidecar
// RequestAuthentication does that at every hop before app code runs.
//
// GATING: server.go installs this as the sole /api/v1 authorizer (replacing
// the legacy JWKS AuthMiddleware).
//
// X-User-* headers are stripped unconditionally on every request and re-set
// only from the validated user token, closing the header-spoof gap (PR #249).

// routePolicy is the per-route lane configuration.
// internalAllowed is removed — mesh AuthorizationPolicy is the sole gate.
type routePolicy struct {
	public bool // reachable with no credentials (health/progress)
	user   bool // a user token (with email) may call → sets userClaims
}

// decodeUserClaims base64url-decodes the Authorization bearer payload segment
// into UserClaims WITHOUT verifying the signature (sidecar's job). Returns nil
// when the header/token is missing or malformed — the guard then falls through
// to the non-user (mesh-gated) path rather than erroring.
func decodeUserClaims(c *gin.Context) *UserClaims {
	authHeader := strings.TrimSpace(c.GetHeader("Authorization"))
	if authHeader == "" {
		return nil
	}
	// Fail closed on anything that is not `Authorization: Bearer <token>` to
	// match the legacy AuthMiddleware contract — never treat a non-Bearer value
	// as a raw token.
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return nil
	}
	token := strings.TrimSpace(parts[1])
	if token == "" {
		return nil
	}

	seg := strings.Split(token, ".")
	if len(seg) != 3 || seg[1] == "" {
		return nil
	}
	// Keycloak emits unpadded base64url; tolerate optional padding.
	payload := strings.TrimRight(seg[1], "=")
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil
	}
	var claims UserClaims
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil
	}
	return &claims
}

// rejectMessages maps each stable machine `code` to a human-readable message.
// The `code` stays fixed for programmatic clients while `message` gives
// operators and logs a descriptive reason (matching config-service's
// unifiedGuard and the legacy guards). Falls back to the code if unmapped.
var rejectMessages = map[string]string{
	"token_missing_or_invalid": "Missing or invalid authentication token",
	"user_not_allowed":         "User credentials are not permitted on this route",
	"service_not_allowed":      "Service caller is not permitted on this route",
}

func guardReject(c *gin.Context, status int, code string) {
	errLabel := "Unauthorized"
	if status == http.StatusForbidden {
		errLabel = "Forbidden"
	}
	message, ok := rejectMessages[code]
	if !ok {
		message = code
	}
	c.JSON(status, gin.H{"error": errLabel, "code": code, "message": message})
	c.Abort()
}

// identityHeaders are the user-identity headers the guard OWNS.
// Stripped unconditionally on every request; re-set only from the validated user token.
// This closes the X-User-* header-spoof gap for east-west traffic.
var identityHeaders = []string{"X-User-ID", "X-User-Email", "X-User-Name", "X-Project-ID"}

// stripInboundIdentityHeaders removes any caller-supplied identity headers so
// they can never be trusted unless the guard re-sets them from a validated token.
func stripInboundIdentityHeaders(c *gin.Context) {
	for _, h := range identityHeaders {
		c.Request.Header.Del(h)
	}
}

// UnifiedGuard returns the gin middleware. It looks the per-route policy up by
// the matched route (method + c.FullPath()). Unmapped routes default to the
// user lane for JWTs with an email claim; token-less / no-email callers still
// pass through to the mesh gate. A warning is logged so missed entries surface.
//
// Decision order:
//  1. public route → next()
//  2. JWT has email claim → user lane (set userClaims + identity headers)
//  3. no email (no JWT or SA token pre-PR#249) → next() — mesh AuthorizationPolicy is the gate
//
// After PR #249 (SA token removal): the Email check degrades to a nil-claims check.
func UnifiedGuard() gin.HandlerFunc {
	table := buildPolicyTable()
	return func(c *gin.Context) {
		// Strip any inbound identity headers BEFORE any lane decision, on every
		// lane. The user lane re-sets them from the validated token; all other
		// lanes leave them absent. This closes the X-User-* header-spoof gap.
		stripInboundIdentityHeaders(c)

		key := c.Request.Method + " " + c.FullPath()
		policy, ok := table[key]
		if !ok {
			log.Printf("[guard] WARNING unmapped route %q — defaulting to user lane (email-gated; non-user callers pass through)", key)
			policy = routePolicy{user: true}
		}

		// 1) Public.
		if policy.public {
			c.Next()
			return
		}

		// 2) Decode JWT. No email = not a user (no JWT, or SA token pre-PR#249).
		//    Email is the intentional user discriminator — human tokens carry it;
		//    machine/SA tokens omit it. Mesh AuthorizationPolicy is the gate.
		claims := decodeUserClaims(c)
		if claims == nil || claims.Email == "" {
			c.Next()
			return
		}

		// 3) User token confirmed (has email). Enforce the route policy.
		if !policy.user {
			guardReject(c, http.StatusForbidden, "user_not_allowed")
			return
		}
		// Mirror AuthMiddleware: expose identity to handlers + downstreams.
		c.Set("userClaims", claims)
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
		c.Next()
	}
}
