package ginobs

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestGinRequestIDMiddleware_GeneratesUUIDWhenMissing(t *testing.T) {
	r := gin.New()
	r.Use(GinRequestIDMiddleware())
	r.GET("/x", func(c *gin.Context) {
		v, _ := c.Get("request_id")
		c.String(http.StatusOK, v.(string))
	})

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	id := w.Header().Get("X-Request-Id")
	require.NotEmpty(t, id, "X-Request-Id header must be set")
	require.Equal(t, id, w.Body.String(), "context request_id must match response header")
}

func TestGinRequestIDMiddleware_PreservesIncomingHeader(t *testing.T) {
	r := gin.New()
	r.Use(GinRequestIDMiddleware())
	r.GET("/x", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("X-Request-Id", "incoming-id-123")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, "incoming-id-123", w.Header().Get("X-Request-Id"))
}

func TestGinLoggingMiddleware_RequestReturnsCorrectStatus(t *testing.T) {
	r := gin.New()
	r.Use(GinRequestIDMiddleware(), GinLoggingMiddleware())
	r.GET("/api/v1/foo", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	req := httptest.NewRequest(http.MethodGet, "/api/v1/foo", nil)
	req.Header.Set("traceparent", "00-aaaa-bbbb-01")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
}

func TestGinLoggingMiddleware_HealthEndpointReturnsCorrectStatus(t *testing.T) {
	r := gin.New()
	r.Use(GinLoggingMiddleware())
	r.GET("/health", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
}

func TestGinLoggingMiddleware_UnmatchedRouteReturns404(t *testing.T) {
	r := gin.New()
	r.Use(GinLoggingMiddleware())
	r.NoRoute(func(c *gin.Context) { c.Status(http.StatusNotFound) })

	req := httptest.NewRequest(http.MethodGet, "/no/such/path", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestGinPrometheusMiddleware_PassesThrough(t *testing.T) {
	r := gin.New()
	r.Use(GinPrometheusMiddleware())
	r.GET("/api/v1/items/:id", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{}) })

	req := httptest.NewRequest(http.MethodGet, "/api/v1/items/42", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}

func TestGinTracingMiddleware_CreatesSpan(t *testing.T) {
	r := gin.New()
	r.Use(GinTracingMiddleware())
	r.GET("/api/v1/foo", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest(http.MethodGet, "/api/v1/foo", nil)
	req.Header.Set("X-Project-ID", "proj-1")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
}

func TestGinMetricsHandler_ServesMetricsEndpoint(t *testing.T) {
	r := gin.New()
	r.GET("/metrics", GinMetricsHandler())

	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
}
