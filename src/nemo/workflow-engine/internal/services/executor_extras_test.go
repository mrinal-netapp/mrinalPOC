package services

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/client"
)

func TestExecutor_ListVolumeDirectory_HappyPath(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return strings.HasPrefix(o.ID, "volume-browse-p-v-")
		}),
		mock.Anything,
		mock.Anything,
	).Return(&fakeWorkflowRun{
		id:     "volume-browse-1",
		runID:  "r1",
		getOut: map[string]interface{}{"entries": []interface{}{"a", "b"}},
	}, nil).Once()

	got, err := ex.ListVolumeDirectory("p", "v", "/sub")
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, []interface{}{"a", "b"}, got["entries"])
}

func TestExecutor_ListVolumeDirectory_StartError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("nope")).Once()
	_, err := ex.ListVolumeDirectory("p", "v", "")
	require.Error(t, err)
}

func TestExecutor_ListVolumeDirectory_GetError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(&fakeWorkflowRun{getErr: errors.New("get failed")}, nil).Once()
	_, err := ex.ListVolumeDirectory("p", "v", "")
	require.Error(t, err)
}

func TestExecutor_ExplorerListDirect_HappyPath(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"connector_config": map[string]interface{}{"provider": "ontap", "scope": "resource"},
				"credential_id":    "cred",
			})
		})
	expectedResponse := map[string]interface{}{"nodes": []interface{}{}}
	mt.On("ExecuteWorkflow",
		mock.Anything,
		mock.MatchedBy(func(o client.StartWorkflowOptions) bool {
			return strings.HasPrefix(o.ID, "explorer-list-p-c-")
		}),
		mock.Anything,
		mock.Anything,
	).Return(&fakeWorkflowRun{getOut: expectedResponse}, nil).Once()

	resp, err := ex.ExplorerListDirect("p", "c", "list", nil)
	require.NoError(t, err)
	require.NotNil(t, resp)
}

func TestExecutor_ExplorerListDirect_NoConfig(t *testing.T) {
	ex, _, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{})
		})
	_, err := ex.ExplorerListDirect("p", "c", "list", nil)
	require.Error(t, err)
}

// fakeWorkflowUpdateHandle implements client.WorkflowUpdateHandle for ExplorerList tests.
type fakeWorkflowUpdateHandle struct {
	wfID, runID, updateID string
	getErr                error
	getOut                interface{}
}

func (f *fakeWorkflowUpdateHandle) WorkflowID() string { return f.wfID }
func (f *fakeWorkflowUpdateHandle) RunID() string      { return f.runID }
func (f *fakeWorkflowUpdateHandle) UpdateID() string   { return f.updateID }
func (f *fakeWorkflowUpdateHandle) Get(_ context.Context, valuePtr interface{}) error {
	if f.getErr != nil {
		return f.getErr
	}
	if valuePtr == nil || f.getOut == nil {
		return nil
	}
	data, err := json.Marshal(f.getOut)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, valuePtr)
}

func TestExecutor_ExplorerList_HappyPath(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	expected := map[string]interface{}{
		"nodes": []interface{}{
			map[string]interface{}{"id": "n1", "label": "vol", "type": "volume"},
		},
	}
	mt.On("UpdateWorkflow", mock.Anything, "sess-1", "List", mock.Anything).
		Return(&fakeWorkflowUpdateHandle{getOut: expected}, nil).Once()

	resp, err := ex.ExplorerList("sess-1", "list", map[string]interface{}{"prefix": "/"})
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.Len(t, resp.Nodes, 1)
	assert.Equal(t, "n1", resp.Nodes[0].ID)
}

func TestExecutor_ExplorerList_UpdateError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("UpdateWorkflow", mock.Anything, "sess-1", "List", mock.Anything).
		Return(nil, errors.New("session gone")).Once()
	_, err := ex.ExplorerList("sess-1", "list", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to send List update")
}

func TestExecutor_ExplorerList_GetError(t *testing.T) {
	ex, mt, _ := newExecutorWithMockTemporal(t)
	mt.On("UpdateWorkflow", mock.Anything, "sess-1", "List", mock.Anything).
		Return(&fakeWorkflowUpdateHandle{getErr: errors.New("update rejected")}, nil).Once()
	_, err := ex.ExplorerList("sess-1", "list", nil)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "List update failed")
}

