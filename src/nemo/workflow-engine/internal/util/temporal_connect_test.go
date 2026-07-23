package util

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestTemporalConnectOptions_Defaults(t *testing.T) {
	t.Setenv("TEMPORAL_CONNECT_RETRIES", "")
	t.Setenv("TEMPORAL_CONNECT_RETRY_DELAY_MS", "")
	max, delay := TemporalConnectOptions()
	assert.Equal(t, 10, max)
	assert.Equal(t, 2*time.Second, delay)
}

func TestTemporalConnectOptions_Overrides(t *testing.T) {
	t.Setenv("TEMPORAL_CONNECT_RETRIES", "3")
	t.Setenv("TEMPORAL_CONNECT_RETRY_DELAY_MS", "50")
	max, delay := TemporalConnectOptions()
	assert.Equal(t, 3, max)
	assert.Equal(t, 50*time.Millisecond, delay)
}
