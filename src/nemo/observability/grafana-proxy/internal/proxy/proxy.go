// Package proxy implements the agent-studio-grafana-proxy HTTP server.
//
// Responsibilities:
//  1. OIDC authorization-code flow using the `agentstudio-grafana-proxy` Keycloak client.
//  2. On first login: call config-service to fetch the user's project list; cache it in session.
//  3. Expose GET /.auth/projects — read by Grafana's Infinity datasource to populate the
//     $project template variable. The user is identified via the ?user=<sub> query parameter
//     that Grafana interpolates from ${__user.login} before calling the Infinity plugin.
//  4. Forward all other traffic to Grafana with X-WEBAUTH-USER, X-WEBAUTH-ROLE,
//     X-WEBAUTH-EMAIL, and X-WEBAUTH-NAME headers injected.
//
// Project list cache:
//
//	The cache is a simple in-memory map keyed by sub (Keycloak UUID). Entries
//	are re-warmed from the session on every browser request through handleProxy.
//	handleAuthProjects serves the cached data even when the TTL has elapsed —
//	returning stale-but-valid data is always better than returning [] and breaking
//	the $project dropdown. The cache is refreshed on the next browser navigation.
//
// Backchannel logout:
//
//	When a user logs out of any Keycloak client (e.g. Agent Studio), Keycloak
//	POSTs a signed logout token to POST /oauth2/backchannel-logout.  The proxy
//	records the sub + revocation time in an in-memory map.  Every subsequent
//	request that carries a proxy session for that sub (created before the
//	revocation) is rejected and redirected to a fresh login — ensuring that
//	switching users in another app is reflected in Grafana immediately.
package proxy

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/gorilla/securecookie"
	"golang.org/x/oauth2"

	"agentstudio/nemo/observability/grafana-proxy/internal/configsvc"
	"agentstudio/nemo/observability/grafana-proxy/internal/session"
)

// proxyHeadersKey is the context key used to pass auth headers from
// handleProxy into the Director without a data race.
type proxyHeadersKey struct{}

// proxyHeaders carries the X-WEBAUTH-* values that the Director should inject
// after stripping any client-supplied spoofed copies.
type proxyHeaders struct {
	user  string
	role  string
	email string
	name  string
}

// Config holds all runtime configuration for the proxy.
type Config struct {
	// Keycloak OIDC settings.
	//
	// KeycloakIssuer is the server-side (internal / backchannel) issuer URL used
	// for token-exchange requests from the proxy pod itself.  In a cluster with
	// TLS termination at the ingress this should be the in-cluster HTTP URL so
	// the proxy can talk to Keycloak without going through the external gateway.
	// e.g. http://keycloak.agent-studio-identity.svc.cluster.local:8080/realms/nemo
	//
	// KeycloakPublicIssuer (optional) is the browser-facing HTTPS URL used when
	// generating the authorization-code redirect that the end-user's browser
	// follows.  It must be the external HTTPS hostname so that Keycloak sets
	// Secure session cookies on the correct domain.  If unset it falls back to
	// KeycloakIssuer (suitable when a single URL works for both paths).
	// e.g. https://auth.agentstudio.local:8443/realms/nemo
	KeycloakIssuer       string
	KeycloakPublicIssuer string
	ClientID             string
	ClientSecret         string
	RedirectURI          string // e.g. https://grafana.agentstudio.local/oauth2/callback
	PlatformAdminRole    string // realm role that grants Admin access (default: platform-admin)
	TLSSkipVerify        bool   // allow self-signed certs in local dev

	// Upstream Grafana.
	GrafanaUpstreamURL string // e.g. http://prometheus-grafana.monitoring.svc.cluster.local:80

	// config-service.
	ConfigServiceURL string // e.g. http://config-service.agentstudio.svc.cluster.local:8080

	// Session.
	SessionHashKey  []byte
	SessionBlockKey []byte // must be 16, 24 or 32 bytes for AES
	SessionTTL      time.Duration

	// Project list cache TTL (independent of session TTL).
	ProjectCacheTTL time.Duration

	// InternalToken is a shared secret used to authenticate machine-to-machine
	// calls from prometheus-proxy to /.internal/projects.  When empty the
	// endpoint is disabled (returns 401 on every request).
	InternalToken string
}

// projectCacheEntry is one entry in the per-sub project cache.
type projectCacheEntry struct {
	projects []session.Project
	role     string
	cachedAt time.Time
}

