// Package session manages encrypted browser sessions for the grafana-proxy.
// Each session caches the Keycloak access/refresh tokens and the user's
// project list so subsequent requests do not re-call Keycloak or config-service.
package session

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/securecookie"
	"github.com/gorilla/sessions"
)

const cookieName = "grafana-proxy-session"

// UserSession holds the per-user data cached after a successful OIDC login.
//
// Tokens (AccessToken, RefreshToken) are intentionally NOT stored here.
// Gorilla securecookie serialises the whole struct into a single browser
// cookie; a Keycloak JWT is 1–2 KB and two of them push the encoded cookie
// well over the 4096-byte browser limit, causing a "value is too long" error.
// The proxy does not need persistent token storage: the project list and role
// are fetched once at login and stored directly in this struct.
type UserSession struct {
	Sub      string    `json:"sub"`
	Email    string    `json:"email"`
	Name     string    `json:"name"`
	Username string    `json:"username"`
	Projects []Project `json:"projects"`
	Role     string    `json:"role"` // "Admin" or "Viewer"
	CachedAt time.Time `json:"cached_at"`
}

// Project is a single project entry returned by config-service.
type Project struct {
	ProjectID string `json:"projectId"`
	Role      string `json:"role"`
}

// ProjectEntry is the JSON shape the Infinity datasource expects.
type ProjectEntry struct {
	Value string `json:"value"`
	Text  string `json:"text"`
}

// Store wraps gorilla/sessions with a configurable TTL.
type Store struct {
	inner *sessions.CookieStore
	ttl   time.Duration
}

// New creates a Store using the provided key material.  hashKey should be at
// least 32 random bytes; blockKey must be exactly 16, 24, or 32 bytes for AES.
// secure should be true whenever the proxy is served over HTTPS (i.e. in all
// non-local-dev environments); false is only appropriate with TLS_SKIP_VERIFY.
func New(hashKey, blockKey []byte, ttl time.Duration, secure bool) *Store {
	s := sessions.NewCookieStore(hashKey, blockKey)
	s.Options = &sessions.Options{
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	}
	return &Store{inner: s, ttl: ttl}
}

// Get retrieves the UserSession from the request cookie, or nil if no valid
// session exists or the session is older than the configured TTL.
func (s *Store) Get(r *http.Request) (*UserSession, error) {
	sess, err := s.inner.Get(r, cookieName)
	if err != nil {
		// Corrupted or expired cookie — treat as no session.
		if isCookieDecodeError(err) {
			return nil, nil
		}
		return nil, err
	}
	if sess.IsNew {
		return nil, nil
	}
	raw, ok := sess.Values["data"].(string)
	if !ok || raw == "" {
		return nil, nil
	}
	var us UserSession
	if err := json.Unmarshal([]byte(raw), &us); err != nil {
		return nil, nil
	}
	if time.Since(us.CachedAt) > s.ttl {
		return nil, nil
	}
	return &us, nil
}

// Save writes the UserSession into an encrypted cookie on the response.
func (s *Store) Save(r *http.Request, w http.ResponseWriter, us *UserSession) error {
	sess, err := s.inner.Get(r, cookieName)
	if err != nil && !isCookieDecodeError(err) {
		return err
	}
	us.CachedAt = time.Now()
	raw, err := json.Marshal(us)
	if err != nil {
		return err
	}
	sess.Values["data"] = string(raw)
	return sess.Save(r, w)
}

// Clear deletes the session cookie from the browser.
func (s *Store) Clear(r *http.Request, w http.ResponseWriter) {
	sess, _ := s.inner.Get(r, cookieName)
	sess.Options.MaxAge = -1
	_ = sess.Save(r, w)
}

func isCookieDecodeError(err error) bool {
	_, ok := err.(securecookie.Error)
	return ok
}
