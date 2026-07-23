package main

import (
	"context"
	"log"
	"time"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
)

type scheduleBootstrapConfig struct {
	MCPHealthAutoCreate        bool
	MCPHealthCron              string
	RefEdgeReconcileAutoCreate bool
	RefEdgeReconcileCron       string
	ProjectVKRotationAuto      bool
	ProjectVKRotationInterval  time.Duration
	ProjectVKRotationGrace     time.Duration
}

func ensureStartupSchedules(ctx context.Context, executorService *services.ExecutorService, cfg scheduleBootstrapConfig) {
	if cfg.MCPHealthAutoCreate {
		if scheduleID, err := executorService.EnsureMCPHealthSchedule(cfg.MCPHealthCron); err != nil {
			obslib.LogError(ctx, "Failed to ensure MCP health schedule", obslib.Error(err))
		} else {
			obslib.LogInfo(ctx, "MCP health schedule ensured",
				obslib.String("schedule_id", scheduleID), obslib.String("cron", cfg.MCPHealthCron))
		}
	}

	if cfg.RefEdgeReconcileAutoCreate {
		if scheduleID, err := executorService.EnsureReferenceEdgeReconcileSchedule(cfg.RefEdgeReconcileCron); err != nil {
			obslib.LogError(ctx, "Failed to ensure dependency-lineage-sync schedule", obslib.Error(err))
		} else {
			obslib.LogInfo(ctx, "Dependency-lineage-sync schedule ensured",
				obslib.String("schedule_id", scheduleID), obslib.String("cron", cfg.RefEdgeReconcileCron))
		}
	}

	if cfg.ProjectVKRotationAuto {
		if scheduleID, err := executorService.EnsureProjectVKRotationSchedule(cfg.ProjectVKRotationInterval, cfg.ProjectVKRotationGrace); err != nil {
			log.Printf("Failed to ensure project VK rotation schedule: %v", err)
		} else {
			log.Printf(
				"Project VK rotation schedule ensured: %s (interval=%s grace=%s)",
				scheduleID,
				cfg.ProjectVKRotationInterval,
				cfg.ProjectVKRotationGrace,
			)
		}
	}
}

func initExplorerCache(ctx context.Context, redisURL, redisSentinelAddrs, redisSentinelMaster string, redisDB, maxEntries, ttlSec int, redisPassword string) *cache.ExplorerListCache {
	cacheOpts := cache.RedisOptions{
		StandaloneURL:  redisURL,
		SentinelMaster: redisSentinelMaster,
		DB:             redisDB,
		Password:       redisPassword,
	}
	if redisSentinelAddrs != "" {
		cacheOpts.SentinelAddrs = splitAndTrim(redisSentinelAddrs, ",")
	}
	if len(cacheOpts.SentinelAddrs) == 0 && cacheOpts.StandaloneURL == "" {
		return nil
	}
	explorerCache, err := cache.NewExplorerListCacheFromOptions(cacheOpts, maxEntries, ttlSec)
	if err != nil {
		obslib.LogWarn(ctx, "Explorer cache disabled (Redis init failed)", obslib.Error(err))
		return nil
	}
	if len(cacheOpts.SentinelAddrs) > 0 {
		obslib.LogInfo(ctx, "Explorer list cache enabled (Redis Sentinel)",
			obslib.String("master", cacheOpts.SentinelMaster),
			obslib.Strings("addrs", cacheOpts.SentinelAddrs),
			obslib.Int("db", cacheOpts.DB),
		)
	} else {
		obslib.LogInfo(ctx, "Explorer list cache enabled (Redis standalone)")
	}
	return explorerCache
}
