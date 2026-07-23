// Package proxy implements the agent-studio-prometheus-proxy HTTP server.
//
// It sits between Grafana and Prometheus and enforces per-user project-level
// authorization on every PromQL query. For each incoming request it:
//
//  1. Reads the X-Grafana-User header (the user's Keycloak sub UUID, set by
//     Grafana because of dataproxy.send_user_header = true).
//  2. Fetches the user's role and allowed project IDs from grafana-proxy's
//     secured /.internal/projects endpoint (cached locally with a TTL).
//  3. Rewrites the PromQL query to enforce project_id ∈ allowedProjects.
//  4. Forwards the rewritten request to Prometheus.
//
// Admin users (role="Admin") bypass rewriting and are forwarded unchanged.
//
// PromQL rewriting strategy (regex-based; no external PromQL parser dependency):
//
//   Case 1 — query contains project_id matchers:
//     Replace all project_id=<op>"<value>" with project_id=~"^(p1|p2)$".
//     Covers all AgentStudio dashboard queries.
//
//   Case 2 — query has {...} selectors without project_id:
//     Inject project_id=~"^(p1|p2)$" into every selector block.
//
//   Case 3 — bare metric name (e.g. "up"):
//     Append {project_id=~"^(p1|p2)$"}.
//
//   Otherwise — block (return empty success response).
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Pre-compiled regexes used for PromQL label injection.
var (
	// Matches any project_id label matcher regardless of operator or value.
	reProjectID = regexp.MustCompile(`project_id\s*(?:=~|!=|!~|=)\s*"(?:[^"\\]|\\.)*"`)

	// Captures the quoted value inside a label matcher, e.g. the "proj-A" in
	// project_id=~"proj-A".  Used to extract the user's requested project IDs
	// so we can intersect them with the allowed list rather than replacing them.
	reMatcherValue = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)

	// Matches a complete {...} label selector block.
	reSelectorBlock = regexp.MustCompile(`\{([^{}]*)\}`)

	// Matches a bare identifier — used to detect a lone metric name with no
	// label selector, offset, or other qualifier.
	reBareName = regexp.MustCompile(`^[a-zA-Z_:][a-zA-Z0-9_:]*$`)

	// Matches any letter or underscore — used to detect metric references in a
	// query string so we can distinguish pure numeric scalars (safe to pass
	// through) from queries that reference metrics (must be rewritten or blocked).
	reHasIdentifier = regexp.MustCompile(`[a-zA-Z_:]`)
)

// Config holds all runtime configuration for the proxy.
type Config struct {
	// PrometheusUpstreamURL is the in-cluster URL of the Prometheus HTTP API.
	// e.g. http://prometheus-prometheus.monitoring.svc.cluster.local:9090
	PrometheusUpstreamURL string

	// GrafanaProxyURL is the in-cluster URL of the grafana-proxy service.
	// Used to call /.internal/projects for per-user project lookup.
	// e.g. http://grafana-proxy.monitoring.svc.cluster.local:8080
	GrafanaProxyURL string

	// InternalToken is the shared secret used to authenticate calls to
	// grafana-proxy's /.internal/projects endpoint.
	InternalToken string

	// ProjectCacheTTL controls how long per-user project lists are cached.
	ProjectCacheTTL time.Duration
}

// cachedUser holds a locally cached copy of a user's role and project list.
type cachedUser struct {
	role     string
	projects []string
	cachedAt time.Time
}

// Server is the HTTP server implementing the proxy.
type Server struct {
	cfg          Config
	reverseProxy *httputil.ReverseProxy
	httpClient   *http.Client
	cacheMu      sync.RWMutex
	cache        map[string]*cachedUser // keyed by Keycloak sub UUID
}

