package services

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/mocks"
)

func TestNewExecutorServiceWithDeps_NilHistoryService(t *testing.T) {
	mt := &mocks.Client{}
	cc := clients.NewConfigClientWithHTTPClient("http://example", nil)
	ex := NewExecutorServiceWithDeps(mt, cc, nil)
	require.NotNil(t, ex)
	require.NotNil(t, ex.historyService)
}

func TestExecutor_GetConfigClient(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	cc := ex.GetConfigClient()
	require.NotNil(t, cc)
	assert.Equal(t, stub.server.URL, cc.GetBaseURL())
}
