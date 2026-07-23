package cache

import (
	"context"
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newCacheWithMiniredis spins up an embedded Redis and returns a cache wired to it,
// plus the underlying miniredis server (so tests can advance time / inspect keys).
func newCacheWithMiniredis(t *testing.T, maxEntries int) (*ExplorerListCache, *miniredis.Miniredis) {
	t.Helper()
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}
	c := &ExplorerListCache{client: rdb, maxEntries: maxEntries, ttl: 60 * time.Second}
	return c, s
}

func sampleResponse(label string) *workflows.ExplorerResponse {
	return &workflows.ExplorerResponse{
		Nodes: []workflows.ExplorerNode{
			{ID: "n1", Label: label, Type: "folder", Kind: "directory"},
		},
	}
}

func TestCacheKey_StableAcrossOrder(t *testing.T) {
	a := CacheKey("p1", "c1", "list", map[string]interface{}{"a": 1, "b": "two"})
	b := CacheKey("p1", "c1", "list", map[string]interface{}{"b": "two", "a": 1})
	assert.Equal(t, a, b, "key must be order-independent")
}

func TestCacheKey_DifferentPayloadsDiffer(t *testing.T) {
	a := CacheKey("p1", "c1", "list", map[string]interface{}{"path": "/a"})
	b := CacheKey("p1", "c1", "list", map[string]interface{}{"path": "/b"})
	assert.NotEqual(t, a, b)
}

func TestCacheKey_NilAndEmptyPayloadAreEqual(t *testing.T) {
	a := CacheKey("p", "c", "list", nil)
	b := CacheKey("p", "c", "list", map[string]interface{}{})
	assert.Equal(t, a, b)
}

func TestCacheKey_HandlesAllPayloadValueKinds(t *testing.T) {
	// Mostly to exercise canonicalValue branches (string, float64, int, int64, bool, map, slice, nil, default)
	payload := map[string]interface{}{
		"s":      " hello ",
		"f":      3.14,
		"i":      7,
		"i64":    int64(99),
		"b":      true,
		"bf":     false,
		"m":      map[string]interface{}{"k": "v"},
		"a":      []interface{}{1, "two", true, nil},
		"n":      nil,
		"unkown": struct{ X int }{1}, // unknown type hits the default branch
	}
	got := CacheKey("p", "c", "list", payload)
	assert.NotEmpty(t, got)
	// Same payload always yields same hash.
	again := CacheKey("p", "c", "list", payload)
	assert.Equal(t, got, again)
}

func TestExplorerListCache_GetMissReturnsNil(t *testing.T) {
	c, _ := newCacheWithMiniredis(t, 0)
	got, err := c.Get(context.Background(), "missing-key")
	require.NoError(t, err)
	assert.Nil(t, got)
}

func TestExplorerListCache_SetThenGetRoundTrips(t *testing.T) {
	c, _ := newCacheWithMiniredis(t, 0)
	key := CacheKey("p", "c", "list", map[string]interface{}{"path": "/root"})
	c.Set(context.Background(), key, sampleResponse("root"))

	got, err := c.Get(context.Background(), key)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Len(t, got.Nodes, 1)
	assert.Equal(t, "root", got.Nodes[0].Label)
}

func TestExplorerListCache_TTLApplied(t *testing.T) {
	c, s := newCacheWithMiniredis(t, 0)
	key := "explorer:list:ttl"
	c.Set(context.Background(), key, sampleResponse("x"))
	// FastForward past TTL; entry must disappear.
	s.FastForward(2 * c.ttl)
	got, err := c.Get(context.Background(), key)
	require.NoError(t, err)
	assert.Nil(t, got, "value should expire after TTL")
}

func TestExplorerListCache_EvictsOldestWhenOverMaxEntries(t *testing.T) {
	c, _ := newCacheWithMiniredis(t, 3)

	keys := []string{
		"explorer:list:k1",
		"explorer:list:k2",
		"explorer:list:k3",
		"explorer:list:k4",
	}
	for _, k := range keys {
		c.Set(context.Background(), k, sampleResponse(k))
		// micro-sleep so ZAdd scores are strictly monotonic
		time.Sleep(time.Millisecond)
	}

	// k1 is the oldest entry and should have been evicted.
	got, err := c.Get(context.Background(), keys[0])
	require.NoError(t, err)
	assert.Nil(t, got, "oldest key must be evicted when over max")

	got2, err := c.Get(context.Background(), keys[3])
	require.NoError(t, err)
	require.NotNil(t, got2, "newest key must remain")
}

func TestExplorerListCache_GetWithCorruptValueFailsOpen(t *testing.T) {
	c, s := newCacheWithMiniredis(t, 0)
	key := "explorer:list:bad"
	require.NoError(t, s.Set(key, "not-json")) // bypass our Set so we know it's malformed

	got, err := c.Get(context.Background(), key)
	require.NoError(t, err, "bad payload must not propagate as error (fail-open)")
	assert.Nil(t, got)
}

func TestExplorerListCache_InvalidateByConnectorRemovesAllPrefixes(t *testing.T) {
	c, _ := newCacheWithMiniredis(t, 0)

	keep := CacheKey("pY", "cZ", "list", map[string]interface{}{"path": "/a"})
	drop1 := CacheKey("pX", "c1", "list", map[string]interface{}{"path": "/a"})
	drop2 := CacheKey("pX", "c1", "list", map[string]interface{}{"path": "/b"})

	c.Set(context.Background(), keep, sampleResponse("keep"))
	c.Set(context.Background(), drop1, sampleResponse("drop1"))
	c.Set(context.Background(), drop2, sampleResponse("drop2"))

	require.NoError(t, c.InvalidateByConnector(context.Background(), "pX", "c1"))

	g1, _ := c.Get(context.Background(), drop1)
	g2, _ := c.Get(context.Background(), drop2)
	gk, _ := c.Get(context.Background(), keep)
	assert.Nil(t, g1)
	assert.Nil(t, g2)
	require.NotNil(t, gk, "unrelated connector entry must survive")
}

func TestExplorerListCache_FailOpenWhenRedisGoesAway(t *testing.T) {
	// Start a cache then close the underlying server: every operation must
	// be silent (no errors, nil reads).
	c, s := newCacheWithMiniredis(t, 0)
	s.Close()

	key := "explorer:list:gone"
	c.Set(context.Background(), key, sampleResponse("x")) // must not panic
	got, err := c.Get(context.Background(), key)
	require.NoError(t, err, "Get must fail-open on Redis error")
	assert.Nil(t, got)
}
