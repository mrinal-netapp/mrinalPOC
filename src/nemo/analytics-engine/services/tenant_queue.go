package services

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"agentstudio/nemo/analytics-engine/utils"
)

// TenantQueue manages per-project concurrency to prevent agent traffic from
// starving GUI users on the shared DuckDB engine. Since the engine serializes
// queries (MaxOpenConns=1), raw rate limits are insufficient. Each project
// gets a bounded slot; callers fast-fail with HTTP 429 after a short wait.
type TenantQueue struct {
	mu       sync.Mutex
	queues   map[string]chan struct{}
	maxWait  time.Duration
	slotSize int
}

// NewTenantQueue creates a new tenant queue with configurable slot size and max wait.
func NewTenantQueue() *TenantQueue {
	slotSize := envIntOr("TENANT_QUEUE_SLOTS", 2)
	maxWaitSec := envIntOr("TENANT_QUEUE_MAX_WAIT_S", 10)

	return &TenantQueue{
		queues:   make(map[string]chan struct{}),
		maxWait:  time.Duration(maxWaitSec) * time.Second,
		slotSize: slotSize,
	}
}

// NewTenantQueueWithConfig creates a TenantQueue with explicit configuration.
// Useful for testing without relying on environment variables.
// slots is clamped to a minimum of 1; a non-positive maxWait is treated as 0
// (immediate timeout — callers will always receive a queue-full error).
func NewTenantQueueWithConfig(slots int, maxWait time.Duration) *TenantQueue {
	if slots < 1 {
		slots = 1
	}
	if maxWait < 0 {
		maxWait = 0
	}
	return &TenantQueue{
		queues:   make(map[string]chan struct{}),
		maxWait:  maxWait,
		slotSize: slots,
	}
}

// Acquire attempts to acquire a slot for the given project. Returns a release
// function on success, or an error if the wait times out. Callers must call
// the release function when the query completes.
func (tq *TenantQueue) Acquire(ctx context.Context, projectID string) (release func(), err error) {
	ch := tq.getOrCreate(projectID)

	waitCtx, cancel := context.WithTimeout(ctx, tq.maxWait)
	defer cancel()

	select {
	case ch <- struct{}{}:
		utils.Debug("Tenant queue slot acquired for project %s", projectID)
		return func() {
			<-ch
			utils.Debug("Tenant queue slot released for project %s", projectID)
		}, nil
	case <-waitCtx.Done():
		return nil, fmt.Errorf("query queue full for project %s; try again shortly", projectID)
	}
}

func (tq *TenantQueue) getOrCreate(projectID string) chan struct{} {
	tq.mu.Lock()
	defer tq.mu.Unlock()

	ch, exists := tq.queues[projectID]
	if !exists {
		ch = make(chan struct{}, tq.slotSize)
		tq.queues[projectID] = ch
	}
	return ch
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
