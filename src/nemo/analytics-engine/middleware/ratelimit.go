package middleware

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	DefaultQueryRateLimit  = 60  // requests per minute
	DefaultUploadRateLimit = 10  // requests per minute
	DefaultAgentRateLimit  = 120 // requests per minute (higher for agent batched tool calls)
)

// RateLimiter manages rate limiting per IP address
type RateLimiter struct {
	limiters map[string]*rate.Limiter
	mu       sync.RWMutex
	limit    rate.Limit
	burst    int
	cleanup  *time.Ticker
}

var (
	queryRateLimiter  *RateLimiter
	uploadRateLimiter *RateLimiter
	agentRateLimiter  *RateLimiter
	once              sync.Once
)

// initRateLimiters initializes the rate limiters
func initRateLimiters() {
	queryRateLimiter = NewRateLimiter(DefaultQueryRateLimit, DefaultQueryRateLimit)
	uploadRateLimiter = NewRateLimiter(DefaultUploadRateLimit, DefaultUploadRateLimit)
	agentRateLimiter = NewRateLimiter(DefaultAgentRateLimit, DefaultAgentRateLimit)
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(requestsPerMinute int, burst int) *RateLimiter {
	rl := &RateLimiter{
		limiters: make(map[string]*rate.Limiter),
		limit:    rate.Limit(float64(requestsPerMinute) / 60.0), // Convert to requests per second
		burst:    burst,
		cleanup:  time.NewTicker(10 * time.Minute),
	}

	// Start cleanup goroutine
	go rl.cleanupLimiters()

	return rl
}

// GetLimiter gets or creates a rate limiter for an IP address
func (rl *RateLimiter) GetLimiter(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	limiter, exists := rl.limiters[ip]
	if !exists {
		limiter = rate.NewLimiter(rl.limit, rl.burst)
		rl.limiters[ip] = limiter
	}

	return limiter
}

// cleanupLimiters periodically cleans up unused limiters
func (rl *RateLimiter) cleanupLimiters() {
	for range rl.cleanup.C {
		// For simplicity, we'll keep all limiters
		// In a production system, you might want to track last access time
		// and remove limiters that haven't been used recently
	}
}

// RateLimitQuery is middleware for query endpoints
func RateLimitQuery(next http.Handler) http.Handler {
	once.Do(initRateLimiters)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		limiter := queryRateLimiter.GetLimiter(ip)

		if !limiter.Allow() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error": "Rate limit exceeded: 60 per 1 minute"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}

// RateLimitUpload is middleware for upload endpoints
func RateLimitUpload(next http.Handler) http.Handler {
	once.Do(initRateLimiters)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := getClientIP(r)
		limiter := uploadRateLimiter.GetLimiter(ip)

		if !limiter.Allow() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error": "Rate limit exceeded: 10 per 1 minute"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}

// RateLimitAgent is middleware for agent API endpoints.
// Keys by project ID (from JWT) when available, falling back to IP.
func RateLimitAgent(next http.Handler) http.Handler {
	once.Do(initRateLimiters)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := getAgentRateLimitKey(r)
		limiter := agentRateLimiter.GetLimiter(key)

		if !limiter.Allow() {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error": "Rate limit exceeded for agent queries"}`))
			return
		}

		next.ServeHTTP(w, r)
	})
}

// getAgentRateLimitKey returns the rate limit key for agent requests.
// Uses project ID from JWT claims when available for per-tenant limiting.
func getAgentRateLimitKey(r *http.Request) string {
	claims := GetUserClaims(r)
	if claims != nil && claims.ProjectID != "" {
		return "project:" + claims.ProjectID
	}
	return "ip:" + getClientIP(r)
}

// getClientIP extracts the client IP address from the request
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For header first (for proxies)
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		return xff
	}

	// Check X-Real-IP header
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}

	// Fall back to RemoteAddr
	return r.RemoteAddr
}
