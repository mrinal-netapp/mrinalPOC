package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

// newTestRouterWithClaims wires SetupProjectInitRoutes onto a Gin router with
// pre-injected user claims, so we can exercise the route's auth invariants
// without spinning up a full Keycloak/Temporal stack. We pass a nil executor
// service because the rejection paths return before touching it.
func newTestRouterWithClaims(claims *middleware.UserClaims) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		if claims != nil {
			c.Set("userClaims", claims)
		}
		c.Next()
	})
	api := r.Group("/api/v1")
	SetupProjectInitRoutes(api, (*services.ExecutorService)(nil))
	return r
}

func TestProjectInit_Returns401WhenNoClaims(t *testing.T) {
	r := newTestRouterWithClaims(nil)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
	assert.Contains(t, w.Body.String(), "user token")
}

func TestProjectInit_Returns401WhenEmptySub(t *testing.T) {
	r := newTestRouterWithClaims(&middleware.UserClaims{})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusUnauthorized, w.Code)
}

func TestProjectInit_Returns403ForServiceAccountCaller(t *testing.T) {
	r := newTestRouterWithClaims(&middleware.UserClaims{
		UserID:   "8f3c2a1e-9b4d-4f7c-a1e2-7d8c9b0a1f3e",
		Username: "service-account-agentstudio-config-service",
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "service-account")
}

// A valid user caller, but a member entry with a role outside admin|member|
// viewer → 400 before the workflow is ever started (nil executor untouched).
func TestProjectInit_Returns400ForInvalidMemberRole(t *testing.T) {
	r := newTestRouterWithClaims(&middleware.UserClaims{UserID: "owner-1", Username: "alice@example.com"})

	body := `{"members":[{"email":"bob@example.com","role":"superuser"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "invalid role")
}

// A member entry with an empty email → 400.
func TestProjectInit_Returns400ForMissingMemberEmail(t *testing.T) {
	r := newTestRouterWithClaims(&middleware.UserClaims{UserID: "owner-1", Username: "alice@example.com"})

	body := `{"members":[{"email":"  ","role":"member"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "email is required")
}

// A malformed (non-empty) member email → 400 at request time, so a typo does
// not pass the handler and fail the whole init workflow when config-service
// rejects the batch.
func TestProjectInit_Returns400ForMalformedMemberEmail(t *testing.T) {
	r := newTestRouterWithClaims(&middleware.UserClaims{UserID: "owner-1", Username: "alice@example.com"})

	body := `{"members":[{"email":"not-an-email","role":"member"}]}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/proj-1/init", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "not a valid email")
}