// New creates a Server from the provided Config.
func New(cfg Config) (*Server, error) {
	if cfg.ProjectCacheTTL == 0 {
		cfg.ProjectCacheTTL = 5 * time.Minute
	}

	upstreamURL, err := url.Parse(cfg.PrometheusUpstreamURL)
	if err != nil {
		return nil, fmt.Errorf("invalid PROMETHEUS_UPSTREAM_URL: %w", err)
	}

	rp := httputil.NewSingleHostReverseProxy(upstreamURL)
	// Remove the X-Grafana-User header from requests forwarded to Prometheus —
	// Prometheus ignores it, but we strip it for hygiene.
	original := rp.Director
	rp.Director = func(req *http.Request) {
		original(req)
		// NewSingleHostReverseProxy rewrites req.URL.Host to the upstream but
		// leaves req.Host (the outgoing Host/authority header) set to the
		// inbound value. Inside a service mesh that routes outbound HTTP by
		// authority, that stale Host misses the upstream's route and is sent
		// plaintext via the passthrough cluster, which a STRICT-mTLS upstream
		// rejects ("connection termination"). Force the authority to the
		// upstream host so the mesh applies mTLS and routes to Prometheus.
		req.Host = upstreamURL.Host
		req.Header.Del("X-Grafana-User")
	}

	return &Server{
		cfg:          cfg,
		reverseProxy: rp,
		httpClient:   &http.Client{Timeout: 10 * time.Second},
		cache:        make(map[string]*cachedUser),
	}, nil
}

// Handler returns the root http.Handler for the proxy server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	// PromQL instant and range query endpoints.
	mux.HandleFunc("/api/v1/query", s.handleQuery)
	mux.HandleFunc("/api/v1/query_range", s.handleQuery)
	// Label values — special-cased for project_id.
	mux.HandleFunc("/api/v1/label/", s.handleLabel)
	// Series metadata — restrict match[] selectors.
	mux.HandleFunc("/api/v1/series", s.handleSeries)
	// All other Prometheus endpoints — forward for admin; block for others.
	mux.HandleFunc("/", s.handlePassthrough)
	return mux
}

// handleHealth is a simple liveness probe.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// handleQuery handles GET/POST /api/v1/query and /api/v1/query_range.
// It rewrites the `query` parameter to enforce project scope.
func (s *Server) handleQuery(w http.ResponseWriter, r *http.Request) {
	sub := r.Header.Get("X-Grafana-User")
	if sub == "" {
		// No user context — Grafana internal health / datasource test ping.
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	info, err := s.getUserInfo(r.Context(), sub)
	if err != nil {
		log.Printf("[prom-proxy] getUserInfo sub=%s: %v", sanitizeForLog(sub), err)
		http.Error(w, "project scope unavailable — please reload Grafana", http.StatusServiceUnavailable)
		return
	}

	// Admin: full access, no rewriting.
	if info.role == "Admin" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	// Extract the query string from GET param or POST form body.
	queryStr, formValues, isPost, err := extractQueryParam(r)
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	if queryStr == "" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	rewritten, ok := rewriteQuery(queryStr, info.projects)
	if !ok {
		log.Printf("[prom-proxy] blocked unscoped query from sub=%s: %q", sanitizeForLog(sub), queryStr)
		writeEmptyPrometheusResult(w, r.URL.Path)
		return
	}

	// Rebuild the request with the rewritten query.
	outReq := r.Clone(r.Context())
	if isPost {
		formValues.Set("query", rewritten)
		encoded := formValues.Encode()
		outReq.Body = io.NopCloser(bytes.NewBufferString(encoded))
		outReq.ContentLength = int64(len(encoded))
		outReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		q := outReq.URL.Query()
		q.Set("query", rewritten)
		outReq.URL.RawQuery = q.Encode()
	}

	s.reverseProxy.ServeHTTP(w, outReq)
}

// handleLabel handles GET /api/v1/label/{name}/values.
// For the project_id label it returns the user's allowed projects directly.
// For all other labels it adds a project-scoped match[] selector.
func (s *Server) handleLabel(w http.ResponseWriter, r *http.Request) {
	sub := r.Header.Get("X-Grafana-User")
	if sub == "" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	info, err := s.getUserInfo(r.Context(), sub)
	if err != nil {
		log.Printf("[prom-proxy] getUserInfo sub=%s: %v", sanitizeForLog(sub), err)
		http.Error(w, "project scope unavailable", http.StatusServiceUnavailable)
		return
	}

	if info.role == "Admin" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	// /api/v1/label/project_id/values → return allowed projects directly.
	labelName := labelNameFromPath(r.URL.Path)
	if labelName == "project_id" {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status": "success",
			"data":   info.projects,
		})
		return
	}

	// For all other label names, inject a project-scoped match[] to restrict
	// the label values to series belonging to this user's projects.
	outReq := s.injectProjectMatchSelector(r, info.projects)
	s.reverseProxy.ServeHTTP(w, outReq)
}