// Server is the HTTP server implementing the proxy.
type Server struct {
	cfg          Config
	oauth2Cfg    *oauth2.Config
	sessions     *session.Store
	reverseProxy *httputil.ReverseProxy
	configClient *configsvc.Client

	// stateCookieCodec signs+encrypts the short-lived oauth_state cookie used
	// to store the CSRF nonce and post-login destination across the OIDC
	// redirect round-trip.  Uses the same key material as the session store.
	stateCookieCodec securecookie.Codec

	// jwksVerifier verifies JWT signatures using Keycloak's public JWKS.
	// Nil when the JWKS endpoint was unreachable at startup (warning logged).
	jwksVerifier   *JWKSVerifier
	jwksHTTPClient *http.Client

	cacheMu sync.RWMutex
	cache   map[string]*projectCacheEntry // keyed by sub

	// revokedMu / revokedSubs implement backchannel logout.
	// When Keycloak notifies us that a user's SSO session has ended, we record
	// sub → revocation time here.  handleProxy rejects any proxy session whose
	// sub is in this map AND whose session was created before the revocation.
	revokedMu   sync.RWMutex
	revokedSubs map[string]time.Time // sub → time Keycloak told us to log them out
}

// New creates a Server from the provided Config.
func New(cfg Config) (*Server, error) {
	if cfg.PlatformAdminRole == "" {
		cfg.PlatformAdminRole = "platform-admin"
	}
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 8 * time.Hour
	}
	if cfg.ProjectCacheTTL == 0 {
		cfg.ProjectCacheTTL = 5 * time.Minute
	}

	// Internal (backchannel) issuer — used for server-side token exchange.
	internalIssuer := strings.TrimSuffix(cfg.KeycloakIssuer, "/")

	// Public (browser-facing) issuer — used to build the authorization redirect
	// URL that the end-user's browser follows.  This MUST be the external HTTPS
	// hostname so that Keycloak sets its session cookies (AUTH_SESSION_ID /
	// KC_RESTART) with the Secure flag on the correct domain.  If the proxy and
	// Keycloak share a single reachable URL (e.g. in integration tests) leave
	// KeycloakPublicIssuer unset and it defaults to KeycloakIssuer.
	publicIssuer := internalIssuer
	if cfg.KeycloakPublicIssuer != "" {
		publicIssuer = strings.TrimSuffix(cfg.KeycloakPublicIssuer, "/")
	}

	oauth2Cfg := &oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		RedirectURL:  cfg.RedirectURI,
		Scopes:       []string{"openid", "profile", "email"},
		Endpoint: oauth2.Endpoint{
			// AuthURL points at the public HTTPS hostname so the browser redirect
			// lands on the correct Keycloak instance with Secure cookies.
			AuthURL: publicIssuer + "/protocol/openid-connect/auth",
			// TokenURL uses the internal URL for pod-to-pod token exchange,
			// avoiding the external gateway and its TLS certificate entirely.
			TokenURL: internalIssuer + "/protocol/openid-connect/token",
		},
	}

	upstreamURL, err := url.Parse(cfg.GrafanaUpstreamURL)
	if err != nil {
		return nil, fmt.Errorf("invalid GRAFANA_UPSTREAM_URL: %w", err)
	}
	rp := httputil.NewSingleHostReverseProxy(upstreamURL)

	if cfg.TLSSkipVerify {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // dev only
		rp.Transport = transport
		// Use InParams auth style so the token-exchange POST body carries the
		// client credentials rather than an Authorization header — needed for
		// some OIDC provider configurations in local dev.
		oauth2Cfg.Endpoint.AuthStyle = oauth2.AuthStyleInParams
		// Per-request TLS policy for oauth2 token exchanges is injected via
		// tlsContext(), which stores a TLS-skipping http.Client in the request
		// context where golang.org/x/oauth2 picks it up.
	}

	// Customise the reverse-proxy Director:
	//  1. Strip the proxy session cookie so Grafana never sees it.
	//  2. Strip Grafana's own session cookies (grafana_session, grafana_session_expiry)
	//     so Grafana always authenticates via the X-WEBAUTH-USER header we inject.
	//     Without this, a stale grafana_session from Alice would take precedence
	//     over X-WEBAUTH-USER: bob_sub, causing Bob to see Alice's dashboard context.
	//  3. Delete any X-WEBAUTH-* headers the browser might have injected
	//     (anti-spoofing: clients must not be able to forge identity).
	//  4. Re-inject the X-WEBAUTH-* values that *we* computed from the
	//     validated session.  These are passed via request context so they
	//     survive the outgoing-request clone that ReverseProxy makes before
	//     calling Director — setting them on the incoming `r` directly would
	//     have them wiped by step 3 above.
	originalDirector := rp.Director
	rp.Director = func(req *http.Request) {
		originalDirector(req)
		// NewSingleHostReverseProxy rewrites req.URL.Host to the upstream but
		// leaves req.Host (the outgoing Host/authority header) set to the
		// original client value (e.g. grafana.agentstudio.local:8443). Inside a
		// service mesh that routes outbound HTTP by authority, that stale Host
		// misses the upstream's route and is sent plaintext via the passthrough
		// cluster, which a STRICT-mTLS upstream rejects ("connection
		// termination"). Force the authority to the upstream host so the mesh
		// applies mTLS and routes to Grafana correctly.
		req.Host = upstreamURL.Host
		removeCookieByName(req, "grafana-proxy-session")
		removeCookieByPrefix(req, "grafana_")
		// Step 3: drop any client-supplied auth headers.
		req.Header.Del("X-WEBAUTH-USER")
		req.Header.Del("X-WEBAUTH-ROLE")
		req.Header.Del("X-WEBAUTH-EMAIL")
		req.Header.Del("X-WEBAUTH-NAME")
		// Step 4: inject the server-computed values from context.
		if ph, ok := req.Context().Value(proxyHeadersKey{}).(proxyHeaders); ok {
			req.Header.Set("X-WEBAUTH-USER", ph.user)
			req.Header.Set("X-WEBAUTH-ROLE", ph.role)
			if ph.email != "" {
				req.Header.Set("X-WEBAUTH-EMAIL", ph.email)
			}
			if ph.name != "" {
				req.Header.Set("X-WEBAUTH-NAME", ph.name)
			}
		}
	}

	// Secure cookie is true in production (TLS termination at ingress).
	// Set to false only in local dev where TLSSkipVerify is true.
	secureCookie := !cfg.TLSSkipVerify
	sessStore := session.New(cfg.SessionHashKey, cfg.SessionBlockKey, cfg.SessionTTL, secureCookie)

	// Build a dedicated HTTP client for JWKS fetching (same TLS policy as the proxy).
	jwksClient := &http.Client{Timeout: 10 * time.Second}
	if cfg.TLSSkipVerify {
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // dev only
		jwksClient = &http.Client{Transport: tr, Timeout: 10 * time.Second}
	}

	return &Server{
		cfg:              cfg,
		oauth2Cfg:        oauth2Cfg,
		sessions:         sessStore,
		reverseProxy:     rp,
		configClient:     configsvc.New(cfg.ConfigServiceURL),
		stateCookieCodec: securecookie.New(cfg.SessionHashKey, cfg.SessionBlockKey),
		jwksVerifier:     newJWKSVerifier(internalIssuer, jwksClient),
		jwksHTTPClient:   jwksClient,
		cache:            make(map[string]*projectCacheEntry),
		revokedSubs:      make(map[string]time.Time),
	}, nil
}

