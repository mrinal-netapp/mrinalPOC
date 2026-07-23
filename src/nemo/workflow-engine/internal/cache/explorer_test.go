package cache

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewExplorerListCacheFromOptions_DisabledWhenNoTarget(t *testing.T) {
	c, err := NewExplorerListCacheFromOptions(RedisOptions{}, 100, 60)
	require.NoError(t, err)
	assert.Nil(t, c, "no Redis configured -> nil cache (fail-open)")
}

func TestNewExplorerListCacheFromOptions_StandaloneURL(t *testing.T) {
	c, err := NewExplorerListCacheFromOptions(RedisOptions{
		StandaloneURL: "redis://127.0.0.1:6379/2",
	}, 100, 60)
	require.NoError(t, err)
	require.NotNil(t, c)
	assert.Equal(t, 100, c.maxEntries)
}

func TestNewExplorerListCacheFromOptions_SentinelTakesPrecedence(t *testing.T) {
	// When both Sentinel addrs and a standalone URL are supplied, Sentinel wins.
	// We don't actually connect; constructor should not error.
	c, err := NewExplorerListCacheFromOptions(RedisOptions{
		StandaloneURL:  "redis://127.0.0.1:6379/2",
		SentinelAddrs:  []string{"sentinel-a:26379", "sentinel-b:26379"},
		SentinelMaster: "mymaster",
		DB:             2,
	}, 0, 0)
	require.NoError(t, err)
	require.NotNil(t, c)
	// maxEntries falls back to defaultMaxEntries when 0 is passed.
	assert.Equal(t, defaultMaxEntries, c.maxEntries)
}

func TestNewExplorerListCacheFromOptions_BadStandaloneURLBubbles(t *testing.T) {
	_, err := NewExplorerListCacheFromOptions(RedisOptions{
		StandaloneURL: "://not-a-url",
	}, 0, 0)
	require.Error(t, err)
}

func TestNewExplorerListCache_BackwardCompatibleShim(t *testing.T) {
	// Original constructor must still work for callers that haven't migrated.
	c, err := NewExplorerListCache("redis://127.0.0.1:6379/2", 50, 30)
	require.NoError(t, err)
	require.NotNil(t, c)
	assert.Equal(t, 50, c.maxEntries)
}
