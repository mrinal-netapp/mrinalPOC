package services

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

// newTestQueue creates a TenantQueue with explicit config (bypasses env).
// Delegates to NewTenantQueueWithConfig so tests stay decoupled from struct internals.
func newTestQueue(slots int, maxWait time.Duration) *TenantQueue {
	return NewTenantQueueWithConfig(slots, maxWait)
}

// --- envIntOr ---

func TestEnvIntOr_Fallback(t *testing.T) {
	os.Unsetenv("TEST_ENV_INT")
	got := envIntOr("TEST_ENV_INT", 42)
	if got != 42 {
		t.Errorf("expected fallback 42, got %d", got)
	}
}

func TestEnvIntOr_EnvSet(t *testing.T) {
	os.Setenv("TEST_ENV_INT", "7")
	defer os.Unsetenv("TEST_ENV_INT")
	got := envIntOr("TEST_ENV_INT", 42)
	if got != 7 {
		t.Errorf("expected 7, got %d", got)
	}
}

func TestEnvIntOr_InvalidValue(t *testing.T) {
	os.Setenv("TEST_ENV_INT", "notanumber")
	defer os.Unsetenv("TEST_ENV_INT")
	got := envIntOr("TEST_ENV_INT", 99)
	if got != 99 {
		t.Errorf("expected fallback 99 for invalid value, got %d", got)
	}
}

// --- NewTenantQueue ---

func TestNewTenantQueue_Defaults(t *testing.T) {
	// Save and restore env vars to avoid leaking state into other tests.
	for _, key := range []string{"TENANT_QUEUE_SLOTS", "TENANT_QUEUE_MAX_WAIT_S"} {
		if old, had := os.LookupEnv(key); had {
			t.Cleanup(func() { os.Setenv(key, old) })
		} else {
			t.Cleanup(func() { os.Unsetenv(key) })
		}
		os.Unsetenv(key)
	}
	tq := NewTenantQueue()
	if tq.slotSize != 2 {
		t.Errorf("expected default slot size 2, got %d", tq.slotSize)
	}
	if tq.maxWait != 10*time.Second {
		t.Errorf("expected default maxWait 10s, got %v", tq.maxWait)
	}
}

// --- getOrCreate ---

func TestGetOrCreate_SameChannel(t *testing.T) {
	tq := newTestQueue(2, time.Second)
	ch1 := tq.getOrCreate("proj-a")
	ch2 := tq.getOrCreate("proj-a")
	if ch1 != ch2 {
		t.Error("getOrCreate should return the same channel for the same project")
	}
}

func TestGetOrCreate_DifferentChannels(t *testing.T) {
	tq := newTestQueue(2, time.Second)
	ch1 := tq.getOrCreate("proj-a")
	ch2 := tq.getOrCreate("proj-b")
	if ch1 == ch2 {
		t.Error("different projects should get different channels")
	}
}

// --- Acquire / release ---

func TestAcquire_HappyPath(t *testing.T) {
	tq := newTestQueue(2, time.Second)
	release, err := tq.Acquire(context.Background(), "proj")
	if err != nil {
		t.Fatalf("expected successful acquire, got: %v", err)
	}
	if release == nil {
		t.Fatal("expected non-nil release function")
	}
	release()
}

func TestAcquire_FreesSlot(t *testing.T) {
	tq := newTestQueue(1, time.Second)
	release, err := tq.Acquire(context.Background(), "proj")
	if err != nil {
		t.Fatal(err)
	}
	release()

	// After release, another acquire should succeed immediately
	release2, err := tq.Acquire(context.Background(), "proj")
	if err != nil {
		t.Fatalf("second acquire should succeed after release: %v", err)
	}
	release2()
}

func TestAcquire_ConcurrentWithinSlots(t *testing.T) {
	tq := newTestQueue(2, time.Second)
	var wg sync.WaitGroup
	errs := make(chan error, 2)

	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := tq.Acquire(context.Background(), "proj")
			if err != nil {
				errs <- err
				return
			}
			time.Sleep(10 * time.Millisecond)
			release()
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestAcquire_QueueFull(t *testing.T) {
	// 1 slot, very short wait
	tq := newTestQueue(1, 50*time.Millisecond)

	// Fill the slot
	release, err := tq.Acquire(context.Background(), "proj")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	// Second acquire should fail with timeout
	_, err = tq.Acquire(context.Background(), "proj")
	if err == nil {
		t.Error("expected error when queue is full, got nil")
	}
}

func TestAcquire_ContextCancellation(t *testing.T) {
	tq := newTestQueue(1, 5*time.Second)

	// Fill the slot
	release, err := tq.Acquire(context.Background(), "proj")
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	_, err = tq.Acquire(ctx, "proj")
	if err == nil {
		t.Error("expected error with cancelled context")
	}
}

// --- NewTenantQueueWithConfig ---

func TestNewTenantQueueWithConfig_SetsFields(t *testing.T) {
	tq := NewTenantQueueWithConfig(3, 5*time.Second)
	if tq == nil {
		t.Fatal("expected non-nil TenantQueue")
	}
	if tq.slotSize != 3 {
		t.Errorf("expected slotSize=3, got %d", tq.slotSize)
	}
	if tq.maxWait != 5*time.Second {
		t.Errorf("expected maxWait=5s, got %v", tq.maxWait)
	}
	if tq.queues == nil {
		t.Error("expected non-nil queues map")
	}
}

func TestNewTenantQueueWithConfig_WorksLikeNewTenantQueue(t *testing.T) {
	tq := NewTenantQueueWithConfig(1, 50*time.Millisecond)
	release, err := tq.Acquire(context.Background(), "proj-cfg")
	if err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}
	defer release()

	// Second acquire should fail because slot is full
	_, err = tq.Acquire(context.Background(), "proj-cfg")
	if err == nil {
		t.Error("expected error on second acquire with single slot")
	}
}
