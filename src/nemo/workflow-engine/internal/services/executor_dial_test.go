package services

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNewExecutorService_PanicsWhenTemporalUnavailable(t *testing.T) {
	t.Setenv("TEMPORAL_CONNECT_RETRIES", "1")
	t.Setenv("TEMPORAL_CONNECT_RETRY_DELAY_MS", "0")
	require.Panics(t, func() {
		NewExecutorService("127.0.0.1:1", "http://127.0.0.1:9")
	})
}
