package services

import (
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

// parseRedisURL is a tiny helper used by progress_storer_test.go and others.
// It belongs in services because that's where the only callers live.
func parseRedisURL(t *testing.T, raw string) *redis.Options {
	t.Helper()
	opt, err := redis.ParseURL(raw)
	require.NoError(t, err)
	return opt
}
