package activities

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// resetAcquisitionConfig nudges the package-level variable so each test starts clean.
func resetAcquisitionConfig() {
	configClientForAcquisition = nil
}

func TestFetchDatasetConfigActivity_Uninitialized(t *testing.T) {
	resetAcquisitionConfig()
	t.Cleanup(resetAcquisitionConfig)
	_, err := FetchDatasetConfigActivity(context.Background(), "p", "d")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not initialized")
}

func TestFetchDataSourceConfigActivity_Uninitialized(t *testing.T) {
	resetAcquisitionConfig()
	t.Cleanup(resetAcquisitionConfig)
	_, err := FetchDataSourceConfigActivity(context.Background(), "p", "ds")
	require.Error(t, err)
}

func TestUpdateDatasetWatermarkActivity_Uninitialized(t *testing.T) {
	resetAcquisitionConfig()
	t.Cleanup(resetAcquisitionConfig)
	require.Error(t, UpdateDatasetWatermarkActivity(context.Background(), "p", "d", "w"))
}

func TestAcquisitionActivities_HappyPath(t *testing.T) {
	resetAcquisitionConfig()
	t.Cleanup(resetAcquisitionConfig)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "x"})
		case http.MethodPatch:
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)

	cc := clients.NewConfigClientWithHTTPClient(srv.URL, http.DefaultClient)
	InitAcquisitionActivities(cc)

	got, err := FetchDatasetConfigActivity(context.Background(), "p", "d")
	require.NoError(t, err)
	assert.Equal(t, "x", got["id"])

	got2, err := FetchDataSourceConfigActivity(context.Background(), "p", "ds")
	require.NoError(t, err)
	assert.Equal(t, "x", got2["id"])

	require.NoError(t, UpdateDatasetWatermarkActivity(context.Background(), "p", "d", "watermark-1"))
}
