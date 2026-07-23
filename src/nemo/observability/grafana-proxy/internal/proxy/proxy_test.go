package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"agentstudio/nemo/observability/grafana-proxy/internal/session"
)

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("failed to parse URL %q: %v", raw, err)
	}
	return u
}

func TestSanitizeProjectParams(t *testing.T) {
	allowed := []session.Project{
		{ProjectID: "proj-alice"},
		{ProjectID: "proj-shared"},
	}

	tests := []struct {
		name        string
		rawURL      string
		allowed     []session.Project
		wantChanged bool
		// wantQuery is checked only when wantChanged is true.
		wantHasVarProject bool
	}{
		{
			name:        "no var-project param is left untouched",
			rawURL:      "/d/service-overview/service-overview?orgId=1&from=now-1h&to=now",
			allowed:     allowed,
			wantChanged: false,
		},
		{
			name:        "allowed single value passes through",
			rawURL:      "/d/service-overview/service-overview?var-project=proj-alice",
			allowed:     allowed,
			wantChanged: false,
		},
		{
			name:        "$__all sentinel passes through",
			rawURL:      "/d/service-overview/service-overview?var-project=%24__all",
			allowed:     allowed,
			wantChanged: false,
		},
		{
			name:              "foreign value is stripped and resets to All",
			rawURL:            "/d/service-overview/service-overview?orgId=1&var-project=proj-bob",
			allowed:           allowed,
			wantChanged:       true,
			wantHasVarProject: false,
		},
		{
			name:              "mix of valid and foreign values resets entirely to All",
			rawURL:            "/d/service-overview/service-overview?var-project=proj-alice&var-project=proj-bob",
			allowed:           allowed,
			wantChanged:       true,
			wantHasVarProject: false,
		},
		{
			name:              "all allowed multi values pass through",
			rawURL:            "/d/service-overview/service-overview?var-project=proj-alice&var-project=proj-shared",
			allowed:           allowed,
			wantChanged:       false,
			wantHasVarProject: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			u := mustParseURL(t, tc.rawURL)
			dest, changed := sanitizeProjectParams(u, tc.allowed)
			if changed != tc.wantChanged {
				t.Fatalf("changed = %v, want %v (dest=%q)", changed, tc.wantChanged, dest)
			}
			if !changed {
				return
			}
			redirected := mustParseURL(t, dest)
			_, hasVarProject := redirected.Query()["var-project"]
			if hasVarProject != tc.wantHasVarProject {
				t.Fatalf("redirect %q has var-project = %v, want %v", dest, hasVarProject, tc.wantHasVarProject)
			}
		})
	}
}

// TestSanitizeProjectParamsNoRedirectLoop verifies that re-running the
// sanitizer on its own output produces no further change.
func TestSanitizeProjectParamsNoRedirectLoop(t *testing.T) {
	allowed := []session.Project{{ProjectID: "proj-alice"}}
	u := mustParseURL(t, "/d/service-overview?var-project=proj-bob")

	dest, changed := sanitizeProjectParams(u, allowed)
	if !changed {
		t.Fatalf("expected first pass to change the URL")
	}

	if _, changedAgain := sanitizeProjectParams(mustParseURL(t, dest), allowed); changedAgain {
		t.Fatalf("second pass changed the URL again — redirect loop risk (dest=%q)", dest)
	}
}

func TestIsDashboardView(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		want   bool
	}{
		{"dashboard view /d/", http.MethodGet, "/d/service-overview/service-overview", true},
		{"dashboard view /dashboard/", http.MethodGet, "/dashboard/new", true},
		{"api call is not a view", http.MethodGet, "/api/dashboards/uid/abc", false},
		{"static asset is not a view", http.MethodGet, "/public/build/app.js", false},
		{"non-GET is not a view", http.MethodPost, "/d/service-overview", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			if got := isDashboardView(r); got != tc.want {
				t.Fatalf("isDashboardView(%s %s) = %v, want %v", tc.method, tc.path, got, tc.want)
			}
		})
	}
}

func TestSafeLocalDest(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"empty", "", "/"},
		{"root", "/", "/"},
		{"valid dashboard path", "/d/app-logs/app-logs?orgId=1", "/d/app-logs/app-logs?orgId=1"},
		{"protocol-relative", "//evil.example/phish", "/"},
		{"backslash escape", "/\\evil.example", "/"},
		{"absolute URL", "https://evil.example/phish", "/"},
		{"no leading slash", "d/app-logs", "/"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := safeLocalDest(tc.raw); got != tc.want {
				t.Fatalf("safeLocalDest(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestParseHandoffRedirect(t *testing.T) {
	tests := []struct {
		name      string
		raw       string
		wantKind  handoffKind
		wantProj  string
	}{
		{
			name:     "metrics dashboard",
			raw:      "/d/service-overview/service-overview?orgId=1&var-project=proj-1",
			wantKind: handoffKindMetrics,
			wantProj: "proj-1",
		},
		{
			name:     "logs dashboard",
			raw:      "/d/app-logs/app-logs?orgId=1",
			wantKind: handoffKindLogs,
		},
		{
			name:     "app traces dashboard",
			raw:      "/d/app-traces/app-traces?orgId=1",
			wantKind: handoffKindTraces,
		},
		{
			name:     "unknown dashboard",
			raw:      "/d/evil/evil?orgId=1",
			wantKind: handoffKindUnknown,
		},
		{
			name:     "open redirect attempt",
			raw:      "//evil.example/phish",
			wantKind: handoffKindUnknown,
		},
		{
			name:     "invalid orgId",
			raw:      "/d/app-logs/app-logs?orgId=2",
			wantKind: handoffKindUnknown,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			gotKind, gotProj := parseHandoffRedirect(tc.raw)
			if gotKind != tc.wantKind || gotProj != tc.wantProj {
				t.Fatalf("parseHandoffRedirect(%q) = (%v, %q), want (%v, %q)", tc.raw, gotKind, gotProj, tc.wantKind, tc.wantProj)
			}
		})
	}
}

func TestHandoffRedirectLocation(t *testing.T) {
	tests := []struct {
		name      string
		kind      handoffKind
		projectID string
		want      string
	}{
		{
			name: "logs",
			kind: handoffKindLogs,
			want: "/d/app-logs/app-logs?orgId=1",
		},
		{
			name: "metrics with project",
			kind: handoffKindMetrics,
			projectID: "proj-1",
			want: "/d/service-overview/service-overview?orgId=1&var-project=proj-1",
		},
		{
			name: "unknown",
			kind: handoffKindUnknown,
			want: "/",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := handoffRedirectLocation(tc.kind, tc.projectID); got != tc.want {
				t.Fatalf("handoffRedirectLocation(%v, %q) = %q, want %q", tc.kind, tc.projectID, got, tc.want)
			}
		})
	}
}