// Handler returns the root http.Handler for the proxy server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth2/callback", s.handleCallback)
	mux.HandleFunc("/oauth2/handoff", s.handleHandoff)
	mux.HandleFunc("/oauth2/logout", s.handleLogout)
	mux.HandleFunc("/oauth2/backchannel-logout", s.handleBackchannelLogout)
	mux.HandleFunc("/.auth/projects", s.handleAuthProjects)
	mux.HandleFunc("/.internal/projects", s.handleInternalProjects)
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/", s.handleProxy)
	return mux
}

// handleHealth is a simple liveness probe endpoint.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// handleProxy is the catch-all handler: validates the session and forwards to Grafana.
func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	us, err := s.sessions.Get(r)
	if err != nil {
		log.Printf("[proxy] session error: %v", err)
		s.redirectToLogin(w, r)
		return
	}
	if us == nil {
		s.redirectToLogin(w, r)
		return
	}

	// Backchannel logout check: if Keycloak notified us that this user's SSO
	// session ended after their proxy session was created, reject the session
	// and force a fresh login.  This fires when Alice logs out of Agent Studio
	// and Bob subsequently opens Grafana — Alice's proxy session is invalidated
	// the moment Keycloak's backchannel-logout POST is received.
	if s.isRevoked(us.Sub, us.CachedAt) {
		log.Printf("[proxy] session for %s is revoked; clearing and redirecting to login", us.Sub)
		s.sessions.Clear(r, w)
		s.redirectToLogin(w, r)
		return
	}

	// Refresh project cache if stale.
	if err := s.refreshCacheIfNeeded(r.Context(), us); err != nil {
		log.Printf("[proxy] cache refresh failed for %s: %v", us.Sub, err)
		// Non-fatal: continue with cached/empty project list.
	}

	// Enforce: non-admin users with no projects get 403.
	if us.Role != "Admin" && len(us.Projects) == 0 {
		http.Error(w, "No project membership — access denied.", http.StatusForbidden)
		return
	}

	// Sanitize the $project template variable in the URL for non-admins. A
	// crafted dashboard link (e.g. ?var-project=someone-elses-project) is safe
	// data-wise because prometheus-proxy rewrites the PromQL, but Grafana still
	// renders the foreign value as the selected chip in the $project picker,
	// falsely implying the dashboard is scoped to that project. Strip any
	// disallowed value and redirect so the picker falls back to "All".
	if us.Role != "Admin" && isDashboardView(r) {
		if dest, changed := sanitizeProjectParams(r.URL, us.Projects); changed {
			http.Redirect(w, r, dest, http.StatusFound)
			return
		}
	}

	// Store the auth headers in context so the Director can inject them
	// after stripping any client-supplied spoofed copies (see proxy.New).
	ctx := context.WithValue(r.Context(), proxyHeadersKey{}, proxyHeaders{
		user:  us.Sub,
		role:  us.Role,
		email: us.Email,
		name:  us.Name,
	})

	s.reverseProxy.ServeHTTP(w, r.WithContext(ctx))
}

