package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/mocks"
)

func TestInitExplorerCache_NoRedisConfigured(t *testing.T) {
	got := initExplorerCache(context.Background(), "", "", "mymaster", 2, 100, 60, "")
	assert.Nil(t, got)
}

func TestInitExplorerCache_StandaloneRedis(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(s.Close)
	got := initExplorerCache(context.Background(), "redis://"+s.Addr()+"/0", "", "mymaster", 2, 100, 60, "")
	require.NotNil(t, got)
}

func TestInitExplorerCache_SentinelAddrsParsed(t *testing.T) {
	// Exercises splitAndTrim + sentinel branch even when brokers are unreachable.
	got := initExplorerCache(context.Background(), "", "127.0.0.1:26379, 127.0.0.2:26379", "mymaster", 2, 100, 60, "")
	_ = got
}

func TestEnsureStartupSchedules_AllEnabled(t *testing.T) {
	mt := &mocks.Client{}
	schedClient := &mocks.ScheduleClient{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("Create", mock.Anything, mock.Anything).
		Return(nil, &serviceerror.AlreadyExists{}).Maybe()

	stub := newBootstrapConfigStub(t)
	t.Cleanup(stub.Close)
	cc := clients.NewConfigClientWithHTTPClient(stub.URL, http.DefaultClient)
	ex := services.NewExecutorServiceWithDeps(mt, cc, services.NewHistoryServiceWithClient(cc))
	require.NotPanics(t, func() {
		ensureStartupSchedules(context.Background(), ex, scheduleBootstrapConfig{
			MCPHealthAutoCreate:        true,
			MCPHealthCron:              "*/5 * * * *",
			RefEdgeReconcileAutoCreate: true,
			RefEdgeReconcileCron:       "*/10 * * * *",
			ProjectVKRotationAuto:      true,
			ProjectVKRotationInterval:  time.Hour,
			ProjectVKRotationGrace:     time.Minute,
		})
	})
}

func TestEnsureStartupSchedules_Disabled(t *testing.T) {
	ex := services.NewExecutorServiceWithDeps(&mocks.Client{}, nil, nil)
	require.NotPanics(t, func() {
		ensureStartupSchedules(context.Background(), ex, scheduleBootstrapConfig{})
	})
}

func newBootstrapConfigStub(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
}
