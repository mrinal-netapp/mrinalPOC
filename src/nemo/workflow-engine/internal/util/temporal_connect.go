package util

import (
	"os"
	"strconv"
	"time"
)

// TemporalConnectOptions returns retry count and delay between Temporal dial attempts.
// Tests may set TEMPORAL_CONNECT_RETRIES and TEMPORAL_CONNECT_RETRY_DELAY_MS.
func TemporalConnectOptions() (maxRetries int, retryDelay time.Duration) {
	maxRetries = 10
	retryDelay = 2 * time.Second
	if v := os.Getenv("TEMPORAL_CONNECT_RETRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxRetries = n
		}
	}
	if v := os.Getenv("TEMPORAL_CONNECT_RETRY_DELAY_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			retryDelay = time.Duration(n) * time.Millisecond
		}
	}
	return maxRetries, retryDelay
}
