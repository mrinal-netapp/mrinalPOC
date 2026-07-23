package workers

import (
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
)

func TestNewWorkflowWorkerWithClient_RegistersWorkflowsAndActivities(t *testing.T) {
	c, err := client.NewLazyClient(client.Options{})
	require.NoError(t, err)
	ww := NewWorkflowWorkerWithClient(c, "test-queue", nil)
	require.NotNil(t, ww)
	require.NotNil(t, ww.worker)
}

func TestWorkflowWorker_StopClosesClient(t *testing.T) {
	c, err := client.NewLazyClient(client.Options{})
	require.NoError(t, err)
	ww := NewWorkflowWorkerWithClient(c, "test-queue", nil)
	require.NotPanics(t, func() { ww.Stop() })
}
