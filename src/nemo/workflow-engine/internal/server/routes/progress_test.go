package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func newProgressRouter(store services.ProgressStorer) *gin.Engine {
	r := gin.New()
	api := r.Group("/api/v1")
	SetupProgressRoutes(api, store)
	return r
}

func TestProgressRoute_GetMissingReturns404(t *testing.T) {
	r := newProgressRouter(services.NewProgressStore())
	req := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/progress", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusNotFound, w.Code)
}

func TestProgressRoute_PostThenGet(t *testing.T) {
	store := services.NewProgressStore()
	r := newProgressRouter(store)

	body, _ := json.Marshal(services.ProgressPayload{
		Phase: "running", Percentage: 25,
		Extra: map[string]interface{}{"k": "v"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/progress", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/workflows/wf-1/progress", nil)
	getW := httptest.NewRecorder()
	r.ServeHTTP(getW, getReq)
	require.Equal(t, http.StatusOK, getW.Code)

	var out services.ProgressPayload
	require.NoError(t, json.Unmarshal(getW.Body.Bytes(), &out))
	assert.Equal(t, "running", out.Phase)
	assert.Equal(t, float64(25), out.Percentage)
}

func TestProgressRoute_PostBadJSON(t *testing.T) {
	r := newProgressRouter(services.NewProgressStore())
	req := httptest.NewRequest(http.MethodPost, "/api/v1/workflows/wf-1/progress",
		bytes.NewBufferString(`{"percentage":"not-a-number"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestProgressRoute_Delete(t *testing.T) {
	store := services.NewProgressStore()
	store.Set("wf-1", services.ProgressPayload{Phase: "x"})
	r := newProgressRouter(store)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/workflows/wf-1/progress", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Nil(t, store.Get("wf-1"))
}
