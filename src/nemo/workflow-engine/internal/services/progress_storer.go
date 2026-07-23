package services

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ProgressStorer holds transient per-workflow progress (in-memory or Redis).
type ProgressStorer interface {
	Get(workflowID string) *ProgressPayload
	Set(workflowID string, payload ProgressPayload)
	Delete(workflowID string)
}

// progressRedisDB returns the logical Redis DB index for workflow progress when sharing
// the cluster Redis (explorer cache defaults to REDIS_DB, often 2; connector ACQ often uses 3).
// Default 4 keeps progress keys off the connector acquisition DB.
func progressRedisDB() int {
	if s := strings.TrimSpace(os.Getenv("WORKFLOW_ENGINE_PROGRESS_REDIS_DB")); s != "" {
		if n, err := strconv.Atoi(s); err == nil {
			return n
		}
	}
	return 4
}

func progressTTL() time.Duration {
	ttl := time.Hour
	if s := strings.TrimSpace(os.Getenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL")); s != "" {
		if d, err := time.ParseDuration(s); err == nil && d > 0 {
			ttl = d
		}
	}
	return ttl
}

func envBoolTrue(key string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func splitCommaNonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func sentinelMaster() string {
	if m := strings.TrimSpace(os.Getenv("REDIS_SENTINEL_MASTER")); m != "" {
		return m
	}
	return "mymaster"
}

// universalFromURLOptions maps redis.ParseURL options to a single-node UniversalClient.
func universalFromURLOptions(opt *redis.Options) redis.UniversalClient {
	if opt == nil {
		return nil
	}
	uo := &redis.UniversalOptions{
		Addrs:     []string{opt.Addr},
		DB:        opt.DB,
		Username:  opt.Username,
		Password:  opt.Password,
		PoolSize:  opt.PoolSize,
		TLSConfig: opt.TLSConfig,
	}
	return redis.NewUniversalClient(uo)
}

// NewProgressStorer returns the progress backend. Resolution order:
//  1. WORKFLOW_ENGINE_PROGRESS_REDIS_URL — redis:// or rediss:// (explicit).
//  2. WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS=true — reuse REDIS_URL with WORKFLOW_ENGINE_PROGRESS_REDIS_DB (default 4).
//  3. WORKFLOW_ENGINE_PROGRESS_USE_SENTINEL=true — reuse REDIS_SENTINEL_ADDRS + REDIS_SENTINEL_MASTER + REDIS_PASSWORD + WORKFLOW_ENGINE_PROGRESS_REDIS_DB.
//  4. Otherwise in-memory (single replica).
//
// Optional io.Closer must be closed on shutdown when non-nil.
// The mode string is one of: memory, redis:url, redis:shared, redis:sentinel.
func NewProgressStorer(ctx context.Context) (ProgressStorer, io.Closer, string, error) {
	ttl := progressTTL()
	explicit := strings.TrimSpace(os.Getenv("WORKFLOW_ENGINE_PROGRESS_REDIS_URL"))
	if explicit != "" {
		opt, err := redis.ParseURL(explicit)
		if err != nil {
			return nil, nil, "", fmt.Errorf("WORKFLOW_ENGINE_PROGRESS_REDIS_URL: %w", err)
		}
		rdb := universalFromURLOptions(opt)
		if err := rdb.Ping(ctx).Err(); err != nil {
			_ = rdb.Close()
			return nil, nil, "", fmt.Errorf("progress redis ping: %w", err)
		}
		rs := NewRedisProgressStore(rdb, ttl)
		return rs, rs, "redis:url", nil
	}

	if envBoolTrue("WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS") {
		shared := strings.TrimSpace(os.Getenv("REDIS_URL"))
		if shared == "" {
			log.Printf("[ProgressStore] WORKFLOW_ENGINE_PROGRESS_SHARE_REDIS=true but REDIS_URL is empty; using in-memory progress")
			return NewProgressStore(), nil, "memory", nil
		}
		opt, err := redis.ParseURL(shared)
		if err != nil {
			return nil, nil, "", fmt.Errorf("REDIS_URL for progress: %w", err)
		}
		opt.DB = progressRedisDB()
		rdb := universalFromURLOptions(opt)
		if err := rdb.Ping(ctx).Err(); err != nil {
			_ = rdb.Close()
			return nil, nil, "", fmt.Errorf("progress redis ping (shared): %w", err)
		}
		rs := NewRedisProgressStore(rdb, ttl)
		return rs, rs, "redis:shared", nil
	}

	if envBoolTrue("WORKFLOW_ENGINE_PROGRESS_USE_SENTINEL") {
		addrs := splitCommaNonEmpty(os.Getenv("REDIS_SENTINEL_ADDRS"))
		if len(addrs) == 0 {
			return nil, nil, "", fmt.Errorf("WORKFLOW_ENGINE_PROGRESS_USE_SENTINEL=true but REDIS_SENTINEL_ADDRS is empty")
		}
		pwd := os.Getenv("REDIS_PASSWORD")
		rdb := redis.NewUniversalClient(&redis.UniversalOptions{
			MasterName: sentinelMaster(),
			Addrs:      addrs,
			DB:         progressRedisDB(),
			Password:   pwd,
		})
		if err := rdb.Ping(ctx).Err(); err != nil {
			_ = rdb.Close()
			return nil, nil, "", fmt.Errorf("progress redis ping (sentinel): %w", err)
		}
		rs := NewRedisProgressStore(rdb, ttl)
		return rs, rs, "redis:sentinel", nil
	}

	return NewProgressStore(), nil, "memory", nil
}