// handleSeries handles GET /api/v1/series.
// It rewrites the match[] parameters to restrict to project-scoped series.
func (s *Server) handleSeries(w http.ResponseWriter, r *http.Request) {
	sub := r.Header.Get("X-Grafana-User")
	if sub == "" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	info, err := s.getUserInfo(r.Context(), sub)
	if err != nil {
		log.Printf("[prom-proxy] getUserInfo sub=%s: %v", sanitizeForLog(sub), err)
		http.Error(w, "project scope unavailable", http.StatusServiceUnavailable)
		return
	}

	if info.role == "Admin" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	outReq := s.injectProjectMatchSelector(r, info.projects)
	s.reverseProxy.ServeHTTP(w, outReq)
}

// handlePassthrough forwards admin requests unchanged and blocks non-admin
// requests for Prometheus endpoints that are not specifically handled above
// (e.g. /api/v1/targets, /api/v1/metadata).
func (s *Server) handlePassthrough(w http.ResponseWriter, r *http.Request) {
	sub := r.Header.Get("X-Grafana-User")
	if sub == "" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	info, err := s.getUserInfo(r.Context(), sub)
	if err != nil {
		// Fail closed: if we cannot determine the user's role, deny access
		// rather than forwarding an unscoped request to Prometheus.
		log.Printf("[prom-proxy] getUserInfo failed for passthrough sub=%s path=%s: %v", sanitizeForLog(sub), r.URL.Path, err)
		http.Error(w, "project scope unavailable — please reload Grafana", http.StatusServiceUnavailable)
		return
	}

	if info.role == "Admin" {
		s.reverseProxy.ServeHTTP(w, r)
		return
	}

	log.Printf("[prom-proxy] blocked non-admin passthrough sub=%s path=%s", sanitizeForLog(sub), r.URL.Path)
	http.Error(w, "forbidden", http.StatusForbidden)
}

// getUserInfo returns the cached role and project list for the given sub UUID,
// fetching from grafana-proxy's /.internal/projects endpoint if needed.
func (s *Server) getUserInfo(ctx context.Context, sub string) (*cachedUser, error) {
	s.cacheMu.RLock()
	entry, ok := s.cache[sub]
	s.cacheMu.RUnlock()
	if ok && time.Since(entry.cachedAt) <= s.cfg.ProjectCacheTTL {
		return entry, nil
	}

	type internalResp struct {
		Sub      string   `json:"sub"`
		Role     string   `json:"role"`
		Projects []string `json:"projects"`
	}

	reqURL := s.cfg.GrafanaProxyURL + "/.internal/projects?sub=" + url.QueryEscape(sub)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.InternalToken)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call /.internal/projects: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("sub %s not in grafana-proxy cache (reload Grafana to re-login)", sub)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("/.internal/projects returned HTTP %d", resp.StatusCode)
	}

	var result internalResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}

	cu := &cachedUser{
		role:     result.Role,
		projects: result.Projects,
		cachedAt: time.Now(),
	}
	s.cacheMu.Lock()
	s.cache[sub] = cu
	s.cacheMu.Unlock()

	return cu, nil
}

// injectProjectMatchSelector rewrites match[] parameters on the request URL to
// restrict series to the user's allowed projects.
//
// When allowedProjects is empty the user has no project memberships.  Rather
// than returning the original request unchanged (which would expose all
// Prometheus series), we inject a selector that can never match any series,
// so the response is empty but well-formed.
func (s *Server) injectProjectMatchSelector(r *http.Request, allowedProjects []string) *http.Request {
	outReq := r.Clone(r.Context())
	q := outReq.URL.Query()

	if len(allowedProjects) == 0 {
		// No project memberships — inject a selector that matches nothing so
		// Prometheus returns an empty result set instead of all data.
		q.Set("match[]", `{project_id=~"(?!x)x"}`)
		outReq.URL.RawQuery = q.Encode()
		return outReq
	}

	existing := q["match[]"]
	if len(existing) == 0 {
		// No match[] — add one that scopes to the user's projects.
		q.Add("match[]", projectIDSelector(allowedProjects))
	} else {
		rewritten := make([]string, len(existing))
		for i, m := range existing {
			rw, ok := rewriteQuery(m, allowedProjects)
			if !ok {
				rw = projectIDSelector(allowedProjects)
			}
			rewritten[i] = rw
		}
		q["match[]"] = rewritten
	}

	outReq.URL.RawQuery = q.Encode()
	return outReq
}