// handleCallback processes the OIDC auth-code callback from Keycloak.
func (s *Server) handleCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if cfg := s.tlsContext(ctx); cfg != nil {
		ctx = cfg
	}

	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code", http.StatusBadRequest)
		return
	}

	// Exchange auth code for tokens.
	token, err := s.oauth2Cfg.Exchange(ctx, code)
	if err != nil {
		log.Printf("[proxy] token exchange failed: %v", err)
		http.Error(w, "token exchange failed", http.StatusInternalServerError)
		return
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		rawIDToken = token.AccessToken
	}

	claims, err := s.parseClaims(rawIDToken)
	if err != nil {
		log.Printf("[proxy] parse id_token claims: %v", err)
		http.Error(w, "invalid token", http.StatusInternalServerError)
		return
	}

	role, projects, err := s.buildRoleAndProjects(ctx, claims, token.AccessToken)
	if err != nil {
		log.Printf("[proxy] build role/projects for %s: %v", claims.Sub, err)
		http.Error(w, "failed to load project membership", http.StatusInternalServerError)
		return
	}

	// Clear any revocation entry for this sub — the user has just authenticated
	// fresh so the old revocation no longer applies.
	s.clearRevocation(claims.Sub)

	us := &session.UserSession{
		Sub:      claims.Sub,
		Email:    claims.Email,
		Name:     claims.Name,
		Username: claims.PreferredUsername,
		Projects: projects,
		Role:     role,
	}
	if err := s.sessions.Save(r, w, us); err != nil {
		log.Printf("[proxy] save session: %v", err)
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}

	// Populate the per-sub project cache so /.auth/projects can serve it.
	s.setCache(claims.Sub, projects, role)

	// Retrieve the post-login destination from the signed state cookie and
	// validate the CSRF nonce before redirecting.
	redirectTo := s.consumeStateCookie(w, r, state)
	http.Redirect(w, r, redirectTo, http.StatusFound)
}

// allowedHandoffDashboardPaths are the exact Grafana dashboard paths Agent
// Studio Observability may open via /oauth2/handoff.
const (
	handoffPathLogs    = "/d/app-logs/app-logs"
	handoffPathMetrics = "/d/service-overview/service-overview"
	handoffPathTraces  = "/d/app-traces/app-traces"
)

type handoffKind int

const (
	handoffKindUnknown handoffKind = iota
	handoffKindLogs
	handoffKindMetrics
	handoffKindTraces
)

// handleHandoff establishes a fresh proxy session directly from a Keycloak
// token supplied by the Agent Studio UI, then redirects to the requested
// Grafana destination.
//
// Why this exists:
//
//	Grafana lives on a different origin (grafana.<domain>) from the Agent
//	Studio app (app.<domain>). When the user clicks Logs / Metrics / App Traces
//	the app opens Grafana in a new tab. Without a handoff, grafana-proxy
//	resolves identity from whatever it already holds on the grafana/auth
//	origins: a lingering grafana-proxy-session cookie, or a silent-SSO answer
//	from Keycloak's cookie. In Safari — whose Intelligent Tracking Prevention
//	blocks cross-site cookies — those can still belong to a previously
//	signed-in user, so Grafana opens as the wrong person.
//
//	The UI instead passes the *current* user's Keycloak access token as
//	?token=. Because this endpoint is reached by a top-level browser
//	navigation, the session cookie it sets is first-party and is stored by
//	every browser, Safari included. The token's signature is verified against
//	Keycloak's JWKS (the same trust anchor as the OIDC callback), so a client
//	cannot forge an identity.
//
// Trade-off: the token is present in the navigation URL. This is acceptable for
// a short-lived, signature-verified access token; the browser only exposes it
// during the single top-level navigation required to set a first-party cookie.
//
// Failure handling: if the token is missing, expired, or otherwise invalid, or
// the project lookup fails, the handler falls back to a plain redirect to the
// destination, which re-enters the normal cookie/OIDC flow via handleProxy.
func (s *Server) handleHandoff(w http.ResponseWriter, r *http.Request) {
	rawRedirect := r.URL.Query().Get("redirect")
	handoffKind, projectID := parseHandoffRedirect(rawRedirect)

	token := r.URL.Query().Get("token")
	if token == "" {
		log.Printf("[proxy] handoff: missing token; falling back to standard flow")
		redirectHandoff(w, r, handoffKind, projectID)
		return
	}

	ctx := r.Context()
	if tctx := s.tlsContext(ctx); tctx != nil {
		ctx = tctx
	}

	claims, err := s.parseClaims(token)
	if err != nil {
		log.Printf("[proxy] handoff: token validation failed: %v; falling back to standard flow", err)
		redirectHandoff(w, r, handoffKind, projectID)
		return
	}

	role, projects, err := s.buildRoleAndProjects(ctx, claims, token)
	if err != nil {
		log.Printf("[proxy] handoff: build role/projects for %s: %v; falling back to standard flow", claims.Sub, err)
		redirectHandoff(w, r, handoffKind, projectID)
		return
	}

	// A freshly verified identity supersedes any stale session the browser may
	// still hold for a previously signed-in user, and clears a prior logout
	// revocation for this user so the new session is trusted immediately.
	s.clearRevocation(claims.Sub)

	us := &session.UserSession{
		Sub:      claims.Sub,
		Email:    claims.Email,
		Name:     claims.Name,
		Username: claims.PreferredUsername,
		Projects: projects,
		Role:     role,
	}
	if err := s.sessions.Save(r, w, us); err != nil {
		log.Printf("[proxy] handoff: save session: %v", err)
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	s.setCache(claims.Sub, projects, role)

	log.Printf("[proxy] handoff: established session for sub=%s role=%s", claims.Sub, role)
	redirectHandoff(w, r, handoffKind, projectID)
}

// handleLogout clears the session and redirects to Keycloak's end-session endpoint.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.sessions.Clear(r, w)

	// Use the public issuer for the logout redirect so the browser lands on the
	// correct Keycloak hostname (the same one that set its SSO session cookies).
	publicIssuer := strings.TrimSuffix(s.cfg.KeycloakIssuer, "/")
	if s.cfg.KeycloakPublicIssuer != "" {
		publicIssuer = strings.TrimSuffix(s.cfg.KeycloakPublicIssuer, "/")
	}

	// Include client_id so Keycloak 18+ correctly identifies which client is
	// logging out and clears the SSO session.  Without it, the end-session
	// endpoint may only show a confirmation page rather than silently logging
	// out, leaving the SSO session alive.
	logoutURL := publicIssuer + "/protocol/openid-connect/logout" +
		"?client_id=" + url.QueryEscape(s.cfg.ClientID) +
		"&post_logout_redirect_uri=" + url.QueryEscape(s.cfg.RedirectURI[:strings.LastIndex(s.cfg.RedirectURI, "/")+1])
	http.Redirect(w, r, logoutURL, http.StatusFound)
}

