package services

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestRedisProgressStore_GetSetMerge(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, 5*time.Minute)

	require.Nil(t, store.Get("wf-1"))

	store.Set("wf-1", ProgressPayload{
		Phase:      "discovered",
		Percentage: 10,
		Extra: map[string]interface{}{
			"filesDiscovered": float64(42),
			"filesFiltered":   float64(2),
		},
	})
	got := store.Get("wf-1")
	require.NotNil(t, got)
	require.Equal(t, "discovered", got.Phase)
	require.Equal(t, float64(42), got.Extra["filesDiscovered"])

	store.Set("wf-1", ProgressPayload{
		UnitID:     "u1",
		UnitStatus: "completed",
		UnitMetrics: map[string]interface{}{
			"fileCount":   5,
			"bytesCopied": int64(1000),
		},
	})
	got = store.Get("wf-1")
	require.NotNil(t, got)
	require.Equal(t, float64(42), got.Extra["filesDiscovered"])
	require.Equal(t, int64(5), toInt64(got.Extra["fileCount"]))
	require.Equal(t, int64(1000), toInt64(got.Extra["bytesCopied"]))
}

func TestRedisProgressStore_ConcurrentSets(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, 5*time.Minute)

	const workers = 4
	const steps = 12
	var wg sync.WaitGroup
	wg.Add(workers)
	for w := 0; w < workers; w++ {
		go func(id int) {
			defer wg.Done()
			for i := 0; i < steps; i++ {
				store.Set("wf-concurrent", ProgressPayload{
					UnitID:     fmt.Sprintf("u-%d-%d", id, i),
					UnitStatus: "completed",
					UnitMetrics: map[string]interface{}{
						"fileCount": 1,
					},
				})
			}
		}(w)
	}
	wg.Wait()

	got := store.Get("wf-concurrent")
	require.NotNil(t, got)
	require.Equal(t, int64(workers*steps), toInt64(got.Extra["fileCount"]))
}

func TestNewProgressStorer_ExplicitURL(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })

	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_URL", "redis://"+s.Addr()+"/0")
	t.Setenv("WORKFLOW_ENGINE_PROGRESS_REDIS_TTL", "10m")

	st, closer, mode, err := NewProgressStorer(context.Background())
	require.NoError(t, err)
	require.Equal(t, "redis:url", mode)
	require.NotNil(t, closer)
	t.Cleanup(func() { _ = closer.Close() })

	st.Set("wf-env", ProgressPayload{Phase: "p", Percentage: 1})
	require.Equal(t, "p", st.Get("wf-env").Phase)
}