// rewriteQuery enforces project scope on a single PromQL expression string.
// Returns (rewritten, true) on success, ("", false) when the query contains
// metric references that cannot be safely scoped (e.g. complex expressions
// without any label selectors). Pure numeric/scalar expressions (no identifiers)
// are passed through unchanged as they carry no metric data.
func rewriteQuery(query string, allowedProjects []string) (string, bool) {
	if len(allowedProjects) == 0 {
		return "", false
	}

	buildEnforcement := func(projects []string) string {
		escaped := make([]string, len(projects))
		for i, p := range projects {
			escaped[i] = regexp.QuoteMeta(p)
		}
		return `project_id=~"^(` + strings.Join(escaped, `|`) + `)$"`
	}

	// Case 1: query already contains project_id matchers.
	//
	// Rather than replacing with ALL allowed projects unconditionally (which
	// would ignore the user's dropdown selection), we intersect the requested
	// project IDs with the allowed list for positive matchers (=, =~):
	//   - User selects project-A  → enforcement uses [project-A]   ← selection respected
	//   - User selects all        → enforcement uses all allowed    ← no change
	//   - URL-tampering attempt   → invalid IDs filtered out; falls back to all allowed
	//
	// For negation matchers (!=, !~) the semantics cannot be inverted safely,
	// so we always replace with the full allowed list.
	//
	// Security guarantee is preserved: the result is always a subset of allowedProjects.
	if reProjectID.MatchString(query) {
		return reProjectID.ReplaceAllStringFunc(query, func(match string) string {
			// Negation operators cannot be intersected — fall back to full list.
			if strings.Contains(match, "!=") || strings.Contains(match, "!~") {
				return buildEnforcement(allowedProjects)
			}
			requested := extractMatcherValue(match)
			effective := intersectRequestedProjects(requested, allowedProjects)
			return buildEnforcement(effective)
		}), true
	}

	// Cases 2 and 3 have no existing project_id — inject the full allowed list.
	// (The user has no project selection to respect; enforce the full scope.)
	fullEnforcement := buildEnforcement(allowedProjects)

	// Case 2: query has {...} label selectors without project_id — inject into each.
	if strings.Contains(query, "{") {
		result := reSelectorBlock.ReplaceAllStringFunc(query, func(block string) string {
			inner := block[1 : len(block)-1]
			if strings.TrimSpace(inner) == "" {
				return `{` + fullEnforcement + `}`
			}
			return `{` + inner + `, ` + fullEnforcement + `}`
		})
		return result, true
	}

	trimmed := strings.TrimSpace(query)

	// Case 3: bare metric name (e.g. "up") — append a label selector.
	if reBareName.MatchString(trimmed) {
		return trimmed + `{` + fullEnforcement + `}`, true
	}

	// Pure scalar/numeric expression (no identifiers) — safe to pass through.
	// Examples: "1+1", "scalar(1)", pure arithmetic.
	if !reHasIdentifier.MatchString(trimmed) {
		return query, true
	}

	// Has identifiers but no selectors and is not a bare metric name.
	// Cannot enforce project scope safely — block.
	return "", false
}