// handleBackchannelLogout receives Keycloak's OIDC Back-Channel Logout POST.
//
// When any Keycloak client (e.g. Agent Studio) ends a user's SSO session,
// Keycloak calls this endpoint with a signed "logout token" in the request
// body (application/x-www-form-urlencoded, field: logout_token).  We extract
// the sub from the token and record the revocation time.  The next request
// from a browser carrying a proxy session for that sub (created before the
// revocation) is rejected by handleProxy and sent to a fresh login.
//
// The logout token's signature is verified by s.parseClaims, which uses the
// JWKS verifier (initialised from Keycloak's /.well-known/openid-configuration)
// when it is available.  If JWKS discovery failed at startup, parseClaims falls
// back to unverified parsing and a warning is logged — the endpoint is only
// reachable from within the cluster (Keycloak → ingress → proxy pod), which
// limits the attack surface in that degraded state.
func (s *Server) handleBackchannelLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 64*1024))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	vals, err := url.ParseQuery(string(body))
	if err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	logoutToken := vals.Get("logout_token")
	if logoutToken == "" {
		http.Error(w, "missing logout_token", http.StatusBadRequest)
		return
	}

	claims, err := s.parseClaims(logoutToken)
	if err != nil {
		log.Printf("[proxy] backchannel-logout: failed to parse logout_token: %v", err)
		http.Error(w, "invalid logout_token", http.StatusBadRequest)
		return
	}

	if claims.Sub == "" {
		http.Error(w, "logout_token missing sub", http.StatusBadRequest)
		return
	}

	s.revokedMu.Lock()
	s.revokedSubs[claims.Sub] = time.Now()
	s.revokedMu.Unlock()

	log.Printf("[proxy] backchannel-logout: revoked session for sub=%s", claims.Sub)
	w.WriteHeader(http.StatusOK)
}

// isRevoked returns true when the given sub has an active revocation recorded
// after sessionCreatedAt, meaning the session pre-dates the logout event and
// should no longer be trusted.
func (s *Server) isRevoked(sub string, sessionCreatedAt time.Time) bool {
	s.revokedMu.RLock()
	revokedAt, ok := s.revokedSubs[sub]
	s.revokedMu.RUnlock()
	// Only revoke if the logout happened AFTER the session was created.
	// This allows Bob to log in freshly after Alice's session was revoked.
	return ok && revokedAt.After(sessionCreatedAt)
}

// clearRevocation removes a sub from the revoked set after a successful fresh login.
func (s *Server) clearRevocation(sub string) {
	s.revokedMu.Lock()
	delete(s.revokedSubs, sub)
	s.revokedMu.Unlock()
}

