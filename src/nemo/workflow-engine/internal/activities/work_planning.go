package activities

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

// GetScatterGatherConfigActivity reads a subset of scatter-related env vars for
// workflows or tooling. CreateWorkPlanActivity (Python on dataset-processing /
// kb-processing queues) reads WORK_UNIT_MAX_MB, MAX_WORK_UNITS,
// SCATTER_MAX_UNITS_CEILING, MAX_FILES_PER_UNIT, and MIN_FILES_PER_UNIT directly
// to compute K_eff and distribute files.
func GetScatterGatherConfigActivity(ctx context.Context) (types.ScatterGatherConfig, error) {
	return getScatterGatherConfigFromEnv(), nil
}

func getScatterGatherConfigFromEnv() types.ScatterGatherConfig {
	// WORK_UNIT_MAX_MB: Python planner uses this to derive target shard count from total bytes (0 = MIN_FILES_PER_UNIT-based K only).
	workUnitMaxMB := envInt("WORK_UNIT_MAX_MB", 5)
	var maxBytesPerWorkUnit int64
	if workUnitMaxMB > 0 {
		maxBytesPerWorkUnit = int64(workUnitMaxMB) * 1024 * 1024
	}
	cfg := types.ScatterGatherConfig{
		MaxWorkUnits:         envInt("MAX_WORK_UNITS", 10),
		MinFilesPerUnit:      envInt("MIN_FILES_PER_UNIT", 10),
		DatasetFileThreshold: envInt("DATASET_FILE_THRESHOLD", 20),
		KBFileThreshold:      envInt("KB_FILE_THRESHOLD", 25), // below this -> single activity; 70 files -> scatter
		MaxBytesPerWorkUnit:  maxBytesPerWorkUnit,
	}
	return cfg
}

// GetAcquisitionPipelineConfigFromEnv builds an AcquisitionPipelineConfig from
// ACQ_* env vars. Used by data_acquisition.go to size scatter and toggle the
// pipeline on/off without recompiling. See docs/design/stream-pipeline.md.
func GetAcquisitionPipelineConfigFromEnv() types.AcquisitionPipelineConfig {
	return types.AcquisitionPipelineConfig{
		UsePipeline:            envBool("ACQ_USE_PIPELINE", true),
		MaxAcquireConsumers:    envInt("ACQ_MAX_CONSUMERS", 8),
		BatchSize:              envInt("ACQ_BATCH_SIZE", 64),
		MaxBatchesPerActivity:  envInt("ACQ_MAX_BATCHES_PER_ACTIVITY", 8),
		UnboundedConsumers:     envInt("ACQ_UNBOUNDED_CONSUMERS", 8),
		StreamingMode:          envStr("ACQ_STREAMING_MODE", "sequential"),
		ScheduleToStartTimeout: envDuration("ACQ_SCHEDULE_TO_START_TIMEOUT", 15*time.Minute),
		MaxDiscoverWorkers:     envInt("ACQ_MAX_DISCOVER_WORKERS", 2),
		MaxRegisterConsumers:   envInt("ACQ_MAX_REGISTER_CONSUMERS", 2),
	}
}

func envInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return i
}

func envStr(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func envBool(key string, defaultVal bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return defaultVal
}

func envDuration(key string, defaultVal time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	if d, err := time.ParseDuration(v); err == nil {
		return d
	}
	return defaultVal
}
