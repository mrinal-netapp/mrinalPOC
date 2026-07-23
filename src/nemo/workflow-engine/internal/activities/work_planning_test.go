package activities

import (
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGetAcquisitionPipelineConfigFromEnv_Defaults(t *testing.T) {
	t.Cleanup(func() {
		for _, k := range []string{
			"ACQ_USE_PIPELINE", "ACQ_MAX_CONSUMERS", "ACQ_BATCH_SIZE",
			"ACQ_MAX_BATCHES_PER_ACTIVITY", "ACQ_UNBOUNDED_CONSUMERS", "ACQ_STREAMING_MODE",
			"ACQ_SCHEDULE_TO_START_TIMEOUT", "ACQ_MAX_DISCOVER_WORKERS", "ACQ_MAX_REGISTER_CONSUMERS",
		} {
			_ = os.Unsetenv(k)
		}
	})
	for _, k := range []string{
		"ACQ_USE_PIPELINE", "ACQ_MAX_CONSUMERS", "ACQ_BATCH_SIZE",
		"ACQ_MAX_BATCHES_PER_ACTIVITY", "ACQ_UNBOUNDED_CONSUMERS", "ACQ_STREAMING_MODE",
		"ACQ_SCHEDULE_TO_START_TIMEOUT", "ACQ_MAX_DISCOVER_WORKERS", "ACQ_MAX_REGISTER_CONSUMERS",
	} {
		_ = os.Unsetenv(k)
	}

	cfg := GetAcquisitionPipelineConfigFromEnv()
	assert.True(t, cfg.UsePipeline)
	assert.Equal(t, 8, cfg.MaxAcquireConsumers)
	assert.Equal(t, 64, cfg.BatchSize)
	assert.Equal(t, 8, cfg.MaxBatchesPerActivity)
	assert.Equal(t, 8, cfg.UnboundedConsumers)
	assert.Equal(t, "sequential", cfg.StreamingMode)
	assert.Equal(t, 15*time.Minute, cfg.ScheduleToStartTimeout)
	assert.Equal(t, 2, cfg.MaxDiscoverWorkers)
	assert.Equal(t, 2, cfg.MaxRegisterConsumers)
}

func TestGetAcquisitionPipelineConfigFromEnv_Overrides(t *testing.T) {
	t.Cleanup(func() {
		for _, k := range []string{
			"ACQ_USE_PIPELINE", "ACQ_MAX_CONSUMERS", "ACQ_BATCH_SIZE",
			"ACQ_MAX_BATCHES_PER_ACTIVITY", "ACQ_UNBOUNDED_CONSUMERS", "ACQ_STREAMING_MODE",
			"ACQ_SCHEDULE_TO_START_TIMEOUT", "ACQ_MAX_DISCOVER_WORKERS", "ACQ_MAX_REGISTER_CONSUMERS",
		} {
			_ = os.Unsetenv(k)
		}
	})

	require.NoError(t, os.Setenv("ACQ_USE_PIPELINE", "false"))
	require.NoError(t, os.Setenv("ACQ_MAX_CONSUMERS", "4"))
	require.NoError(t, os.Setenv("ACQ_BATCH_SIZE", "32"))
	require.NoError(t, os.Setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "4"))
	require.NoError(t, os.Setenv("ACQ_UNBOUNDED_CONSUMERS", "3"))
	require.NoError(t, os.Setenv("ACQ_STREAMING_MODE", "parallel"))
	require.NoError(t, os.Setenv("ACQ_SCHEDULE_TO_START_TIMEOUT", "30s"))
	require.NoError(t, os.Setenv("ACQ_MAX_DISCOVER_WORKERS", "5"))
	require.NoError(t, os.Setenv("ACQ_MAX_REGISTER_CONSUMERS", "6"))

	cfg := GetAcquisitionPipelineConfigFromEnv()
	assert.False(t, cfg.UsePipeline)
	assert.Equal(t, 4, cfg.MaxAcquireConsumers)
	assert.Equal(t, 32, cfg.BatchSize)
	assert.Equal(t, 4, cfg.MaxBatchesPerActivity)
	assert.Equal(t, 3, cfg.UnboundedConsumers)
	assert.Equal(t, "parallel", cfg.StreamingMode)
	assert.Equal(t, 30*time.Second, cfg.ScheduleToStartTimeout)
	assert.Equal(t, 5, cfg.MaxDiscoverWorkers)
	assert.Equal(t, 6, cfg.MaxRegisterConsumers)
}

func TestGetScatterGatherConfigFromEnv_Defaults(t *testing.T) {
	t.Cleanup(func() {
		for _, k := range []string{"WORK_UNIT_MAX_MB", "MAX_WORK_UNITS", "MIN_FILES_PER_UNIT", "DATASET_FILE_THRESHOLD", "KB_FILE_THRESHOLD"} {
			_ = os.Unsetenv(k)
		}
	})
	for _, k := range []string{"WORK_UNIT_MAX_MB", "MAX_WORK_UNITS", "MIN_FILES_PER_UNIT", "DATASET_FILE_THRESHOLD", "KB_FILE_THRESHOLD"} {
		_ = os.Unsetenv(k)
	}

	cfg := getScatterGatherConfigFromEnv()
	assert.Equal(t, 10, cfg.MaxWorkUnits)
	assert.Equal(t, 10, cfg.MinFilesPerUnit)
	assert.Equal(t, 20, cfg.DatasetFileThreshold)
	assert.Equal(t, 25, cfg.KBFileThreshold)
	assert.Equal(t, int64(5*1024*1024), cfg.MaxBytesPerWorkUnit)
}

func TestGetScatterGatherConfigFromEnv_WorkUnitMaxMBZeroDisablesByteCap(t *testing.T) {
	t.Cleanup(func() { _ = os.Unsetenv("WORK_UNIT_MAX_MB") })
	require.NoError(t, os.Setenv("WORK_UNIT_MAX_MB", "0"))
	cfg := getScatterGatherConfigFromEnv()
	assert.Equal(t, int64(0), cfg.MaxBytesPerWorkUnit)
}