// handleAuthProjects returns the project list for the user identified by the
// caller.  The Infinity datasource calls this endpoint server-side from
// Grafana's backend process (not the browser) when evaluating the $project
// template variable, so there is no browser cookie or X-Grafana-User header
// available (Grafana's send_user_header only applies to the built-in data
// proxy, not backend plugin SDK requests).
//
// User identification is resolved in this priority order:
//  1. `?user=<sub>` query parameter — set by the dashboard template variable
//     URL as `/.auth/projects?user=${__user.login}`.  Grafana interpolates
//     the built-in variable before handing the URL to the Infinity plugin, so
//     the server receives the actual sub UUID as a query param.
//  2. X-Grafana-User header — kept as a fallback for future Grafana versions
//     that may forward this header to backend plugins.
//  3. Session cookie — useful when the endpoint is visited directly in the
//     browser for testing.
func (s *Server) handleAuthProjects(w http.ResponseWriter, r *http.Request) {
	sub := r.URL.Query().Get("user")
	if sub == "" {
		sub = r.Header.Get("X-Grafana-User")
	}
	if sub == "" {
		// Fallback: try to read from session (useful for testing via browser).
		if us, err := s.sessions.Get(r); err == nil && us != nil {
			sub = us.Sub
		}
	}
	if sub == "" {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
		return
	}

	s.cacheMu.RLock()
	entry, ok := s.cache[sub]
	s.cacheMu.RUnlock()

	if !ok {
		// User has never logged in through this proxy instance (e.g. after a
		// pod restart). Return empty; the user's next browser navigation will
		// re-warm the cache via refreshCacheIfNeeded.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("[]"))
		return
	}
	// Serve even if the TTL has elapsed — stale data is better than [] which
	// would leave the $project dropdown empty. The cache is refreshed on the
	// next browser request through handleProxy → refreshCacheIfNeeded.

	entries := make([]session.ProjectEntry, 0, len(entry.projects))
	for _, p := range entry.projects {
		entries = append(entries, session.ProjectEntry{
			Value: p.ProjectID,
			Text:  p.ProjectID,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(entries)
}

// handleInternalProjects is a machine-to-machine endpoint called by
// prometheus-proxy.  It returns the cached project list and Grafana role for
// the user identified by the `?sub=<keycloak-uuid>` query parameter.
//
// Access is gated by a shared secret: callers must send
// "Authorization: Bearer <InternalToken>".  When InternalToken is empty the
// endpoint always returns 401.
//
// Response (HTTP 200):
//
//	{ "sub": "...", "role": "Admin"|"Viewer", "projects": ["projA", "projB"] }
//
// HTTP 404 is returned when the sub is not in the cache (user has not yet
// completed the OIDC flow through this proxy instance — typically after a pod
// restart).  prometheus-proxy should surface this as a "reload Grafana" message.
func (s *Server) handleInternalProjects(w http.ResponseWriter, r *http.Request) {
	// Enforce shared-secret authentication.
	if s.cfg.InternalToken == "" {
		http.Error(w, "internal endpoint disabled", http.StatusUnauthorized)
		return
	}
	auth := r.Header.Get("Authorization")
	if auth != "Bearer "+s.cfg.InternalToken {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	sub := r.URL.Query().Get("sub")
	if sub == "" {
		http.Error(w, "sub parameter required", http.StatusBadRequest)
		return
	}

	s.cacheMu.RLock()
	entry, ok := s.cache[sub]
	s.cacheMu.RUnlock()

	if !ok {
		http.Error(w, "user not found in cache", http.StatusNotFound)
		return
	}

	projectIDs := make([]string, 0, len(entry.projects))
	for _, p := range entry.projects {
		projectIDs = append(projectIDs, p.ProjectID)
	}

	type response struct {
		Sub      string   `json:"sub"`
		Role     string   `json:"role"`
		Projects []string `json:"projects"`
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response{
		Sub:      sub,
		Role:     entry.role,
		Projects: projectIDs,
	})
}

// redirectToLogin initiates the OIDC authorization code flow.
//
// The post-login destination (r.URL.RequestURI()) is stored in a short-lived
// signed+encrypted cookie.  A random UUID nonce is used as the OAuth2 state
// parameter so it cannot be predicted by an attacker (CSRF protection).
// consumeStateCookie verifies nonce == state in the callback before using the
// destination.
func (s *Server) redirectToLogin(w http.ResponseWriter, r *http.Request) {
	nonce := uuid.New().String()
	destination := r.URL.RequestURI()

	encoded, err := s.stateCookieCodec.Encode("oauth_state", map[string]string{
		"nonce": nonce,
		"dest":  destination,
	})
	if err != nil {
		log.Printf("[proxy] encode state cookie: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    encoded,
		Path:     "/",
		MaxAge:   300, // 5 min — enough to complete the Keycloak login flow
		HttpOnly: true,
		Secure:   !s.cfg.TLSSkipVerify,
		SameSite: http.SameSiteLaxMode,
	})

	authURL := s.oauth2Cfg.AuthCodeURL(nonce, oauth2.AccessTypeOffline)
	http.Redirect(w, r, authURL, http.StatusFound)
}

// consumeStateCookie validates the CSRF nonce and returns the safe destination
// URL stored in the signed oauth_state cookie.  It always clears the cookie
// regardless of whether validation succeeds, to prevent replay.  Returns "/"
// on any validation failure.
func (s *Server) consumeStateCookie(w http.ResponseWriter, r *http.Request, state string) string {
	// Clear the one-use state cookie unconditionally.
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   !s.cfg.TLSSkipVerify,
	})

	cookie, err := r.Cookie("oauth_state")
	if err != nil {
		log.Printf("[proxy] missing oauth_state cookie (possible direct callback visit)")
		return "/"
	}

	var data map[string]string
	if err := s.stateCookieCodec.Decode("oauth_state", cookie.Value, &data); err != nil {
		log.Printf("[proxy] oauth_state cookie decode failed: %v", err)
		return "/"
	}

	if data["nonce"] != state {
		log.Printf("[proxy] CSRF state mismatch: cookie nonce != callback state")
		return "/"
	}

	return safeLocalDest(data["dest"])
}

// safeLocalDest returns dest only when it is a safe same-origin path: it must
// begin with a single "/" and must not be a protocol-relative ("//") or
// backslash-escaped ("/\") URL. Anything else collapses to "/". This prevents
// a caller-supplied redirect target from being abused as an open redirect.
func safeLocalDest(dest string) string {
	if dest == "" || strings.Contains(dest, "://") ||
		!strings.HasPrefix(dest, "/") ||
		(len(dest) >= 2 && (dest[1] == '/' || dest[1] == '\\')) {
		return "/"
	}
	return dest
}

// parseHandoffRedirect classifies ?redirect= into a known Observability
// dashboard. Only exact allow-listed paths are accepted; query params are
// reduced to orgId=1 and an optional validated var-project for Metrics.
func parseHandoffRedirect(raw string) (handoffKind, string) {
	u, err := url.Parse(safeLocalDest(raw))
	if err != nil || u.Scheme != "" || u.Host != "" {
		return handoffKindUnknown, ""
	}

	var kind handoffKind
	switch u.Path {
	case handoffPathLogs:
		kind = handoffKindLogs
	case handoffPathMetrics:
		kind = handoffKindMetrics
	case handoffPathTraces:
		kind = handoffKindTraces
	default:
		return handoffKindUnknown, ""
	}

	if orgID := u.Query().Get("orgId"); orgID != "" && orgID != "1" {
		return handoffKindUnknown, ""
	}

	projectID := ""
	if kind == handoffKindMetrics {
		if vp := u.Query().Get("var-project"); isSafeHandoffProjectID(vp) {
			projectID = vp
		}
	}
	return kind, projectID
}

func isSafeHandoffProjectID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// handoffRedirectLocation builds the post-handoff Location header from a
// classified dashboard kind. Paths are fixed constants; only var-project on
// Metrics is copied from user input after validation.
func handoffRedirectLocation(kind handoffKind, projectID string) string {
	switch kind {
	case handoffKindLogs:
		return handoffPathLogs + "?orgId=1"
	case handoffKindTraces:
		return handoffPathTraces + "?orgId=1"
	case handoffKindMetrics:
		q := url.Values{}
		q.Set("orgId", "1")
		if projectID != "" {
			q.Set("var-project", projectID)
		}
		return handoffPathMetrics + "?" + q.Encode()
	default:
		return "/"
	}
}

// redirectHandoff issues a 302 only to a validated allow-listed local path.
func redirectHandoff(w http.ResponseWriter, r *http.Request, kind handoffKind, projectID string) {
	http.Redirect(w, r, handoffRedirectLocation(kind, projectID), http.StatusFound)
}

// buildRoleAndProjects determines the Grafana role and fetches the project list.
func (s *Server) buildRoleAndProjects(ctx context.Context, claims *keycloakClaims, accessToken string) (string, []session.Project, error) {
	// Platform admins skip project membership check.
	if containsRole(claims.RealmAccess.Roles, s.cfg.PlatformAdminRole) {
		return "Admin", nil, nil
	}

	projects, err := s.configClient.ListUserProjects(ctx, claims.Sub, accessToken)
	if err != nil {
		return "", nil, err
	}

	sessionProjects := make([]session.Project, 0, len(projects))
	for _, p := range projects {
		sessionProjects = append(sessionProjects, session.Project{
			ProjectID: p.ProjectID,
			Role:      p.Role,
		})
	}
	return "Viewer", sessionProjects, nil
}

// refreshCacheIfNeeded repopulates the per-sub in-memory cache when it is
// stale. Access tokens are no longer stored in the session cookie (they are
// too large and push the cookie over the 4096-byte browser limit), so the
// cache is warmed from the project list already present in the session rather
// than by re-calling config-service. The session's project list is fetched
// once at login time and remains accurate for the session lifetime.
func (s *Server) refreshCacheIfNeeded(_ context.Context, us *session.UserSession) error {
	s.cacheMu.RLock()
	entry, ok := s.cache[us.Sub]
	s.cacheMu.RUnlock()

	if ok && time.Since(entry.cachedAt) <= s.cfg.ProjectCacheTTL {
		return nil
	}

	// Re-warm the cache from the session data (no network call needed).
	s.setCache(us.Sub, us.Projects, us.Role)
	return nil
}

func (s *Server) setCache(sub string, projects []session.Project, role string) {
	s.cacheMu.Lock()
	s.cache[sub] = &projectCacheEntry{
		projects: projects,
		role:     role,
		cachedAt: time.Now(),
	}
	s.cacheMu.Unlock()
}

// tlsContext returns an oauth2-compatible context with a TLS-skipping HTTP
// client, or nil when TLS skip-verify is not configured.
func (s *Server) tlsContext(ctx context.Context) context.Context {
	if !s.cfg.TLSSkipVerify {
		return nil
	}
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // dev only
	}
	return context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Transport: transport})
}

