package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// --- NewRateLimiter / GetLimiter ---

func TestNewRateLimiter_CreatesLimiter(t *testing.T) {
	rl := NewRateLimiter(60, 10)
	if rl == nil {
		t.Fatal("expected non-nil RateLimiter")
	}
	if rl.burst != 10 {
		t.Errorf("expected burst 10, got %d", rl.burst)
	}
}

func TestGetLimiter_SameIPSameLimiter(t *testing.T) {
	rl := NewRateLimiter(60, 10)
	l1 := rl.GetLimiter("1.2.3.4")
	l2 := rl.GetLimiter("1.2.3.4")
	if l1 != l2 {
		t.Error("expected same limiter for same IP")
	}
}

func TestGetLimiter_DifferentIPDifferentLimiter(t *testing.T) {
	rl := NewRateLimiter(60, 10)
	l1 := rl.GetLimiter("1.2.3.4")
	l2 := rl.GetLimiter("5.6.7.8")
	if l1 == l2 {
		t.Error("expected different limiters for different IPs")
	}
}

func TestRateLimiter_AllowBursts(t *testing.T) {
	rl := NewRateLimiter(600, 5)
	limiter := rl.GetLimiter("test-ip")
	for i := 0; i < 5; i++ {
		if !limiter.Allow() {
			t.Errorf("expected allow on request %d within burst", i+1)
		}
	}
}

func TestRateLimiter_BlockAfterBurst(t *testing.T) {
	rl := NewRateLimiter(1, 1) // 1/min burst 1
	limiter := rl.GetLimiter("ip-test")
	limiter.Allow() // consume the single token
	if limiter.Allow() {
		t.Error("expected rate limit to block after burst is exhausted")
	}
}

// --- getClientIP ---

func TestGetClientIP_XForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	req.Header.Set("X-Real-IP", "10.0.0.2")
	req.RemoteAddr = "10.0.0.3:1234"
	got := getClientIP(req)
	if got != "10.0.0.1" {
		t.Errorf("expected X-Forwarded-For to take priority, got %q", got)
	}
}

func TestGetClientIP_XRealIP(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Real-IP", "10.0.0.2")
	req.RemoteAddr = "10.0.0.3:1234"
	got := getClientIP(req)
	if got != "10.0.0.2" {
		t.Errorf("expected X-Real-IP, got %q", got)
	}
}

func TestGetClientIP_RemoteAddr(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.3:1234"
	got := getClientIP(req)
	if got != "10.0.0.3:1234" {
		t.Errorf("expected RemoteAddr, got %q", got)
	}
}

// --- getAgentRateLimitKey ---

func TestGetAgentRateLimitKey_NoClaims(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "1.2.3.4:5000"
	key := getAgentRateLimitKey(req)
	if key != "ip:1.2.3.4:5000" {
		t.Errorf("expected ip-based key, got %q", key)
	}
}

func TestGetAgentRateLimitKey_WithProjectClaims(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	// Inject claims via the package-level context key (same package, accessible)
	claims := &UserClaims{ProjectID: "proj-xyz"}
	ctx := context.WithValue(req.Context(), userClaimsKey, claims)
	req = req.WithContext(ctx)
	key := getAgentRateLimitKey(req)
	if key != "project:proj-xyz" {
		t.Errorf("expected project-based key, got %q", key)
	}
}

func TestGetAgentRateLimitKey_ClaimsNoProject(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "7.7.7.7:8080"
	claims := &UserClaims{UserID: "user-1"} // no ProjectID
	ctx := context.WithValue(req.Context(), userClaimsKey, claims)
	req = req.WithContext(ctx)
	key := getAgentRateLimitKey(req)
	// Falls back to IP since ProjectID is empty
	if key != "ip:7.7.7.7:8080" {
		t.Errorf("expected ip fallback, got %q", key)
	}
}

// rateLimitWithLimiter creates a middleware that uses the provided RateLimiter
// instead of the package-level singleton, enabling test isolation.
func rateLimitWithLimiter(rl *RateLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		limiter := rl.GetLimiter(ip)
		if !limiter.Allow() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"rate limit exceeded"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func TestRateLimitMiddleware_AllowsRequest(t *testing.T) {
	rl := NewRateLimiter(6000, 1000)
	handler := rateLimitWithLimiter(rl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "1.2.3.4:1234"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestRateLimitMiddleware_BlocksAfterBurst(t *testing.T) {
	rl := NewRateLimiter(1, 1)
	handler := rateLimitWithLimiter(rl, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "9.9.9.9:1234"

	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)

	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 after burst, got %d", rr2.Code)
	}
}

// --- Package-level middleware smoke tests ---

func TestRateLimitQuery_Smoke(t *testing.T) {
	handler := RateLimitQuery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/query", nil)
	req.RemoteAddr = "11.22.33.44:1234"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200 for first request within limit, got %d", rr.Code)
	}
}

func TestRateLimitUpload_Smoke(t *testing.T) {
	handler := RateLimitUpload(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/upload", nil)
	req.RemoteAddr = "55.66.77.88:1234"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

func TestRateLimitAgent_Smoke(t *testing.T) {
	handler := RateLimitAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/agent/query", nil)
	req.RemoteAddr = "99.88.77.66:1234"
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rr.Code)
	}
}

// --- Package-level middleware 429 paths ---
// We replace the package-level rate limiters with burst-1 limiters to trigger 429.

func TestRateLimitQuery_429Path(t *testing.T) {
	// Ensure singleton is initialised first
	once.Do(initRateLimiters)

	// Swap in a restrictive limiter for this test
	saved := queryRateLimiter
	t.Cleanup(func() { queryRateLimiter = saved })
	queryRateLimiter = NewRateLimiter(1, 1)

	handler := RateLimitQuery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/query", nil)
	req.RemoteAddr = "250.1.1.1:1234" // unique IP

	// First request passes
	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request should be 200, got %d", rr1.Code)
	}

	// Second request is rate-limited
	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 on second request, got %d", rr2.Code)
	}
}

func TestRateLimitUpload_429Path(t *testing.T) {
	once.Do(initRateLimiters)

	saved := uploadRateLimiter
	t.Cleanup(func() { uploadRateLimiter = saved })
	uploadRateLimiter = NewRateLimiter(1, 1)

	handler := RateLimitUpload(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/upload", nil)
	req.RemoteAddr = "250.2.2.2:1234"

	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request should be 200, got %d", rr1.Code)
	}

	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rr2.Code)
	}
}

func TestRateLimitAgent_429Path(t *testing.T) {
	once.Do(initRateLimiters)

	saved := agentRateLimiter
	t.Cleanup(func() { agentRateLimiter = saved })
	agentRateLimiter = NewRateLimiter(1, 1)

	handler := RateLimitAgent(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/agent/query", nil)
	req.RemoteAddr = "250.3.3.3:1234"

	rr1 := httptest.NewRecorder()
	handler.ServeHTTP(rr1, req)
	if rr1.Code != http.StatusOK {
		t.Fatalf("first request should be 200, got %d", rr1.Code)
	}

	rr2 := httptest.NewRecorder()
	handler.ServeHTTP(rr2, req)
	if rr2.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", rr2.Code)
	}
}
