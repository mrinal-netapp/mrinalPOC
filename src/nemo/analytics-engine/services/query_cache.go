package services

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"agentstudio/nemo/analytics-engine/utils"
)

const (
	DefaultCacheMaxSize = 1000
	DefaultCacheTTL     = 5 * time.Minute
)

// CacheEntry represents a cached query result
type CacheEntry struct {
	Data      []byte
	ExpiresAt time.Time
	AccessAt  time.Time
}

// QueryCache manages cached query results
type QueryCache struct {
	cache   map[string]*CacheEntry
	lock    sync.RWMutex
	maxSize int
	ttl     time.Duration
	hits    int64
	misses  int64
}

var (
	queryCacheInstance *QueryCache
	cacheOnce          sync.Once
)

// GetQueryCache returns the singleton query cache instance
func GetQueryCache() *QueryCache {
	cacheOnce.Do(func() {
		queryCacheInstance = &QueryCache{
			cache:   make(map[string]*CacheEntry),
			maxSize: DefaultCacheMaxSize,
			ttl:     DefaultCacheTTL,
		}
		// Start cleanup goroutine
		go queryCacheInstance.cleanupExpired()
	})
	return queryCacheInstance
}

// GetCacheKey generates a cache key from query string
func GetCacheKey(query string) string {
	// Only cache metadata queries
	if !isMetadataQuery(query) {
		return ""
	}

	hash := sha256.Sum256([]byte(query))
	return hex.EncodeToString(hash[:])
}

// isMetadataQuery checks if a query is a metadata query that should be cached
func isMetadataQuery(query string) bool {
	upperQuery := strings.ToUpper(strings.TrimSpace(query))

	// Check for common metadata query patterns
	metadataPatterns := []string{
		"SHOW TABLES",
		"SHOW DATABASES",
		"DESCRIBE",
		"DESC ",
		"INFORMATION_SCHEMA",
		"SELECT * FROM INFORMATION_SCHEMA",
	}

	for _, pattern := range metadataPatterns {
		if strings.HasPrefix(upperQuery, pattern) {
			return true
		}
	}

	return false
}

// Get retrieves a cached query result
func (c *QueryCache) Get(key string) ([]byte, bool) {
	if key == "" {
		return nil, false
	}

	c.lock.RLock()
	entry, exists := c.cache[key]
	c.lock.RUnlock()

	if !exists {
		c.lock.Lock()
		c.misses++
		c.lock.Unlock()
		return nil, false
	}

	// Check if expired
	if time.Now().After(entry.ExpiresAt) {
		c.lock.Lock()
		delete(c.cache, key)
		c.misses++
		c.lock.Unlock()
		return nil, false
	}

	// Update access time
	c.lock.Lock()
	entry.AccessAt = time.Now()
	c.hits++
	c.lock.Unlock()

	return entry.Data, true
}

// Set stores a query result in the cache
func (c *QueryCache) Set(key string, data []byte) {
	if key == "" {
		return
	}

	c.lock.Lock()
	defer c.lock.Unlock()

	// Check if we need to evict entries
	if len(c.cache) >= c.maxSize {
		c.evictLRU()
	}

	c.cache[key] = &CacheEntry{
		Data:      data,
		ExpiresAt: time.Now().Add(c.ttl),
		AccessAt:  time.Now(),
	}

	utils.Debug("Cached query result. Cache size: %d", len(c.cache))
}

// Clear clears all cache entries
func (c *QueryCache) Clear() {
	c.lock.Lock()
	defer c.lock.Unlock()

	cleared := len(c.cache)
	c.cache = make(map[string]*CacheEntry)
	utils.Debug("Cleared cache. Removed %d entries", cleared)
}

// evictLRU evicts the least recently used entry
func (c *QueryCache) evictLRU() {
	if len(c.cache) == 0 {
		return
	}

	var oldestKey string
	var oldestTime time.Time
	first := true

	for key, entry := range c.cache {
		if first || entry.AccessAt.Before(oldestTime) {
			oldestKey = key
			oldestTime = entry.AccessAt
			first = false
		}
	}

	if oldestKey != "" {
		delete(c.cache, oldestKey)
		utils.Debug("Evicted LRU cache entry. Cache size: %d", len(c.cache))
	}
}

// cleanupExpired periodically removes expired entries
func (c *QueryCache) cleanupExpired() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		c.lock.Lock()
		now := time.Now()
		for key, entry := range c.cache {
			if now.After(entry.ExpiresAt) {
				delete(c.cache, key)
			}
		}
		c.lock.Unlock()
	}
}

// GetStats returns cache statistics
func (c *QueryCache) GetStats() CacheStats {
	c.lock.RLock()
	defer c.lock.RUnlock()

	hitRate := 0.0
	total := c.hits + c.misses
	if total > 0 {
		hitRate = float64(c.hits) / float64(total)
	}

	return CacheStats{
		Size:    len(c.cache),
		MaxSize: c.maxSize,
		TTL:     int(c.ttl.Seconds()),
		Hits:    c.hits,
		Misses:  c.misses,
		HitRate: hitRate,
	}
}

// CacheStats represents statistics about the query cache
type CacheStats struct {
	Size    int     `json:"size"`
	MaxSize int     `json:"maxsize"`
	TTL     int     `json:"ttl"`
	Hits    int64   `json:"hits"`
	Misses  int64   `json:"misses"`
	HitRate float64 `json:"hit_rate"`
}
