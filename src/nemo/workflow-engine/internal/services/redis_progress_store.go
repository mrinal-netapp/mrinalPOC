package services

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisProgressStore persists workflow progress in Redis so multiple workflow-engine
// replicas share the same counters and entries survive brief pod restarts (subject to TTL).
type RedisProgressStore struct {
	rdb       redis.UniversalClient
	ttl       time.Duration
	keyPrefix string
}

// NewRedisProgressStore creates a Redis-backed progress store. Keys use keyPrefix + workflowID.
// rdb is typically *redis.Client or a UniversalClient from NewUniversalClient (Sentinel / single node).
func NewRedisProgressStore(rdb redis.UniversalClient, ttl time.Duration) *RedisProgressStore {
	if ttl <= 0 {
		ttl = time.Hour
	}
	return &RedisProgressStore{
		rdb:       rdb,
		ttl:       ttl,
		keyPrefix: "nemo:workflow:progress:",
	}
}

func (r *RedisProgressStore) redisKey(workflowID string) string {
	return r.keyPrefix + workflowID
}

// Get returns a deep copy of stored progress, or nil if missing.
func (r *RedisProgressStore) Get(workflowID string) *ProgressPayload {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := r.rdb.Get(ctx, r.redisKey(workflowID)).Bytes()
	if err == redis.Nil {
		return nil
	}
	if err != nil {
		return nil
	}
	var p ProgressPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	out := p
	out.Extra = copyExtra(p.Extra)
	out.Units = copyUnits(p.Units)
	return &out
}

// Set merges patch into the stored entry using the same rules as the in-memory ProgressStore.
// Uses optimistic locking (WATCH/MULTI) so concurrent updates from several replicas converge.
const progressRedisWatchMaxAttempts = 128

func (r *RedisProgressStore) Set(workflowID string, payload ProgressPayload) {
	key := r.redisKey(workflowID)
	var lastErr error
	for attempt := 0; attempt < progressRedisWatchMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		err := r.rdb.Watch(ctx, func(tx *redis.Tx) error {
			raw, err := tx.Get(ctx, key).Bytes()
			if err != nil && err != redis.Nil {
				return err
			}
			var existing *ProgressPayload
			if err == nil && len(raw) > 0 {
				var cur ProgressPayload
				if err := json.Unmarshal(raw, &cur); err != nil {
					return err
				}
				existing = &cur
			}
			merged := mergeProgressState(existing, payload, time.Now())
			data, err := json.Marshal(merged)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(p redis.Pipeliner) error {
				return p.Set(ctx, key, data, r.ttl).Err()
			})
			return err
		}, key)
		cancel()
		lastErr = err
		if err == redis.TxFailedErr {
			continue
		}
		if err != nil {
			log.Printf("[RedisProgressStore] Set workflowId=%s attempt=%d: %v", workflowID, attempt, err)
		}
		return
	}
	log.Printf("[RedisProgressStore] Set workflowId=%s exhausted retries (last error: %v)", workflowID, lastErr)
}

// Delete removes progress for a workflow (e.g. after completion).
func (r *RedisProgressStore) Delete(workflowID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = r.rdb.Del(ctx, r.redisKey(workflowID)).Err()
}

// Close releases the Redis client.
func (r *RedisProgressStore) Close() error {
	return r.rdb.Close()
}
