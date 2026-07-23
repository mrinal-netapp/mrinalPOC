package services

import (
	"context"
	"testing"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helper: clear every progress-related env so tests run in a known state.
func clearProgressEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"WORKFLOW_ENGINE_PROGRESS_REDIS_URL",
		"WORKFLOW_ENGINE_PROGRESS_REDIS_TTL",
		"WORKFLOW_ENGINE_PROGRESS_REDIS_DB",
		"WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS",
		"WORKFLOW_ENGINE_PROGRESS_USE_SENTINEL",
		"REDIS_URL",
		"REDIS_SENTINEL_ADDRS",
		"REDIS_SENTINEL_MASTER",
		"REDIS_PASSWORD",
	} {
		t.Setenv(k, "")
	}
}

func TestNewProgressStorer_DefaultsToInMemory(t *testing.T) {
	clearProgressEnv(t)
	st, closer, mode, err := NewProgressStorer(context.Background())
	require.NoError(t, err)
	require.Nil(t, closer, "in-memory store has no closer")
	require.Equal(t, "memory", mode)
	require.NotNil(t, st)
}

func TestNewProgressStorer_BadExplicitURL(t *testing.T) {
	clearProgressEnv(t)
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_URL", "://bad")
	_, _, _, err := NewProgressStorer(context.Background())
	require.Error(t, err)
}

func TestNewProgressStorer_ShareRedisNoURLFallsBackToMemory(t *testing.T) {
	clearProgressEnv(t)
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS", "true")
	t.Setenv("REDIS_URL", "")

	st, closer, mode, err := NewProgressStorer(context.Background())
	require.NoError(t, err)
	require.Equal(t, "memory", mode)
	require.Nil(t, closer)
	require.NotNil(t, st)
}

func TestNewProgressStorer_ShareRedisWithMiniredis(t *testing.T) {
	clearProgressEnv(t)
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS", "true")
	t.Setenv("REDIS_URL", "redis://"+s.Addr()+"/0")
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_DB", "5")

	st, closer, mode, err := NewProgressStorer(context.Background())
	require.NoError(t, err)
	require.Equal(t, "redis:shared", mode)
	require.NotNil(t, closer)
	t.Cleanup(func() { _ = closer.Close() })

	st.Set("wf-x", ProgressPayload{Phase: "p"})
	got := st.Get("wf-x")
	require.NotNil(t, got)
	assert.Equal(t, "p", got.Phase)
}

func TestNewProgressStorer_ShareRedisWithBadURL(t *testing.T) {
	clearProgressEnv(t)
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS", "true")
	t.Setenv("REDIS_URL", "://broken")
	_, _, _, err := NewProgressStorer(context.Background())
	require.Error(t, err)
}

func TestNewProgressStorer_SentinelWithoutAddrsErrors(t *testing.T) {
	clearProgressEnv(t)
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_USE_SENTINEL", "true")
	t.Setenv("REDIS_SENTINEL_ADDRS", "")
	_, _, _, err := NewProgressStorer(context.Background())
	require.Error(t, err)
}

func TestProgressRedisDB_DefaultAndOverride(t *testing.T) {
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_DB", "")
	assert.Equal(t, 4, progressRedisDB(), "default DB index is 4")

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_DB", "11")
	assert.Equal(t, 11, progressRedisDB())

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_DB", "not-a-number")
	assert.Equal(t, 4, progressRedisDB(), "garbage falls back to default")
}

func TestProgressTTL_DefaultAndOverride(t *testing.T) {
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL", "")
	require.Equal(t, "1h0m0s", progressTTL().String())

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL", "30m")
	require.Equal(t, "30m0s", progressTTL().String())

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL", "garbage")
	require.Equal(t, "1h0m0s", progressTTL().String(), "bad duration -> default")

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL", "0")
	require.Equal(t, "1h0m0s", progressTTL().String(), "non-positive -> default")
}

func TestEnvBoolTrue(t *testing.T) {
	t.Setenv("X", "")
	assert.False(t, envBoolTrue("X"))
	for _, v := range []string{"1", "true", "TRUE", "yes", "on"} {
		t.Setenv("X", v)
		assert.Truef(t, envBoolTrue("X"), "envBoolTrue(%q)", v)
	}
	for _, v := range []string{"0", "false", "no", "off", "unknown"} {
		t.Setenv("X", v)
		assert.Falsef(t, envBoolTrue("X"), "envBoolTrue(%q)", v)
	}
}

func TestSplitCommaNonEmpty(t *testing.T) {
	assert.Nil(t, splitCommaNonEmpty(""))
	assert.Equal(t, []string{"a"}, splitCommaNonEmpty("a"))
	assert.Equal(t, []string{"a", "b", "c"}, splitCommaNonEmpty("a, b ,c, ,"))
}

func TestSentinelMaster_DefaultAndOverride(t *testing.T) {
	t.Setenv("REDIS_SENTINEL_MASTER", "")
	assert.Equal(t, "mymaster", sentinelMaster())

	t.Setenv("REDIS_SENTINEL_MASTER", "primary")
	assert.Equal(t, "primary", sentinelMaster())
}

func TestUniversalFromURLOptions_NilSafeAndPopulates(t *testing.T) {
	assert.Nil(t, universalFromURLOptions(nil))

	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	c := universalFromURLOptions(parseRedisURL(t, "redis://"+s.Addr()+"/3"))
	require.NotNil(t, c)
	t.Cleanup(func() { _ = c.Close() })
	require.NoError(t, c.Ping(context.Background()).Err())
}