// keycloakClaims are the JWT claims we extract from the OIDC access/logout token.
type keycloakClaims struct {
	Sub               string      `json:"sub"`
	Email             string      `json:"email"`
	Name              string      `json:"name"`
	PreferredUsername string      `json:"preferred_username"`
	RealmAccess       realmAccess `json:"realm_access"`
	jwt.RegisteredClaims
}

type realmAccess struct {
	Roles []string `json:"roles"`
}

// parseClaims decodes JWT claims, verifying the signature via JWKS when the
// verifier is initialised.  Falls back to unverified parsing when the JWKS
// endpoint was unreachable at startup (a warning is logged at startup).
func (s *Server) parseClaims(tokenStr string) (*keycloakClaims, error) {
	if s.jwksVerifier != nil {
		claims := &keycloakClaims{}
		_, err := jwt.ParseWithClaims(tokenStr, claims, s.jwksVerifier.Keyfunc)
		if err != nil {
			return nil, fmt.Errorf("verify claims: %w", err)
		}
		if claims.Sub == "" {
			return nil, fmt.Errorf("token missing sub claim")
		}
		return claims, nil
	}
	return parseUnverifiedClaims(tokenStr)
}

// parseUnverifiedClaims decodes JWT claims without signature verification.
// Used as a fallback when the JWKS verifier is not available (e.g. Keycloak
// unreachable at startup).  Prefer parseClaims (method on Server) for all
// production call sites.
func parseUnverifiedClaims(tokenStr string) (*keycloakClaims, error) {
	p := jwt.NewParser()
	claims := &keycloakClaims{}
	_, _, err := p.ParseUnverified(tokenStr, claims)
	if err != nil {
		return nil, fmt.Errorf("parse claims: %w", err)
	}
	if claims.Sub == "" {
		return nil, fmt.Errorf("token missing sub claim")
	}
	return claims, nil
}

