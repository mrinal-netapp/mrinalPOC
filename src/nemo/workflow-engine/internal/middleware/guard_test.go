package middleware

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mintToken builds a `header.payload.sig` JWT envelope (UNSIGNED placeholder sig
// — the merged guard is decode-only; the sidecar validates signatures in prod).
func mintToken(payload map[string]any) string {
	b64 := func(v any) string {
		raw, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	return b64(map[string]any{"alg": "RS256", "kid": "test"}) + "." + b64(payload) + ".c2ln"
}

func userToken() string {
	return mintToken(map[string]any{"sub": "user-1", "email": "alice@x.io", "preferred_username": "alice"})
}

// saToken: sub but NO email → !email → guard calls next() (same as no token)
func saToken() string {
	return mintToken(map[string]any{"sub": "service-account-wfe", "preferred_username": "service-account-wfe"})
}

// guardTestRouter builds a gin engine whose routes mirror real FullPaths from
// the policy table, all guarded by UnifiedGuard.
func guardTestRouter() *gin.Engine {
	r := gin.New()
	api := r.Group("/api/v1")
	api.Use(UnifiedGuard())
	h := func(c *gin.Context) {
		_, hasUser := c.Get("userClaims")
		c.JSON(http.StatusOK, gin.H{
			"ok":        true,
			"hasUser":   hasUser,
			"xUserID":   c.Request.Header.Get("X-User-ID"),
			"xUserName": c.Request.Header.Get("X-User-Name"),
		})
	}
	// One representative route per policy group.
	api.GET("/workflows/:workflowId/progress", h)                   // public
	api.POST("/workflows/:workflowId/progress", h)                  // public
	api.DELETE("/workflows/:workflowId/progress", h)                // public
	api.POST("/projects/:projectId/init", h)                        // user
	api.GET("/workflows/:workflowId/status", h)                     // user
	api.POST("/projects/:projectId/datasets/:datasetId/import", h)  // service-only → `user` (mesh gates JWT users)
	api.POST("/projects/:projectId/datasets/:datasetId/acquire", h) // UI user OR service (!email)
	api.POST("/projects/:projectId/knowledgebases/:kbId/create", h) // UI user OR service (!email)
	return r
}

func do(r *gin.Engine, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func bodyCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	if c, ok := m["code"].(string); ok {
		return c
	}
	return ""
}

func init() { gin.SetMode(gin.TestMode) }

// ── public ────────────────────────────────────────────────────────────────
// Progress store MUST stay tokenless on all verbs — workers/WE-self call it
// without creds; regression on any verb would stall import/KB/acquire.
func TestGuard_PublicProgress_NoCreds_200(t *testing.T) {
	for _, method := range []string{"GET", "POST", "DELETE"} {
		w := do(guardTestRouter(), method, "/api/v1/workflows/wf1/progress", nil)
		assert.Equalf(t, http.StatusOK, w.Code, "%s /progress must be public (tokenless)", method)
	}
}

// ── user lane ─────────────────────────────────────────────────────────────
func TestGuard_User_WithEmail_200_SetsClaims(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init",
		map[string]string{"Authorization": "Bearer " + userToken()})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, true, m["hasUser"], "user lane must populate userClaims")
}

func TestGuard_User_LeadingWhitespaceBearer_200_SetsClaims(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init",
		map[string]string{"Authorization": "   Bearer " + userToken()})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, true, m["hasUser"], "leading whitespace before Bearer must still decode user token")
}

func TestGuard_User_NoToken_OnUserRoute_200(t *testing.T) {
	// No token → !email → guard calls next(). Mesh AuthorizationPolicy is the gate.
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init", nil)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGuard_User_SAToken_OnUserRoute_200(t *testing.T) {
	// SA token (no email) → !email → guard calls next(). Same as no token.
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init",
		map[string]string{"Authorization": "Bearer " + saToken()})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGuard_User_NonBearerAuthHeader_FailsClosed_200(t *testing.T) {
	// Non-Bearer header → decodeUserClaims returns nil → !email → next().
	for _, hdr := range []string{userToken(), "Token " + userToken(), "Basic " + userToken()} {
		w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init",
			map[string]string{"Authorization": hdr})
		assert.Equalf(t, http.StatusOK, w.Code, "non-Bearer header treated as no-token, passes to handler")
	}
}

