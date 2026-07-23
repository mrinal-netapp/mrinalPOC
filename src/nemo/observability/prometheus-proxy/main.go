// agent-studio-prometheus-proxy sits between Grafana and Prometheus.
// It enforces per-user project-level authorization on every PromQL query
// by rewriting queries before forwarding them to Prometheus.
//
// Environment variables (all required unless noted):
//
//	PROMETHEUS_UPSTREAM_URL    In-cluster Prometheus HTTP API URL.
//	                           e.g. http://prometheus-prometheus.monitoring.svc.cluster.local:9090
//	GRAFANA_PROXY_URL          In-cluster URL of grafana-proxy for /.internal/projects calls.
//	                           e.g. http://grafana-proxy.monitoring.svc.cluster.local:8080
//	INTERNAL_TOKEN             Shared secret for grafana-proxy /.internal/projects endpoint.
//	LISTEN_ADDR                (optional) default :9091
//	PROJECT_CACHE_TTL_SECONDS  (optional) default 300
package main

import (
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"agentstudio/nemo/observability/prometheus-proxy/internal/proxy"
)

func main() {
	cfg := proxy.Config{
		PrometheusUpstreamURL: mustEnv("PROMETHEUS_UPSTREAM_URL"),
		GrafanaProxyURL:       mustEnv("GRAFANA_PROXY_URL"),
		InternalToken:         mustEnv("INTERNAL_TOKEN"),
		ProjectCacheTTL:       parseDurationSeconds("PROJECT_CACHE_TTL_SECONDS", 300),
	}

	srv, err := proxy.New(cfg)
	if err != nil {
		log.Fatalf("prometheus-proxy: init failed: %v", err)
	}

	addr := envOrDefault("LISTEN_ADDR", ":9091")
	log.Printf("prometheus-proxy: listening on %s", addr)
	log.Printf("prometheus-proxy: upstream prometheus = %s", cfg.PrometheusUpstreamURL)
	log.Printf("prometheus-proxy: grafana-proxy URL   = %s", cfg.GrafanaProxyURL)

	httpSrv := &http.Server{
		Addr:         addr,
		Handler:      srv.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("prometheus-proxy: server error: %v", err)
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("prometheus-proxy: required env %s is not set", key)
	}
	return v
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseDurationSeconds(key string, defaultSeconds int) time.Duration {
	if v := os.Getenv(key); v != "" {
		if s, err := strconv.Atoi(v); err == nil && s > 0 {
			return time.Duration(s) * time.Second
		}
	}
	return time.Duration(defaultSeconds) * time.Second
}
