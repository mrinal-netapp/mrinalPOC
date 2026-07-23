package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/server"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/agentstudio/nemo/workflow-engine/internal/workers"
)

func main() {
	ctx := context.Background()

	// Initialise observability via the common client lib.
	if err := obslib.ConfigureLoggingForService("workflow-engine"); err != nil {
		log.Fatalf("observability init failed: %v", err)
	}

	// Get configuration from environment
	port := getEnv("PORT", "8080")
	temporalAddress := getEnv("TEMPORAL_ADDRESS", "temporal:7233")
	configServiceURL := getEnv("CONFIG_SERVICE_URL", "http://config-service:3000")
	taskQueue := getEnv("TASK_QUEUE", "pipeline-execution")
	mcpHealthScheduleAutoCreate := getEnvBool("MCP_HEALTH_SCHEDULE_AUTO_CREATE", true)
	mcpHealthScheduleCron := getEnv("MCP_HEALTH_SCHEDULE_CRON", "*/5 * * * *")
	refEdgeReconcileAutoCreate := getEnvBool("REF_EDGE_RECONCILE_AUTO_CREATE", true)
	refEdgeReconcileCron := getEnv("REF_EDGE_RECONCILE_CRON", "*/5 * * * *")
	projectVKRotationAutoCreate := getEnvBool("PROJECT_VK_ROTATION_SCHEDULE_AUTO_CREATE", true)
	projectVKRotationInterval := parseDurationEnv("PROJECT_VK_ROTATION_INTERVAL", 24*time.Hour)
	projectVKRotationGrace := parseDurationEnv("PROJECT_VK_ROTATION_GRACE_PERIOD", 30*time.Minute)
	redisURL := getEnv("REDIS_URL", "")
	redisSentinelAddrs := getEnv("REDIS_SENTINEL_ADDRS", "")
	redisSentinelMaster := getEnv("REDIS_SENTINEL_MASTER", "mymaster")
	redisDB := getEnvInt("REDIS_DB", 2)
	redisPassword := getEnv("REDIS_PASSWORD", "")
	explorerCacheMaxEntries := getEnvInt("EXPLORER_CACHE_MAX_ENTRIES", 500)
	explorerCacheTTLSec := getEnvInt("EXPLORER_CACHE_TTL_SECONDS", 300)

	executorService := services.NewExecutorService(temporalAddress, configServiceURL)
	historyService := services.NewHistoryService(configServiceURL)

	var explorerCache *cache.ExplorerListCache
	explorerCache = initExplorerCache(ctx, redisURL, redisSentinelAddrs, redisSentinelMaster, redisDB, explorerCacheMaxEntries, explorerCacheTTLSec, redisPassword)

	// Wire config client into acquisition activities (FetchDatasetConfig, FetchDataSourceConfig, etc.)
	activities.InitAcquisitionActivities(executorService.GetConfigClient())

	// Start workflow worker in background
	worker := workers.NewWorkflowWorker(temporalAddress, taskQueue, executorService)
	go func() {
		if err := worker.Start(); err != nil {
			obslib.LogFatal(ctx, "Failed to start workflow worker", obslib.Error(err))
		}
	}()

	ensureStartupSchedules(ctx, executorService, scheduleBootstrapConfig{
		MCPHealthAutoCreate:        mcpHealthScheduleAutoCreate,
		MCPHealthCron:              mcpHealthScheduleCron,
		RefEdgeReconcileAutoCreate: refEdgeReconcileAutoCreate,
		RefEdgeReconcileCron:       refEdgeReconcileCron,
		ProjectVKRotationAuto:      projectVKRotationAutoCreate,
		ProjectVKRotationInterval:  projectVKRotationInterval,
		ProjectVKRotationGrace:     projectVKRotationGrace,
	})

	progressStore, progressCloser, progressBackend, err := services.NewProgressStorer(ctx)
	if err != nil {
		obslib.LogFatal(ctx, "Progress store init failed", obslib.Error(err))
	}
	if progressCloser != nil {
		defer func() {
			if err := progressCloser.Close(); err != nil {
				obslib.LogError(ctx, "Progress store close failed", obslib.Error(err))
			}
		}()
	}
	switch progressBackend {
	case "memory":
		obslib.LogWarn(ctx, "Workflow progress store: in-memory",
			obslib.String("hint", "set WORKFLOW_ENGINE_PROGRESS_REDIS_URL, or SHARE_REDIS / USE_SENTINEL"))
	default:
		obslib.LogInfo(ctx, "Workflow progress store: Redis", obslib.String("backend", progressBackend))
	}

	// Create and start HTTP server
	httpServer := server.NewServer(port, executorService, historyService, explorerCache, progressStore)

	// Graceful shutdown
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		if err := httpServer.Start(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			obslib.LogFatal(ctx, "Failed to start HTTP server", obslib.Error(err))
		}
	}()

	<-ctx.Done()
	obslib.LogInfo(ctx, "Shutting down gracefully")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		obslib.LogError(shutdownCtx, "Error during server shutdown", obslib.Error(err))
	}

	worker.Stop()
	_ = obslib.ShutdownObservability(shutdownCtx)
	obslib.LogInfo(shutdownCtx, "Shutdown complete")
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if n, err := strconv.Atoi(value); err == nil {
			return n
		}
	}
	return defaultValue
}

func parseDurationEnv(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if d, err := time.ParseDuration(value); err == nil && d > 0 {
			return d
		}
		log.Printf("Invalid duration for %s=%q, using default %s", key, value, defaultValue)
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		switch value {
		case "1", "true", "TRUE", "True", "yes", "YES", "on", "ON":
			return true
		case "0", "false", "FALSE", "False", "no", "NO", "off", "OFF":
			return false
		}
	}
	return defaultValue
}

func splitAndTrim(s, sep string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, sep)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
