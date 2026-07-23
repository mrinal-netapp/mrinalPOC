package proxy

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHasInboundSigV4(t *testing.T) {
	req, _ := http.NewRequest(http.MethodPut, "https://s3.example.local/bucket/a%20b.txt", nil)
	if hasInboundSigV4(req) {
		t.Fatalf("expected unsigned request")
	}

	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential=test/20260101/us-east-1/s3/aws4_request")
	if !hasInboundSigV4(req) {
		t.Fatalf("expected signed request via Authorization header")
	}

	req2, _ := http.NewRequest(http.MethodGet, "https://s3.example.local/bucket/a.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc", nil)
	if !hasInboundSigV4(req2) {
		t.Fatalf("expected signed request via query presign params")
	}
}

func TestCanonicalizeS3Path(t *testing.T) {
	tests := []struct {
		name        string
		inPath      string
		wantDecoded string
		wantRaw     string
	}{
		{
			name:        "space in key",
			inPath:      "/bucket/a%20b.txt",
			wantDecoded: "/bucket/a b.txt",
			wantRaw:     "/bucket/a%20b.txt",
		},
		{
			name:        "plus in key",
			inPath:      "/bucket/a+b.txt",
			wantDecoded: "/bucket/a+b.txt",
			wantRaw:     "/bucket/a+b.txt",
		},
		{
			name:        "percent literal key",
			inPath:      "/bucket/a%2520b.txt",
			wantDecoded: "/bucket/a%20b.txt",
			wantRaw:     "/bucket/a%2520b.txt",
		},
		{
			name:        "encoded slash stays literal",
			inPath:      "/bucket/a%252Fb.txt",
			wantDecoded: "/bucket/a%2Fb.txt",
			wantRaw:     "/bucket/a%252Fb.txt",
		},
		{
			name:        "unicode key",
			inPath:      "/bucket/%E8%B5%84%E6%96%99.txt",
			wantDecoded: "/bucket/资料.txt",
			wantRaw:     "/bucket/%E8%B5%84%E6%96%99.txt",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			unescaped, err := url.PathUnescape(tt.inPath)
			if err != nil {
				t.Fatalf("failed to unescape input path: %v", err)
			}
			u := &url.URL{
				Path:    unescaped,
				RawPath: tt.inPath,
			}
			decoded, raw := canonicalizeS3Path(u)
			if decoded != tt.wantDecoded {
				t.Fatalf("decoded path mismatch: got %q want %q", decoded, tt.wantDecoded)
			}
			if raw != tt.wantRaw {
				t.Fatalf("raw path mismatch: got %q want %q", raw, tt.wantRaw)
			}
		})
	}
}

func TestIsAllowedCORSOrigin(t *testing.T) {
	tests := []struct {
		name           string
		publicEndpoint string
		origin         string
		want           bool
	}{
		{
			name:   "empty origin rejected",
			origin: "",
			want:   false,
		},
		{
			name:   "agentstudio.local exact",
			origin: "https://agentstudio.local:8443",
			want:   true,
		},
		{
			name:   "agentstudio.local subdomain (catalog) without PUBLIC_ENDPOINT",
			origin: "https://catalog.agentstudio.local:8443",
			want:   true,
		},
		{
			name:           "catalog subdomain of PUBLIC_ENDPOINT (the AIAS-1077 case)",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://catalog.agentstudio.dev.openeng.netapp.com:8443",
			want:           true,
		},
		{
			name:           "app subdomain of PUBLIC_ENDPOINT",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://app.agentstudio.dev.openeng.netapp.com:8443",
			want:           true,
		},
		{
			name:           "PUBLIC_ENDPOINT itself (bare endpoint)",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://agentstudio.dev.openeng.netapp.com",
			want:           true,
		},
		{
			name:           "case-insensitive host match",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://CATALOG.AgentStudio.Dev.OpenEng.NetApp.com:8443",
			want:           true,
		},
		{
			name:           "unrelated host rejected",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://evil.example.com",
			want:           false,
		},
		{
			name:           "suffix-confusion attempt rejected",
			publicEndpoint: "agentstudio.dev.openeng.netapp.com",
			origin:         "https://attacker-agentstudio.dev.openeng.netapp.com",
			want:           false,
		},
		{
			name:   "malformed origin rejected",
			origin: "not-a-url",
			want:   false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("PUBLIC_ENDPOINT", tt.publicEndpoint)
			got := isAllowedCORSOrigin(tt.origin)
			if got != tt.want {
				t.Fatalf("isAllowedCORSOrigin(%q) with PUBLIC_ENDPOINT=%q = %v, want %v",
					tt.origin, tt.publicEndpoint, got, tt.want)
			}
		})
	}
}

