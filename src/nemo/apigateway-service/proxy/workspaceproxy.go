package proxy

import (
	"crypto/tls"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

// Workspace identity headers set by the Istio gateway's parity-header
// EnvoyFilter (see deployments/helm/edge/templates/envoyfilter-parity-headers-istio.yaml).
// Edge-validated; trusted by virtue of network position. Replaces the
// in-process JWT decoding that used to live in middleware/auth.go.
const (
	headerUserID      = "X-User-ID"
	headerUserEmail   = "X-User-Email"
	headerProjectID   = "X-Project-ID"
	headerWorkspaceID = "X-Workspace-ID"
	headerNamespaceID = "X-Namespace-ID"
)

const (
	// CookieMaxAge is 24 hour in seconds
	CookieMaxAge = 24 * 3600

	// defaultWorkspaceLabelPrefix is the prefix applied to workspace IDs to form
	// the public single-label hostname ({prefix}{id}.{endpoint}).
	// Hyphen is used (not underscore) so the label is RFC-1035 compliant and
	// accepted in TLS SAN dNSName entries by all CAs and TLS clients.
	defaultWorkspaceLabelPrefix = "ws-"
)

// workspaceLabelPrefix returns the configured workspace hostname prefix.
// Sourced from WORKSPACE_LABEL_PREFIX env var (set by the Helm chart from
// .Values.workspaceLabelPrefix). Falls back to defaultWorkspaceLabelPrefix.
func workspaceLabelPrefix() string {
	if v := os.Getenv("WORKSPACE_LABEL_PREFIX"); v != "" {
		return v
	}
	return defaultWorkspaceLabelPrefix
}

// firstLabel returns the leftmost DNS label of hostname (with any :port stripped).
func firstLabel(hostname string) string {
	hostWithoutPort := hostname
	if idx := strings.LastIndex(hostname, ":"); idx != -1 {
		hostWithoutPort = hostname[:idx]
	}
	return strings.SplitN(hostWithoutPort, ".", 2)[0]
}

// IsWorkspaceSubdomain reports whether hostname is a workspace public host.
// Workspace hosts are single-label: {workspaceLabelPrefix}{workspaceId}.{endpoint}
// (e.g. ws-g68s8g527f.agentstudio.local), so a {*}.{endpoint} wildcard DNS
// record covers them. The match is purely on the leftmost label having the
// configured prefix; this avoids collisions with sibling subdomains
// (auth./s3./catalog./workflows./phoenix./app.) which never start with "ws-".
func IsWorkspaceSubdomain(hostname string) bool {
	prefix := workspaceLabelPrefix()
	if prefix == "" {
		return false
	}
	label := firstLabel(hostname)
	// A bare "ws-" label with no ID after it is not a workspace host.
	return strings.HasPrefix(label, prefix) && len(label) > len(prefix)
}

// extractWorkspaceID returns the workspace ID encoded in hostname's leftmost
// label (i.e. label with the prefix stripped). Returns "" if the label does
// not carry the expected prefix.
func extractWorkspaceID(hostname string) string {
	prefix := workspaceLabelPrefix()
	label := firstLabel(hostname)
	if !strings.HasPrefix(label, prefix) {
		return ""
	}
	return strings.TrimPrefix(label, prefix)
}

// getWorkspaceCookieName returns the cookie name for a specific workspace
func getWorkspaceCookieName(workspaceID string) string {
	return fmt.Sprintf("workspace-%s-namespace", workspaceID)
}

// extractCookieDomain returns the Domain attribute used for workspace cookies.
//
// Default is "" (host-only cookies) which is the safest behaviour: each
// workspace gets its own cookie jar, with no cross-workspace leakage and no
// risk of leaking workspace cookies to sibling subdomains (auth./s3./...).
//
// Override via WORKSPACE_COOKIE_DOMAIN if a deployment needs a parent-scoped
// cookie (e.g. Domain=.{endpoint}); leaving it unset is recommended.
func extractCookieDomain(hostname string) string {
	if envDomain := os.Getenv("WORKSPACE_COOKIE_DOMAIN"); envDomain != "" {
		return envDomain
	}
	return ""
}

// getProjectIDFromRequest extracts projectId from query param or cookie
func getProjectIDFromRequest(req *http.Request, workspaceID string) string {
	// First, check query parameter
	if projectId := req.URL.Query().Get("projectId"); projectId != "" {
		return projectId
	}

	// Then, check cookie
	cookieName := getWorkspaceCookieName(workspaceID)
	cookie, err := req.Cookie(cookieName)
	if err == nil && cookie != nil && cookie.Value != "" {
		return cookie.Value
	}

	return ""
}

// setProjectIDCookie sets the projectId cookie for the workspace.
// If extractCookieDomain returns "" the cookie is set host-only (no Domain
// attribute), which is the recommended default — see extractCookieDomain.
func setProjectIDCookie(w http.ResponseWriter, req *http.Request, workspaceID, namespaceID string) {
	cookieName := getWorkspaceCookieName(workspaceID)
	cookieDomain := extractCookieDomain(req.Host)

	secure := os.Getenv("ENVIRONMENT") == "production" || os.Getenv("NODE_ENV") == "production"

	cookie := &http.Cookie{
		Name:     cookieName,
		Value:    namespaceID,
		Domain:   cookieDomain, // empty string -> host-only cookie
		Path:     "/",
		MaxAge:   CookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	}

	http.SetCookie(w, cookie)
	if cookieDomain == "" {
		log.Printf("Set namespace cookie: %s=%s (host-only on %s)", cookieName, namespaceID, req.Host)
	} else {
		log.Printf("Set namespace cookie: %s=%s (domain: %s)", cookieName, namespaceID, cookieDomain)
	}
}

func BuildWorkspaceProxy() http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(proxyReq *httputil.ProxyRequest) {
			inReq := proxyReq.In
			hostname := inReq.Host
			// Workspace public host format: {workspaceLabelPrefix}{id}.{endpoint}
			// (e.g. ws-g68s8g527f.agentstudio.local). Strip the prefix to recover
			// the bare workspace ID used by Service DNS (workspace-svc-<id>).
			workspace_id := extractWorkspaceID(hostname)

			if workspace_id == "" {
				log.Printf("Workspace ID missing from host %q (expected leftmost label to start with %q); skipping workspace proxy", hostname, workspaceLabelPrefix())
				return
			}

			// Get projectId from query param or cookie (for logging/debugging)
			projectId := getProjectIDFromRequest(inReq, workspace_id)

			workspace_endpoint := fmt.Sprintf("http://workspace-svc-%s:8888", workspace_id)

			target, err := url.Parse(workspace_endpoint)
			if err != nil {
				log.Printf("Error parsing workspace endpoint: %v", err)
				return
			}

			outReq := proxyReq.Out
			outReq.URL.Scheme = target.Scheme
			outReq.URL.Host = target.Host
			outReq.URL.Path = inReq.URL.Path
			outReq.Header.Del("Origin")
			outReq.Header.Del("Referer")
			//outReq.Header.Set("X-Forwarded-For", inReq.RemoteAddr)
			//outReq.Header.Set("X-Forwarded-Host", inReq.Host)
			q := inReq.URL.Query()
			q.Del("projectId")
			outReq.URL.RawQuery = q.Encode()
			log.Printf("Proxying request to workspace for %v at %s", projectId+"/"+workspace_id, outReq.URL.String())
		},
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, // Skip TLS verification for development purposes
			},
		},
	}

	// Wrap proxy with cookie middleware + workspace-id check based on the
	// gateway-injected X-User-* / X-Workspace-ID headers (set by the Istio
	// parity-header EnvoyFilter at the edge -- see
	// deployments/helm/edge/templates/envoyfilter-parity-headers-istio.yaml).
	// JWT validation has already happened at the gateway; this pod no longer
	// re-validates.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hostname := r.Host
		workspace_id := extractWorkspaceID(hostname)

		// Workspace-id-vs-claim check: the gateway-set X-Workspace-ID (when
		// present) must match the host. Empty header means the user's JWT
		// did not carry a workspace claim -- nothing to enforce.
		claimedWorkspace := r.Header.Get(headerWorkspaceID)
		if claimedWorkspace != "" && claimedWorkspace != workspace_id {
			log.Printf("Workspace ID mismatch: header has %s, subdomain has %s", claimedWorkspace, workspace_id)
			http.Error(w, `{"error":"Forbidden","message":"Workspace access denied"}`, http.StatusForbidden)
			return
		}

		// Use namespace/project from gateway headers if available so the
		// project-id cookie persists across reloads inside the workspace.
		if ns := r.Header.Get(headerNamespaceID); ns != "" {
			setProjectIDCookie(w, r, workspace_id, ns)
		} else if pid := r.Header.Get(headerProjectID); pid != "" {
			setProjectIDCookie(w, r, workspace_id, pid)
		}

		// If projectId is in query param, set it in cookie (fallback)
		if projectId := r.URL.Query().Get("projectId"); projectId != "" && workspace_id != "" {
			setProjectIDCookie(w, r, workspace_id, projectId)
		}

		// Forward the gateway-injected X-User-* headers to the workspace
		// pod. They're already on `r.Header`, but the default
		// httputil.ReverseProxy strips most hop-by-hop / sensitive headers;
		// re-set them on the outbound request explicitly so the workspace
		// sees the same edge-trusted user identity.
		originalRewrite := proxy.Rewrite
		proxy.Rewrite = func(proxyReq *httputil.ProxyRequest) {
			originalRewrite(proxyReq)
			for _, h := range []string{
				headerUserID,
				headerUserEmail,
				headerProjectID,
				headerWorkspaceID,
				headerNamespaceID,
			} {
				if v := proxyReq.In.Header.Get(h); v != "" {
					proxyReq.Out.Header.Set(h, v)
				}
			}
		}

		// Serve the proxy
		proxy.ServeHTTP(w, r)
	})
}
