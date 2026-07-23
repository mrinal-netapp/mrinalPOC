package observability_client_runtime

import (
	"strings"
)

func appendSignalPath(endpoint, exportPath string) string {
	if strings.HasSuffix(endpoint, "/") {
		return endpoint + exportPath
	}
	return endpoint + "/" + exportPath
}

// NormalizeOTLPHttpTracesEndpoint ensures the URL ends with /v1/traces.
func NormalizeOTLPHttpTracesEndpoint(url string) string {
	u := strings.TrimSpace(url)
	if u == "" {
		return u
	}
	base := strings.TrimRight(u, "/")
	if strings.HasSuffix(strings.ToLower(base), "v1/traces") {
		return base
	}
	return appendSignalPath(strings.TrimRight(u, "/"), "v1/traces")
}

// NormalizeOTLPHttpMetricsEndpoint ensures the URL ends with /v1/metrics.
func NormalizeOTLPHttpMetricsEndpoint(url string) string {
	u := strings.TrimSpace(url)
	if u == "" {
		return u
	}
	base := strings.TrimRight(u, "/")
	if strings.HasSuffix(strings.ToLower(base), "v1/metrics") {
		return base
	}
	return appendSignalPath(strings.TrimRight(u, "/"), "v1/metrics")
}
