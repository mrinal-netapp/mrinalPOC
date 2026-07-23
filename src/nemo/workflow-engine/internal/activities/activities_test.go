package activities

import (
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

func TestRegisterActivities_Smoke(t *testing.T) {
	c, err := client.NewLazyClient(client.Options{})
	require.NoError(t, err)

	w := worker.New(c, "test-queue", worker.Options{})
	require.NotPanics(t, func() {
		RegisterActivities(w)
	})
}
