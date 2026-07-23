package main

import (
	"agentstudio/nemo/gateway/proxy"
	"agentstudio/nemo/gateway/swagger"
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	obslib "github.com/NetApp-Nemo/AgentStudio/src/common-go/observability/observability-client/observability_client_runtime"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Post-Istio-migration footprint of `apigateway-service`.
//
// Before this PR the service was the single entry point for every public
// hostname: subdomain dispatch, JWT validation, X-User-* injection,
// reverse-proxying to every backend, S3 SigV4 re-signing, workspace
// dynamic backend selection, and Swagger UI. The Istio gateway now does
// the first three (RequestAuthentication + Lua EnvoyFilter for parity
// headers) and the per-hostname HTTPRoutes route directly to backends.
//
// What's left here:
//   - Health / ready / metrics (pod-local plumbing).
//   - /s3/* path mount (S3 SigV4 re-signing -- non-trivial crypto, can't
//     be expressed declaratively).
//   - /api-docs/* Swagger UI (kept until follow-up PR-D extracts it).
//   - ws-*.<endpoint> + s3.<endpoint> host catch-all (workspace dynamic
//     backend selection + S3 subdomain routing -- both non-declarative).
//
// JWT validation, X-User-* injection, and per-host/per-path reverse
// proxies for `auth.*`, `catalog.*`, `workflows.*`, `phoenix.*`,
// `/config/*`, `/console/*`, `/kb/*`, `/agents/*`, `/analytics/*`,
// `/workflow/*`, `/prometheus/*`, `/internal/lakekeeper/*`,
// `/internal/temporal/*`, `/auth/introspect` are gone -- handled by
// the edge tier (deployments/helm/edge/).

// Response Content-Types that may be gzip/deflate-compressed for S3 (s3.<endpoint>) traffic.
// application/octet-stream is intentionally omitted so object GET/PUT bodies stay raw.
var s3CompressibleContentTypes = []string{
	"text/html",
	"text/css",
	"text/plain",
	"text/javascript",
	"text/xml",
	"application/javascript",
	"application/x-javascript",
	"application/json",
	"application/xml",
	"application/atom+xml",
	"application/rss+xml",
	"image/svg+xml",
}

var (
	s3CompressedHandler http.Handler
	initS3Compressed    sync.Once
)

func s3GatewayCompressed() http.Handler {
	initS3Compressed.Do(func() {
		base := proxy.BuildS3Proxy()
		s3CompressedHandler = middleware.Compress(5, s3CompressibleContentTypes...)(base)
	})
	return s3CompressedHandler
}

const (
	defaultPort       = "8080"
	shutdownTimeout   = 30 * time.Second
	readHeaderTimeout = 15 * time.Second  // limit for reading request headers only
	writeTimeout      = 300 * time.Second // 5 minutes — SSE/streaming responses need a long write window
	idleTimeout       = 60 * time.Second
	requestTimeout    = 300 * time.Second // 5 minutes — matches writeTimeout for long-running operations and SSE streams
)

// setupRoutes configures all routes for the gateway.
//
// Reduced to: health/ready/metrics, root (with S3-host fallthrough),
// /s3 mount, /api-docs (Swagger UI), and the workspace-host catch-all.
func setupRoutes(r chi.Router) {
	// Prometheus metrics endpoint (no auth required)
	r.Handle("/metrics", obslib.MetricsHandler())

	// Health check endpoint
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Readiness check endpoint
	r.Get("/ready", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	// Root endpoint - only for non-S3 subdomains.
	// S3 subdomain requests (including root /) must be routed to the S3 gateway.
	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		if proxy.IsS3Subdomain(r.Host) || proxy.IsS3Request(r) {
			obslib.LogDebug(r.Context(), "Routing S3 root request", obslib.String("host", r.Host))
			s3GatewayCompressed().ServeHTTP(w, r)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{
			"service": "AgentStudio Gateway",
			"version": "1.0.0",
			"status": "running"
		}`))
	})

	// /s3 path-style entry point so browser uploads can stay same-origin.
	// Eliminates the need for users to separately accept the s3.<endpoint>
	// certificate. http.StripPrefix removes /s3 before BuildS3Proxy sees the
	// request, so /s3/<bucket>/<key> becomes /<bucket>/<key> (standard
	// path-style addressing).
	r.Mount("/s3", http.StripPrefix("/s3", s3GatewayCompressed()))
	obslib.LogInfo(context.Background(), "Mounted S3 proxy at /s3 (same-origin path for browser uploads)")

	// Swagger UI for consolidated API documentation. Stays here until
	// follow-up PR-D extracts it to a stock swagger-ui Deployment.
	if err := swagger.SetupSwaggerUI(r, "/api-docs"); err != nil {
		obslib.LogWarn(context.Background(), "Failed to setup Swagger UI", obslib.Error(err))
	}

	// Catch-all: handle workspace + S3 host dispatch.
	// Order: Workspace -> S3 -> 404. Keycloak / Catalog / Workflows /
	// Phoenix subdomains and per-path reverse proxies are gone -- the
	// Istio gateway routes those directly to their backends.
	r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Workspace public hosts: ws-<id>.<endpoint>. Single label so the
		// cluster wildcard *.<endpoint> covers them.
		if proxy.IsWorkspaceSubdomain(r.Host) {
			obslib.LogDebug(r.Context(), "Routing to workspace service", obslib.String("host", r.Host))
			proxy.BuildWorkspaceProxy().ServeHTTP(w, r)
			return
		}

		// S3 subdomain or direct S3 request (e.g., from lakekeeper).
		if proxy.IsS3Subdomain(r.Host) || proxy.IsS3Request(r) {
			obslib.LogDebug(r.Context(), "Routing to S3 gateway",
				obslib.String("host", r.Host),
				obslib.Bool("subdomain", proxy.IsS3Subdomain(r.Host)),
				obslib.Bool("direct", proxy.IsS3Request(r)),
			)
			s3GatewayCompressed().ServeHTTP(w, r)
			return
		}

		http.NotFound(w, r)
	}))
}

// setupMiddleware configures middleware for the router.
//
// JWT validation moved to the Istio gateway (RequestAuthentication +
// Lua EnvoyFilter). The remaining middleware is request-id, tracing,
// logging, panic recovery, and the per-request timeout.
func setupMiddleware(r chi.Router) {
	r.Use(middleware.RealIP)
	r.Use(obslib.RequestIDMiddleware)
	r.Use(obslib.HTTPTraceMiddleware)
	r.Use(obslib.LoggingMiddleware)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(requestTimeout))
}

// createServer creates and configures the HTTP server
func createServer(port string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}
}

// startServer starts the HTTP server in a goroutine
func startServer(srv *http.Server, port string) {
	go func() {
		obslib.LogInfo(context.Background(), "AgentStudio Gateway listening", obslib.String("port", port))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			obslib.LogFatal(context.Background(), "Failed to start server", obslib.Error(err))
		}
	}()
}

// waitForShutdown waits for interrupt signal and gracefully shuts down the server
func waitForShutdown(srv *http.Server) {
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	obslib.LogInfo(context.Background(), "Shutting down server")

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		obslib.LogFatal(ctx, "Server forced to shutdown", obslib.Error(err))
	}

	obslib.LogInfo(context.Background(), "Server exited")
}

// getPort returns the port from environment or default
func getPort() string {
	port := os.Getenv("PORT")
	if port == "" {
		return defaultPort
	}
	return port
}

func main() {
	ctx := context.Background()

	if err := obslib.ConfigureLoggingFromPackagedDefault(); err != nil {
		log.Fatalf("observability init failed: %v", err)
	}

	port := getPort()

	r := chi.NewRouter()
	setupMiddleware(r)
	setupRoutes(r)

	srv := createServer(port, r)
	startServer(srv, port)

	waitForShutdown(srv)

	_ = obslib.ShutdownObservability(ctx)
}