// ── service-only routes (`user` at app layer; token-less passes via !email;
//
//	JWT users blocked at the mesh, not in-app) ─────────────────────────────
func TestGuard_Service_NoToken_200(t *testing.T) {
	// Service route, no token → !email → next(). Mesh is the gate.
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/import", nil)
	assert.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, false, m["hasUser"], "service path attaches no user context")
}

func TestGuard_Service_SAToken_200(t *testing.T) {
	// SA token (no email) on service route → !email → next() (pre-PR#249 compat).
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/import",
		map[string]string{"Authorization": "Bearer " + saToken()})
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGuard_Service_UserToken_200_AppLayer(t *testing.T) {
	// Service-only routes are `user` at the app layer, so a JWT user passes the
	// guard here (claims set). Re-blocking JWT users on these paths at the mesh
	// is deferred to a follow-up hardening PR.
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/import",
		map[string]string{"Authorization": "Bearer " + userToken()})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, true, m["hasUser"])
}

// ── dual routes (user or service, same URL) ────────────────────────────────
func TestGuard_Dual_UserToken_200_SetsClaims(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/acquire",
		map[string]string{"Authorization": "Bearer " + userToken()})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, true, m["hasUser"])
}

func TestGuard_Dual_NoToken_200(t *testing.T) {
	// Service caller (no token) on dual route → !email → next().
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/knowledgebases/kb1/create", nil)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGuard_Dual_SAToken_200(t *testing.T) {
	// SA token (pre-PR#249) on dual route → !email → next(). Original bug must not return.
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/acquire",
		map[string]string{"Authorization": "Bearer " + saToken()})
	assert.Equal(t, http.StatusOK, w.Code)
}

// ── strip-then-set (header-spoof defense) ─────────────────────────────────
func TestGuard_ServicePath_StripsForgedUserHeaders(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/datasets/d1/import",
		map[string]string{"X-User-ID": "attacker", "X-User-Name": "evil-admin"})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, "", m["xUserID"], "service path must strip forged X-User-ID")
	assert.Equal(t, "", m["xUserName"], "service path must strip forged X-User-Name")
}

func TestGuard_PublicPath_StripsForgedUserHeaders(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/workflows/wf1/progress",
		map[string]string{"X-User-Name": "evil-admin"})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, "", m["xUserName"], "public /progress must strip forged X-User-Name")
}

func TestGuard_UserLane_IdentityFromTokenNotForgedHeaders(t *testing.T) {
	w := do(guardTestRouter(), "POST", "/api/v1/projects/p1/init",
		map[string]string{
			"Authorization": "Bearer " + userToken(),
			"X-User-ID":     "attacker",
			"X-User-Name":   "evil-admin",
		})
	require.Equal(t, http.StatusOK, w.Code)
	var m map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &m))
	assert.Equal(t, "user-1", m["xUserID"], "X-User-ID must come from token, not forged header")
	assert.Equal(t, "", m["xUserName"], "missing token claim must not leave forged header in place")
}

// ── policy table integrity ─────────────────────────────────────────────────
func TestGuard_PolicyTable_NoConflictingEntries(t *testing.T) {
	for key, p := range buildPolicyTable() {
		if p.public {
			assert.False(t, p.user, "public route must not also require user: %s", key)
		}
	}
}

func TestGuardReject_UnknownCodeUsesCodeAsMessage(t *testing.T) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	guardReject(c, http.StatusForbidden, "custom_code")
	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "custom_code")
}
