package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/workflows"
	"github.com/redis/go-redis/v9"
)

const (
	keyPrefix         = "explorer:list:"
	metaKey           = "explorer:list:meta:order"
	defaultMaxEntries = 500
	defaultTTL        = 300 * time.Second
)

// ExplorerListCache is a Redis-backed cache for explorer list responses.
// Implements cache-before-workflow: Get returns cached value for a level; Set stores after workflow.
// Max entries enforced via a sorted set (evict oldest). Fail-open on Redis errors.
type ExplorerListCache struct {
	client     *redis.Client
	maxEntries int
	ttl        time.Duration
}

// NewExplorerListCache creates a cache. If redisURL is empty, returns (nil, nil) for no cache (fail-open).
func NewExplorerListCache(redisURL string, maxEntries int, ttlSec int) (*ExplorerListCache, error) {
	return NewExplorerListCacheFromOptions(RedisOptions{StandaloneURL: redisURL}, maxEntries, ttlSec)
}

// RedisOptions selects between a Sentinel-aware failover client and a standalone client.
// When SentinelAddrs is non-empty the failover client is used (preferred for HA Redis with
// the Bitnami chart in replication mode). Otherwise StandaloneURL is parsed via
// redis.ParseURL. If both are empty the cache is disabled (returns nil, nil).
type RedisOptions struct {
	StandaloneURL  string
	SentinelAddrs  []string
	SentinelMaster string
	DB             int
	Password       string
}

// NewExplorerListCacheFromOptions builds the cache using either a Sentinel failover
// client or a standalone client. Returns (nil, nil) when no Redis is configured.
func NewExplorerListCacheFromOptions(opts RedisOptions, maxEntries int, ttlSec int) (*ExplorerListCache, error) {
	var client *redis.Client
	switch {
	case len(opts.SentinelAddrs) > 0 && opts.SentinelMaster != "":
		client = redis.NewFailoverClient(&redis.FailoverOptions{
			MasterName:    opts.SentinelMaster,
			SentinelAddrs: opts.SentinelAddrs,
			DB:            opts.DB,
			Password:      opts.Password,
		})
	case opts.StandaloneURL != "":
		parsed, err := redis.ParseURL(opts.StandaloneURL)
		if err != nil {
			return nil, err
		}
		client = redis.NewClient(parsed)
	default:
		return nil, nil
	}
	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}
	ttl := defaultTTL
	if ttlSec > 0 {
		ttl = time.Duration(ttlSec) * time.Second
	}
	return &ExplorerListCache{client: client, maxEntries: maxEntries, ttl: ttl}, nil
}

// CacheKey builds a deterministic key for (projectId, connectorId, action, payload).
func CacheKey(projectId, connectorId, action string, payload map[string]interface{}) string {
	h := sha256.Sum256([]byte(canonicalPayload(payload)))
	hash := hex.EncodeToString(h[:])
	return keyPrefix + projectId + ":" + connectorId + ":" + action + ":" + hash
}

func canonicalPayload(payload map[string]interface{}) string {
	if len(payload) == 0 {
		return "{}"
	}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	for _, k := range keys {
		b.WriteString(k)
		b.WriteString(":")
		b.WriteString(canonicalValue(payload[k]))
		b.WriteString(";")
	}
	return b.String()
}

func canonicalValue(v interface{}) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case map[string]interface{}:
		return canonicalPayload(x)
	case []interface{}:
		var parts []string
		for _, e := range x {
			parts = append(parts, canonicalValue(e))
		}
		return strings.Join(parts, ",")
	default:
		return ""
	}
}

// Get returns the cached ExplorerResponse for key. Returns (nil, nil) on miss or on Redis error (fail-open).
func (c *ExplorerListCache) Get(ctx context.Context, key string) (*workflows.ExplorerResponse, error) {
	val, err := c.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		log.Printf("[ExplorerListCache] Get error (fail-open): %v", err)
		return nil, nil
	}
	var resp workflows.ExplorerResponse
	if err := json.Unmarshal(val, &resp); err != nil {
		log.Printf("[ExplorerListCache] Unmarshal error: %v", err)
		return nil, nil
	}
	return &resp, nil
}

// Set stores the response and enforces max entries (evict oldest). Ignores Redis errors (fail-open).
func (c *ExplorerListCache) Set(ctx context.Context, key string, resp *workflows.ExplorerResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("[ExplorerListCache] Marshal error: %v", err)
		return
	}
	now := time.Now().UnixNano()
	pipe := c.client.Pipeline()
	pipe.SetEx(ctx, key, data, c.ttl)
	pipe.ZAdd(ctx, metaKey, redis.Z{Score: float64(now), Member: key})
	_, err = pipe.Exec(ctx)
	if err != nil {
		log.Printf("[ExplorerListCache] Set error (fail-open): %v", err)
		return
	}
	// Evict oldest if over limit
	count, err := c.client.ZCard(ctx, metaKey).Result()
	if err != nil {
		return
	}
	if count <= int64(c.maxEntries) {
		return
	}
	toRemove := count - int64(c.maxEntries)
	oldest, err := c.client.ZRange(ctx, metaKey, 0, toRemove-1).Result()
	if err != nil {
		return
	}
	for _, k := range oldest {
		c.client.Del(ctx, k)
		c.client.ZRem(ctx, metaKey, k)
	}
}

// InvalidateByConnector deletes all keys for the given projectId and connectorId.
func (c *ExplorerListCache) InvalidateByConnector(ctx context.Context, projectId, connectorId string) error {
	pattern := keyPrefix + projectId + ":" + connectorId + ":*"
	iter := c.client.Scan(ctx, 0, pattern, 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		if err := c.client.Del(ctx, key).Err(); err != nil {
			log.Printf("[ExplorerListCache] Invalidate Del error: %v", err)
		}
		c.client.ZRem(ctx, metaKey, key)
	}
	return iter.Err()
}
