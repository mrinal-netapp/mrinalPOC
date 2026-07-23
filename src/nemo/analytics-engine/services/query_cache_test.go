package services

import (
	"testing"
	"time"
)

// newTestCache creates a fresh QueryCache for each test (bypasses the singleton).
func newTestCache(maxSize int, ttl time.Duration) *QueryCache {
	c := &QueryCache{
		cache:   make(map[string]*CacheEntry),
		maxSize: maxSize,
		ttl:     ttl,
	}
	return c
}

// --- GetQueryCache (singleton) ---

func TestGetQueryCache_Singleton(t *testing.T) {
	c1 := GetQueryCache()
	c2 := GetQueryCache()
	if c1 != c2 {
		t.Error("GetQueryCache should return the same instance each time")
	}
}

// --- GetCacheKey ---

func TestGetCacheKey_NonMetadata(t *testing.T) {
	key := GetCacheKey("SELECT * FROM users")
	if key != "" {
		t.Errorf("non-metadata query should return empty key, got %q", key)
	}
}

func TestGetCacheKey_Metadata(t *testing.T) {
	key1 := GetCacheKey("SHOW TABLES")
	key2 := GetCacheKey("SHOW TABLES")
	if key1 == "" {
		t.Error("metadata query should return non-empty key")
	}
	if key1 != key2 {
		t.Error("same query should return same key")
	}
}

func TestGetCacheKey_DifferentQueries(t *testing.T) {
	k1 := GetCacheKey("SHOW TABLES")
	k2 := GetCacheKey("SHOW DATABASES")
	if k1 == k2 {
		t.Error("different queries should return different keys")
	}
}

// --- isMetadataQuery ---

func TestIsMetadataQuery(t *testing.T) {
	cases := []struct {
		query    string
		expected bool
	}{
		{"SHOW TABLES", true},
		{"show tables", true},
		{"SHOW DATABASES", true},
		{"DESCRIBE foo", true},
		{"DESC foo", true},
		{"INFORMATION_SCHEMA.columns", true},
		{"SELECT * FROM INFORMATION_SCHEMA.columns", true},
		{"SELECT * FROM users", false},
		{"INSERT INTO t VALUES (1)", false},
		{"", false},
	}

	for _, tc := range cases {
		got := isMetadataQuery(tc.query)
		if got != tc.expected {
			t.Errorf("isMetadataQuery(%q) = %v, want %v", tc.query, got, tc.expected)
		}
	}
}

// --- Get / Set ---

func TestCache_SetAndGet(t *testing.T) {
	c := newTestCache(100, time.Minute)
	key := "testkey"
	data := []byte("hello")

	c.Set(key, data)
	got, ok := c.Get(key)
	if !ok {
		t.Fatal("expected cache hit after Set")
	}
	if string(got) != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestCache_GetEmptyKey(t *testing.T) {
	c := newTestCache(100, time.Minute)
	_, ok := c.Get("")
	if ok {
		t.Error("empty key should always miss")
	}
}

func TestCache_SetEmptyKey(t *testing.T) {
	c := newTestCache(100, time.Minute)
	c.Set("", []byte("data")) // should be a no-op
	if len(c.cache) != 0 {
		t.Error("Set with empty key should not insert anything")
	}
}

func TestCache_MissIncremented(t *testing.T) {
	c := newTestCache(100, time.Minute)
	_, ok := c.Get("missing")
	if ok {
		t.Error("expected cache miss")
	}
	stats := c.GetStats()
	if stats.Misses != 1 {
		t.Errorf("expected 1 miss, got %d", stats.Misses)
	}
}

func TestCache_HitIncremented(t *testing.T) {
	c := newTestCache(100, time.Minute)
	c.Set("k", []byte("v"))
	c.Get("k")
	stats := c.GetStats()
	if stats.Hits != 1 {
		t.Errorf("expected 1 hit, got %d", stats.Hits)
	}
}

// --- TTL expiry ---

func TestCache_TTLExpiry(t *testing.T) {
	c := newTestCache(100, time.Millisecond)
	c.Set("k", []byte("v"))
	time.Sleep(5 * time.Millisecond)
	// Manually expire the entry
	c.lock.Lock()
	for key, entry := range c.cache {
		entry.ExpiresAt = time.Now().Add(-time.Second)
		c.cache[key] = entry
	}
	c.lock.Unlock()

	_, ok := c.Get("k")
	if ok {
		t.Error("expired entry should not be returned")
	}
}

// --- LRU eviction ---

func TestCache_LRUEviction(t *testing.T) {
	c := newTestCache(3, time.Minute)

	// Set three entries then pin exact AccessAt timestamps directly so the
	// test is deterministic without relying on time.Sleep or clock resolution.
	c.Set("a", []byte("1"))
	c.Set("b", []byte("2"))
	c.Set("c", []byte("3"))

	// Pin access times under the lock to avoid any race with background code.
	c.lock.Lock()
	base := time.Now()
	c.cache["a"].AccessAt = base.Add(2 * time.Millisecond) // most recently accessed
	c.cache["b"].AccessAt = base.Add(0 * time.Millisecond) // least recently accessed → should be evicted
	c.cache["c"].AccessAt = base.Add(1 * time.Millisecond)
	c.lock.Unlock()

	// Adding "d" exceeds maxSize=3 and must evict the LRU entry (b).
	c.Set("d", []byte("4"))

	if len(c.cache) > 3 {
		t.Errorf("cache size should not exceed maxSize, got %d", len(c.cache))
	}
	if _, ok := c.Get("b"); ok {
		t.Error("b should have been evicted as LRU")
	}
	for _, key := range []string{"a", "c", "d"} {
		if _, ok := c.Get(key); !ok {
			t.Errorf("expected %q to still be in cache after eviction", key)
		}
	}
}

// --- Clear ---

func TestCache_Clear(t *testing.T) {
	c := newTestCache(100, time.Minute)
	c.Set("a", []byte("1"))
	c.Set("b", []byte("2"))
	c.Clear()
	if len(c.cache) != 0 {
		t.Errorf("cache should be empty after Clear, got %d entries", len(c.cache))
	}
}

// --- GetStats ---

func TestCache_GetStats(t *testing.T) {
	c := newTestCache(10, 5*time.Minute)
	c.Set("x", []byte("data"))
	c.Get("x") // hit
	c.Get("y") // miss

	stats := c.GetStats()
	if stats.Size != 1 {
		t.Errorf("expected size 1, got %d", stats.Size)
	}
	if stats.MaxSize != 10 {
		t.Errorf("expected maxSize 10, got %d", stats.MaxSize)
	}
	if stats.TTL != 300 {
		t.Errorf("expected TTL 300, got %d", stats.TTL)
	}
	if stats.Hits != 1 {
		t.Errorf("expected 1 hit, got %d", stats.Hits)
	}
	if stats.Misses != 1 {
		t.Errorf("expected 1 miss, got %d", stats.Misses)
	}
	if stats.HitRate != 0.5 {
		t.Errorf("expected hit rate 0.5, got %f", stats.HitRate)
	}
}

func TestCache_GetStats_ZeroTotal(t *testing.T) {
	c := newTestCache(10, time.Minute)
	stats := c.GetStats()
	if stats.HitRate != 0.0 {
		t.Errorf("expected 0.0 hit rate with no requests, got %f", stats.HitRate)
	}
}

// --- evictLRU on empty cache ---

func TestEvictLRU_EmptyCache(t *testing.T) {
	c := newTestCache(0, time.Minute)
	// Should not panic
	c.lock.Lock()
	c.evictLRU()
	c.lock.Unlock()
}