// TestCorsHandlerPreflightCatalogOrigin reproduces the AIAS-1077 scenario:
// a CORS preflight from the Lakekeeper catalog UI must be accepted with the
// concrete Origin echoed and all DuckDB-WASM headers (Range, X-User-Agent)
// in Access-Control-Allow-Headers.
func TestCorsHandlerPreflightCatalogOrigin(t *testing.T) {
	t.Setenv("PUBLIC_ENDPOINT", "agentstudio.dev.openeng.netapp.com")

	nextCalled := false
	handler := corsHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodOptions, "/some-bucket/metadata.json", nil)
	req.Header.Set("Origin", "https://catalog.agentstudio.dev.openeng.netapp.com:8443")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "range,x-user-agent,authorization,x-host-override")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status: got %d want %d", rec.Code, http.StatusNoContent)
	}
	if nextCalled {
		t.Fatalf("preflight should short-circuit and not call next handler")
	}

	wantOrigin := "https://catalog.agentstudio.dev.openeng.netapp.com:8443"
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != wantOrigin {
		t.Fatalf("Access-Control-Allow-Origin: got %q want %q", got, wantOrigin)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Access-Control-Allow-Credentials: got %q want %q", got, "true")
	}
	if got := rec.Header().Get("Vary"); got != "Origin" {
		t.Fatalf("Vary: got %q want %q", got, "Origin")
	}

	allowHeaders := rec.Header().Get("Access-Control-Allow-Headers")
	for _, required := range []string{"Range", "X-User-Agent", "Authorization", "Content-Type", "X-Host-Override"} {
		if !strings.Contains(allowHeaders, required) {
			t.Errorf("Access-Control-Allow-Headers missing %q; got %q", required, allowHeaders)
		}
	}

	allowMethods := rec.Header().Get("Access-Control-Allow-Methods")
	for _, required := range []string{"GET", "HEAD", "OPTIONS"} {
		if !strings.Contains(allowMethods, required) {
			t.Errorf("Access-Control-Allow-Methods missing %q; got %q", required, allowMethods)
		}
	}
}

// TestCorsHandlerActualRequestExposeHeaders ensures range-read response
// headers DuckDB-WASM needs (Content-Range, Accept-Ranges) are exposed.
func TestCorsHandlerActualRequestExposeHeaders(t *testing.T) {
	t.Setenv("PUBLIC_ENDPOINT", "agentstudio.dev.openeng.netapp.com")

	handler := corsHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/some-bucket/file.parquet", nil)
	req.Header.Set("Origin", "https://catalog.agentstudio.dev.openeng.netapp.com:8443")
	req.Header.Set("Range", "bytes=0-1023")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://catalog.agentstudio.dev.openeng.netapp.com:8443" {
		t.Fatalf("Access-Control-Allow-Origin: got %q", got)
	}
	expose := rec.Header().Get("Access-Control-Expose-Headers")
	for _, required := range []string{"Content-Range", "Accept-Ranges", "ETag", "Content-Length"} {
		if !strings.Contains(expose, required) {
			t.Errorf("Access-Control-Expose-Headers missing %q; got %q", required, expose)
		}
	}
}

// TestCorsHandlerUntrustedOriginNoGrant ensures a present-but-untrusted browser
// Origin receives no CORS grant at all. Emitting "*" would let any site read
// proxied S3 responses (the proxy signs unsigned requests with the gateway's
// credentials), so the browser must block the cross-origin read.
func TestCorsHandlerUntrustedOriginNoGrant(t *testing.T) {
	t.Setenv("PUBLIC_ENDPOINT", "agentstudio.dev.openeng.netapp.com")

	handler := corsHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/some-bucket/file.parquet", nil)
	req.Header.Set("Origin", "https://evil.example.com")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Access-Control-Allow-Origin for untrusted origin: got %q want empty", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Access-Control-Allow-Credentials must not be set for untrusted origin; got %q", got)
	}
}