func containsRole(roles []string, target string) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
}

func removeCookieByName(r *http.Request, name string) {
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if c.Name != name {
			r.AddCookie(c)
		}
	}
}

// removeCookieByPrefix removes all cookies whose name starts with prefix.
// Used to strip Grafana's own session cookies (grafana_session,
// grafana_session_expiry) so that Grafana always authenticates via the
// X-WEBAUTH-USER header rather than a stale session from a previous user.
func removeCookieByPrefix(r *http.Request, prefix string) {
	cookies := r.Cookies()
	r.Header.Del("Cookie")
	for _, c := range cookies {
		if !strings.HasPrefix(c.Name, prefix) {
			r.AddCookie(c)
		}
	}
}

// isDashboardView reports whether the request is a browser navigation to a
// Grafana dashboard page (as opposed to an API call or static asset). Only
// these carry the $project selection in the URL as a var-project query param,
// so they are the only requests worth sanitizing.
func isDashboardView(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	p := r.URL.Path
	return strings.HasPrefix(p, "/d/") || strings.HasPrefix(p, "/dashboard/")
}

// sanitizeProjectParams inspects the var-project query parameters against the
// user's allowed projects. If any value is not in the allowed set, ALL
// var-project params are removed so Grafana falls back to the dashboard's
// default selection ("All"). Grafana's "$__all" sentinel is always treated as
// valid. It returns the rewritten request URI and whether a change was made;
// when no change is needed the returned URI is empty.
func sanitizeProjectParams(u *url.URL, allowed []session.Project) (string, bool) {
	q := u.Query()
	vals, ok := q["var-project"]
	if !ok {
		return "", false
	}

	allowedSet := make(map[string]struct{}, len(allowed))
	for _, p := range allowed {
		allowedSet[p.ProjectID] = struct{}{}
	}

	hasInvalid := false
	for _, v := range vals {
		if v == "$__all" {
			continue
		}
		if _, okp := allowedSet[v]; !okp {
			hasInvalid = true
			break
		}
	}
	if !hasInvalid {
		return "", false
	}

	// Reset the picker to "All" by dropping the override entirely.
	q.Del("var-project")
	u.RawQuery = q.Encode()
	return u.RequestURI(), true
}

// generateStateToken returns a random URL-safe token for OIDC state.
func generateStateToken() string {
	return uuid.New().String()
}

var _ = generateStateToken // suppress unused warning; used indirectly via oauth2 state
