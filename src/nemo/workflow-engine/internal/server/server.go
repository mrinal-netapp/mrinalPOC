package server

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/agentstudio/nemo/workflow-engine/internal/cache"
	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/internal/ginobs"
	authMiddleware "github.com/agentstudio/nemo/workflow-engine/internal/middleware"
	"github.com/agentstudio/nemo/workflow-engine/internal/server/routes"
	"github.com/agentstudio/nemo/workflow-engine/internal/services"
	"github.com/gin-gonic/gin"
)

type Server struct {
	httpServer      *http.Server
	executorService *services.ExecutorService
	historyService  *services.HistoryService
	progressStore   services.ProgressStorer
	explorerCache   *cache.ExplorerListCache
}

func NewServer(port string, executorService *services.ExecutorService, historyService *services.HistoryService, explorerCache *cache.ExplorerListCache, progressStore services.ProgressStorer) *Server {
	router := gin.New()

	// Observability middleware (order matters: request ID → tracing → metrics → logging)
	router.Use(ginobs.GinRequestIDMiddleware())
	router.Use(ginobs.GinTracingMiddleware())
	router.Use(ginobs.GinPrometheusMiddleware())
	router.Use(ginobs.GinLoggingMiddleware())
	router.Use(gin.Recovery())

	// Prometheus metrics endpoint (no auth required)
	router.GET("/metrics", ginobs.GinMetricsHandler())

	// Health check endpoint
	router.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "healthy"})
	})

	// API routes with authentication.
	//
	// Unified decode-only guard: routes each request by a per-route policy table
	// (JWTs with an email claim enter the user lane and set userClaims; token-less
	// / no-email callers pass through to the mesh AuthorizationPolicy; progress
	// endpoints stay public).
	api := router.Group("/api/v1")
	api.Use(authMiddleware.UnifiedGuard())
	routes.SetupRoutes(api, executorService, historyService)
	routes.SetupProjectInitRoutes(api, executorService)
	routes.SetupProjectDeleteRoutes(api, executorService)
	routes.SetupTableProcessingRoutes(api, executorService)
	routes.SetupDatasetDeleteRoutes(api, executorService)
	routes.SetupDatasetImportRoutes(api, executorService)
	routes.SetupKBCreationRoutes(api, executorService)
	routes.SetupKBDeleteRoutes(api, executorService)
	routes.SetupKBScheduleRoutes(api, executorService)
	{
		configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
		if configServiceURL == "" {
			configServiceURL = "http://config-service:3000"
		}
		routes.SetupKBVersionsRoutes(api, clients.NewConfigClient(configServiceURL))
	}
	routes.SetupWorkflowStatusRoutes(api, executorService)
	routes.SetupProgressRoutes(api, progressStore)
	routes.SetupConnectorRoutes(api, executorService, explorerCache)
	routes.SetupMCPHealthRoutes(api, executorService)
	routes.SetupReferenceEdgeRoutes(api, executorService)
	routes.SetupProjectMembershipRoutes(api, executorService)

	return &Server{
		httpServer: &http.Server{
			Addr:    fmt.Sprintf(":%s", port),
			Handler: router,
		},
		executorService: executorService,
		historyService:  historyService,
		progressStore:   progressStore,
		explorerCache:   explorerCache,
	}
}

func (s *Server) Start() error {
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}