// extractMatcherValue returns the unquoted string between the first pair of
// double quotes in a label matcher, e.g. given `project_id=~"proj-A"` it
// returns `proj-A`.  Returns "" when no quoted value is found.
func extractMatcherValue(matcher string) string {
	m := reMatcherValue.FindStringSubmatch(matcher)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// intersectRequestedProjects parses the project IDs from a Grafana-interpolated
// matcher value and returns the subset that is present in allowedProjects.
//
// Grafana multi-value variable patterns handled:
//
//	"project-A"              → single selection
//	"project-A|project-B"   → multi-selection
//	"(project-A|project-B)" → grouped multi-selection
//	"^(project-A|project-B)$" → anchored (used when $__all expands)
//
// If the value contains regex metacharacters (wildcards, character classes,
// quantifiers, etc.) it cannot be safely parsed as a list of literal IDs and
// the full allowedProjects list is returned as a safe fallback.
func intersectRequestedProjects(value string, allowedProjects []string) []string {
	allowedSet := make(map[string]bool, len(allowedProjects))
	for _, p := range allowedProjects {
		allowedSet[p] = true
	}

	// Strip the anchors and grouping that Grafana adds around multi-value
	// expansions: ^, $, (, ).
	v := strings.TrimPrefix(value, "^")
	v = strings.TrimSuffix(v, "$")
	v = strings.TrimPrefix(v, "(")
	v = strings.TrimSuffix(v, ")")

	parts := strings.Split(v, "|")
	intersection := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		// If the part contains regex metacharacters it is a pattern, not a
		// literal project ID — fall back to the full allowed list to avoid
		// both false positives and false negatives.
		if strings.ContainsAny(p, `.*+?[]{}()^\$\`) {
			return allowedProjects
		}
		if allowedSet[p] {
			intersection = append(intersection, p)
		}
		// IDs not in the allowed list are silently dropped (security boundary).
	}

	if len(intersection) == 0 {
		// Nothing in the request was a valid allowed project (e.g. stale
		// dashboard state after project removal) — show all allowed projects.
		return allowedProjects
	}
	return intersection
}

// projectIDSelector builds a bare PromQL selector that restricts to the
// user's allowed projects, e.g. {project_id=~"^(projA|projB)$"}.
func projectIDSelector(allowedProjects []string) string {
	escaped := make([]string, len(allowedProjects))
	for i, p := range allowedProjects {
		escaped[i] = regexp.QuoteMeta(p)
	}
	return `{project_id=~"^(` + strings.Join(escaped, `|`) + `)$"}`
}

// extractQueryParam reads the `query` parameter from a GET URL or POST form body.
// Returns the query string, the parsed form values (for POST), a boolean
// indicating POST, and any read error.
func extractQueryParam(r *http.Request) (query string, form url.Values, isPost bool, err error) {
	if r.Method == http.MethodPost {
		// Limit body size to 1 MiB to prevent memory exhaustion.
		body, readErr := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if readErr != nil {
			return "", nil, true, readErr
		}
		// Restore r.Body so the original request can be forwarded unchanged
		// when we decide not to rewrite (e.g. empty query string).
		r.Body = io.NopCloser(bytes.NewReader(body))
		form, err = url.ParseQuery(string(body))
		if err != nil {
			return "", nil, true, err
		}
		return form.Get("query"), form, true, nil
	}
	return r.URL.Query().Get("query"), nil, false, nil
}

// sanitizeForLog replaces control characters (newlines, carriage returns, and
// other ASCII control codes) in user-supplied strings with underscores before
// they are written to log output, preventing log-injection attacks.
func sanitizeForLog(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || (r < 0x20 && r != '\t') {
			return '_'
		}
		return r
	}, s)
}

// labelNameFromPath extracts the label name from a path of the form
// /api/v1/label/{name}/values.
func labelNameFromPath(path string) string {
	// path: /api/v1/label/exported_service_name/values
	parts := strings.Split(strings.Trim(path, "/"), "/")
	// parts: ["api", "v1", "label", "{name}", "values"]
	if len(parts) >= 5 && parts[4] == "values" {
		return parts[3]
	}
	return ""
}

// writeEmptyPrometheusResult writes a valid empty Prometheus API success
// response so Grafana shows "no data" rather than a parse error.
//
// The resultType must match the endpoint:
//   - /api/v1/query        → "vector"  (instant query)
//   - /api/v1/query_range  → "matrix"  (range query)
//
// Returning the wrong resultType causes Grafana to throw a parse error on
// the panel instead of silently showing "No data".
func writeEmptyPrometheusResult(w http.ResponseWriter, path string) {
	resultType := "vector"
	if strings.HasSuffix(path, "/query_range") {
		resultType = "matrix"
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "success",
		"data": map[string]any{
			"resultType": resultType,
			"result":     []any{},
		},
	})
}