func TestExecutor_ExplorerListDirect_WorkflowFails(t *testing.T) {
	ex, mt, stub := newExecutorWithMockTemporal(t)
	stub.handle(http.MethodGet, "/api/v1/projects/p/datasources/c",
		func(w http.ResponseWriter, _ *http.Request) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"connector_config": map[string]interface{}{"provider": "ontap"},
			})
		})
	mt.On("ExecuteWorkflow", mock.Anything, mock.Anything, mock.Anything, mock.Anything).
		Return(nil, errors.New("nope")).Once()
	_, err := ex.ExplorerListDirect("p", "c", "list", nil)
	require.Error(t, err)
}

func TestNewHistoryService_BuildsClient(t *testing.T) {
	hs := NewHistoryService("http://example.invalid")
	require.NotNil(t, hs)
	require.NotNil(t, hs.configClient)
}

func TestMergeProgressExtra_ChoosesMaxAndPropagatesNonMergeKeys(t *testing.T) {
	existing := map[string]interface{}{
		"processedFiles": float64(5),
		"message":        "hello",
		"untouched":      true,
	}
	incoming := map[string]interface{}{
		"processedFiles": float64(3),
		"chunksCreated":  float64(8),
		"message":        "world", // non-merge key passes through (overwrites)
	}
	out := mergeProgressExtra(existing, incoming)
	assert.Equal(t, float64(5), out["processedFiles"], "max wins")
	assert.Equal(t, float64(8), out["chunksCreated"])
	assert.Equal(t, "world", out["message"])
	assert.Equal(t, true, out["untouched"])
}

func TestMergeProgressExtra_HandlesIncomingNonNumeric(t *testing.T) {
	existing := map[string]interface{}{"processedFiles": float64(2)}
	incoming := map[string]interface{}{"processedFiles": "string-junk"}
	out := mergeProgressExtra(existing, incoming)
	assert.Equal(t, float64(2), out["processedFiles"], "non-numeric incoming keeps existing")
}

func TestRedisProgressStore_Delete(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, time.Minute)

	store.Set("wf-del", ProgressPayload{Phase: "p"})
	require.NotNil(t, store.Get("wf-del"))
	store.Delete("wf-del")
	assert.Nil(t, store.Get("wf-del"))
}

func TestRedisProgressStore_GetMissingReturnsNil(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, 0) // ttl<=0 falls back to default

	assert.Nil(t, store.Get("missing"))
}

func TestRedisProgressStore_GetWithCorruptValueReturnsNil(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, time.Minute)

	require.NoError(t, s.Set("nemo:workflow:progress:bad", "not-json"))
	assert.Nil(t, store.Get("bad"))
}

func TestRedisProgressStore_Close(t *testing.T) {
	s := miniredis.RunT(t)
	t.Cleanup(func() { s.Close() })
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})

	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, time.Minute)
	require.NoError(t, store.Close())
}

// TestRedisProgressStore_RespectsContextDeadline asserts that Get / Set
// return promptly when the backing Redis is unreachable, rather than
// hanging until the outer caller's deadline expires. Catches regressions
// where the helpers stop honoring the 5s internal context timeout (see
// `redis_progress_store.go`).
func TestRedisProgressStore_RespectsContextDeadline(t *testing.T) {
	s := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{
		Addr:         s.Addr(),
		DialTimeout:  50 * time.Millisecond,
		ReadTimeout:  50 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
		MaxRetries:   -1,
	})
	var uc redis.UniversalClient = rdb
	store := NewRedisProgressStore(uc, time.Minute)

	// Make Redis unreachable.
	s.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = store.Get("nonexistent") // ok if it returns nil
		store.Set("k", ProgressPayload{Phase: "noop"})
	}()

	select {
	case <-done:
		// Both ops returned within the time budget.
	case <-time.After(2 * time.Second):
		t.Fatal("RedisProgressStore Get/Set did not return promptly when Redis was unavailable")
	}
}
