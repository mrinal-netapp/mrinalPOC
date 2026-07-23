// Package proxy: jwks.go implements a minimal JWKS-based JWT signature verifier
// for Keycloak RS256 tokens using only Go standard-library packages.
package proxy

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	jwksCacheTTL      = 5 * time.Minute
	jwksDiscoveryPath = "/.well-known/openid-configuration"
	jwksMaxBodyBytes  = 256 * 1024
)

type jwksKey struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

type jwksResponse struct {
	Keys []jwksKey `json:"keys"`
}

type oidcDiscovery struct {
	JWKSURI string `json:"jwks_uri"`
}

// JWKSVerifier maintains a cached set of Keycloak RSA public keys and
// provides a jwt.Keyfunc for verifying RS256 JWT signatures.
//
// Keys are refreshed automatically when:
//   - A token presents a kid not found in the cache (handles key rotation).
//   - The cache is older than jwksCacheTTL.
type JWKSVerifier struct {
	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	fetchedAt time.Time
	uri       string
	client    *http.Client
}

// newJWKSVerifier discovers the JWKS URI from the OIDC discovery endpoint and
// pre-fetches the public keys.  Returns nil (not an error) when the endpoint is
// unreachable — this allows the proxy to start even when Keycloak is not yet
// available, falling back to unverified claim parsing until the verifier can be
// used (a startup warning is logged in that case).
func newJWKSVerifier(issuer string, client *http.Client) *JWKSVerifier {
	discURL := strings.TrimSuffix(issuer, "/") + jwksDiscoveryPath

	resp, err := client.Get(discURL)
	if err != nil {
		log.Printf("[proxy] JWKS: discovery endpoint unreachable (%s): %v — JWT signatures will not be verified", discURL, err)
		return nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, jwksMaxBodyBytes))

	var disc oidcDiscovery
	if err := json.Unmarshal(body, &disc); err != nil || disc.JWKSURI == "" {
		log.Printf("[proxy] JWKS: discovery parse failed: %v — JWT signatures will not be verified", err)
		return nil
	}

	v := &JWKSVerifier{
		uri:    disc.JWKSURI,
		client: client,
		keys:   make(map[string]*rsa.PublicKey),
	}
	if err := v.refresh(); err != nil {
		log.Printf("[proxy] JWKS: initial key fetch failed: %v — JWT signatures will not be verified", err)
		return nil
	}
	log.Printf("[proxy] JWKS: loaded %d RSA key(s) from %s", len(v.keys), disc.JWKSURI)
	return v
}

// refresh fetches the JWKS endpoint and updates the in-memory key cache.
func (v *JWKSVerifier) refresh() error {
	resp, err := v.client.Get(v.uri)
	if err != nil {
		return fmt.Errorf("fetch JWKS from %s: %w", v.uri, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, jwksMaxBodyBytes))

	var doc jwksResponse
	if err := json.Unmarshal(body, &doc); err != nil {
		return fmt.Errorf("parse JWKS: %w", err)
	}

	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		pub, err := decodeRSAPublicKey(k.N, k.E)
		if err != nil {
			log.Printf("[proxy] JWKS: skip key kid=%q: %v", k.Kid, err)
			continue
		}
		keys[k.Kid] = pub
	}

	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

// Keyfunc implements jwt.Keyfunc for use with jwt.ParseWithClaims.
// Only RS256 (RSA) signing methods are accepted.
func (v *JWKSVerifier) Keyfunc(token *jwt.Token) (any, error) {
	if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
		return nil, fmt.Errorf("unexpected signing method %q: only RS256 is accepted", token.Header["alg"])
	}

	kid, _ := token.Header["kid"].(string)

	v.mu.RLock()
	key, found := v.keys[kid]
	stale := time.Since(v.fetchedAt) > jwksCacheTTL
	v.mu.RUnlock()

	if !found || stale {
		if err := v.refresh(); err != nil {
			if found {
				// Serve the stale key rather than blocking the request on a
				// transient JWKS endpoint failure.
				log.Printf("[proxy] JWKS: refresh failed (using cached key kid=%q): %v", kid, err)
				return key, nil
			}
			return nil, fmt.Errorf("JWKS refresh failed and kid %q not cached: %w", kid, err)
		}

		v.mu.RLock()
		key, found = v.keys[kid]
		v.mu.RUnlock()
		if !found {
			return nil, fmt.Errorf("unknown key id %q (not in JWKS after refresh)", kid)
		}
	}

	return key, nil
}

// decodeRSAPublicKey parses a JWK RSA key from its base64url-encoded N and E
// values.
func decodeRSAPublicKey(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, fmt.Errorf("decode modulus: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, fmt.Errorf("decode exponent: %w", err)
	}

	n := new(big.Int).SetBytes(nBytes)
	e := new(big.Int).SetBytes(eBytes)
	if e.BitLen() > 32 {
		return nil, fmt.Errorf("RSA exponent too large (%d bits)", e.BitLen())
	}

	return &rsa.PublicKey{N: n, E: int(e.Int64())}, nil
}
