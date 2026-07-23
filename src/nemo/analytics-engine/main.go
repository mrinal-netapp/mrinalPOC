package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agentstudio/nemo/analytics-engine/handlers"
	authMiddleware "agentstudio/nemo/analytics-engine/middleware"
	ratelimit "agentstudio/nemo/analytics-engine/middleware"
	"agentstudio/nemo/analytics-engine/services"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

const (
	defaultPort     = "5000"
	shutdownTimeout = 30 * time.Second
	readTimeout     = 15 * time.Second
	writeTimeout    = 15 * time.Second
	idleTimeout     = 60 * time.Second
	requestTimeout  = 60 * time.Second
)

func main() {
	// Handle --install-extensions flag (used during Docker build to pre-install DuckDB extensions)
	if len(os.Args) > 1 && os.Args[1] == "--install-extensions" {
		if err := services.InstallExtensions(); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to install extensions: %v\n", err)
			os.Exit(1)
		}
		os.Exit(0)
	}

	ctx := context.Background()

	// Initialise observability via the common client lib.
	if err := obslib.ConfigureLoggingForService("analytics-engine"); err != nil {
		log.Fatalf("observability init failed: %v", err)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	// Initialize DuckDB manager
	cfg := services.NewCatalogConfigFromEnv()
	manager, err := services.NewDuckDBManager(cfg)
	if err != nil {
		obslib.LogFatal(ctx, "Failed to create DuckDB manager", obslib.Error(err))
	}
	defer manager.Close()

	manager.Init()

	// Initialize SQL validator (parse-only DuckDB connection)
	validator, err := services.NewSQLValidator(cfg.ExtensionDir)
	if err != nil {
		obslib.LogFatal(ctx, "Failed to create SQL validator", obslib.Error(err))
	}
	defer validator.Close()

	// Initialize per-tenant queue
	tenantQueue := services.NewTenantQueue()

	// Initialize handlers
	flightSQLHandler := handlers.NewFlightSQLHandler(manager)
	agentHandler := handlers.NewAgentHandler(manager, validator, tenantQueue)

	// Setup router
	r := chi.NewRouter()
	setupMiddleware(r)
	setupRoutes(r, flightSQLHandler, agentHandler)

	// Create server
	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      r,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
		IdleTimeout:  idleTimeout,
	}

	// Start server
	go func() {
		obslib.LogInfo(context.Background(), "Analytics Engine listening", obslib.String("port", port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			obslib.LogFatal(context.Background(), "Failed to start server", obslib.Error(err))
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	obslib.LogInfo(ctx, "Shutting down server")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		obslib.LogFatal(shutdownCtx, "Server forced to shutdown", obslib.Error(err))
	}

	obslib.LogInfo(ctx, "Server exited")
	_ = obslib.ShutdownObservability(shutdownCtx)
}

func setupMiddleware(r *chi.Mux) {
	r.Use(middleware.RealIP)
	r.Use(obslib.RequestIDMiddleware)
	r.Use(obslib.HTTPTraceMiddleware)
	r.Use(authMiddleware.AuthMiddleware)

	// CORS middleware - handle OPTIONS requests and set CORS headers
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			} else {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Max-Age", "3600")

			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}

			next.ServeHTTP(w, r)
		})
	})

	r.Use(obslib.LoggingMiddleware)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(requestTimeout))
}

func setupRoutes(r *chi.Mux, flightSQLHandler *handlers.FlightSQLHandler, agentHandler *handlers.AgentHandler) {
	// Prometheus metrics endpoint
	r.Handle("/metrics", obslib.MetricsHandler())

	// Health and readiness endpoints
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"healthy","duckdb_available":true}`))
	})
	r.Get("/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// FlightSQL Proxy API (connection-based) — GUI path, unchanged
	r.Route("/api/flightsql", func(r chi.Router) {
		r.Post("/connect", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.Connect)).ServeHTTP)
		r.Post("/disconnect", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.Disconnect)).ServeHTTP)
		r.Post("/query", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.Query)).ServeHTTP)
		r.Post("/upload", ratelimit.RateLimitUpload(http.HandlerFunc(flightSQLHandler.Upload)).ServeHTTP)
		r.Post("/load-arrow", ratelimit.RateLimitUpload(http.HandlerFunc(flightSQLHandler.LoadArrow)).ServeHTTP)
		r.Post("/load-objects", ratelimit.RateLimitUpload(http.HandlerFunc(flightSQLHandler.LoadObjects)).ServeHTTP)
	})

	// Dataset APIs (called directly by GUI) — unchanged
	r.Post("/api/v1/datasets/preview", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.DatasetPreview)).ServeHTTP)
	r.Post("/api/v1/datasets/stats", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.DatasetStats)).ServeHTTP)
	r.Post("/api/v1/datasets/histogram", ratelimit.RateLimitQuery(http.HandlerFunc(flightSQLHandler.DatasetHistogram)).ServeHTTP)

	// Agent API — policy-enforced endpoints for MCP shim traffic
	// All routes require JWT with agentstudio.project_id claim.
	// SQL queries go through AST validation, per-tenant queue, and statement timeout.
	// Cache is disabled on this path (SQL-only key is a cross-tenant leak vector).
	r.Route("/api/v1/agent", func(r chi.Router) {
		r.Use(ratelimit.RateLimitAgent)
		r.Post("/query", agentHandler.AgentQuery)
		r.Post("/describe", agentHandler.AgentDescribe)
		r.Post("/datasets", agentHandler.AgentDatasets)
		r.Post("/preview", agentHandler.AgentPreview)
		r.Post("/stats", agentHandler.AgentStats)
		r.Post("/histogram", agentHandler.AgentHistogram)
	})
}
