// Package secretsclient provides a long-lived secret store for applications
// running inside Kubernetes pods that have a Secrets Store CSI Driver volume
// mounted at /mnt/secrets (or $SECRETS_ROOT).
//
// Secrets are read from files under <root>/<group>/<key> and kept fresh via
// an inotify-backed file watcher that reacts to atomic renames (the exact
// mechanism used by the CSI driver). Reads are O(1) from an in-memory cache
// and are never blocked on I/O after initialisation.
//
// API surface is intentionally parallel to the TypeScript and Python
// secrets-client libraries:
//
//	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
//	    RequiredKeys: []string{"db/url", "keycloak/client-secret"},
//	    RequiredTLSContexts: []string{"server"},
//	})
//
//	url, err := store.GetString("db/url")
//	unsub, _ := store.Watch("db/url", func(next string) { reconfigurePool(next) })
//
//	tlsCtx, _ := store.GetTLSContext("server")
//	tlsCtx.OnRotate(func() { log.Println("TLS rotated") })
package secretsclient

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

const (
	defaultRoot             = "/mnt/secrets"
	defaultDebounceMs       = 250
	defaultTLSCoalesceMs    = 500
	consecutiveErrThreshold = 5
)

var tlsFileRe = regexp.MustCompile(`^tls/([^/]+)/(cert|chain|key)\.pem$`)

// Unsubscribe removes a watch subscription when called.
type Unsubscribe func()

// SecretStore is a long-lived store backed by CSI-mounted secret files.
// All public methods are safe for concurrent use.
type SecretStore interface {
	// GetString returns the current value of key as a UTF-8 string.
	// Returns an error if key was not declared in RequiredKeys.
	GetString(key string) (string, error)
	// GetBytes returns the raw bytes for key.
	GetBytes(key string) ([]byte, error)
	// GetJSON JSON-decodes the value of key into v.
	GetJSON(key string, v any) error
	// Watch subscribes to future rotations of key. The callback is invoked
	// with the new string value after each rotation. Returns an unsubscribe
	// function. Returns an error if key was not declared in RequiredKeys.
	Watch(key string, cb func(next string)) (Unsubscribe, error)
	// GetTLSContext returns the hot-swapping TLS context for the named context.
	// Returns an error if name was not declared in RequiredTLSContexts.
	GetTLSContext(name string) (TLSContext, error)
	// Close releases fs.watch handles and all timers.
	// Test-only: production code should not call this.
	Close()
}

// Options configures the SecretStore created by CreateSecretStore.
type Options struct {
	// Root overrides the secrets mount point.
	// Defaults to $SECRETS_ROOT env var, or /mnt/secrets.
	Root string
	// DebounceMs is the debounce window for rename events. Defaults to 250 ms.
	DebounceMs int
	// TLSCoalesceMs is the coalescing window for TLS triple-rename events.
	// Defaults to 500 ms.
	TLSCoalesceMs int
	// RequiredKeys are verified eagerly at init. CreateSecretStore returns an
	// error if any key file is missing.
	RequiredKeys []string
	// RequiredTLSContexts are TLS context names verified at init.
	RequiredTLSContexts []string
	// OnError is invoked on read errors during rotation.
	// Defaults to logging to stderr.
	OnError func(key string, err error)
}

type secretStoreImpl struct {
	root          string
	tlsCoalesceMs int
	onError       func(key string, err error)

	mu                sync.RWMutex
	cache             map[string][]byte
	subscribers       map[string]map[uint64]func(string)
	tlsContexts       map[string]*reloadableTLSContext
	consecutiveErrors map[string]int
	nextSubID         uint64

	watcher   *directoryWatcher
	debounced *debouncedHandler
}

// CreateSecretStore creates and initialises a long-lived SecretStore.
//
// Eagerly reads every RequiredKey and assembles every RequiredTLSContext at
// init time. Returns an error if any key is missing or any TLS context cannot
// be assembled — the application should abort on init rather than operate with
// missing secrets.
func CreateSecretStore(opts Options) (SecretStore, error) {
	root := opts.Root
	if root == "" {
		if r := os.Getenv("SECRETS_ROOT"); r != "" {
			root = r
		} else {
			root = defaultRoot
		}
	}

	debounceMs := opts.DebounceMs
	if debounceMs == 0 {
		debounceMs = defaultDebounceMs
	}
	tlsCoalesceMs := opts.TLSCoalesceMs
	if tlsCoalesceMs == 0 {
		tlsCoalesceMs = defaultTLSCoalesceMs
	}
	onError := opts.OnError
	if onError == nil {
		onError = func(key string, err error) {
			fmt.Fprintf(os.Stderr, "[secrets-client] Error for %q: %v\n", key, err)
		}
	}

	s := &secretStoreImpl{
		root:              root,
		tlsCoalesceMs:     tlsCoalesceMs,
		onError:           onError,
		cache:             make(map[string][]byte),
		subscribers:       make(map[string]map[uint64]func(string)),
		tlsContexts:       make(map[string]*reloadableTLSContext),
		consecutiveErrors: make(map[string]int),
	}

	for _, key := range opts.RequiredKeys {
		if err := s.loadRequired(key); err != nil {
			return nil, fmt.Errorf(
				"[secrets-client] required key %q missing at %q: %w",
				key, filepath.Join(root, key), err,
			)
		}
	}

	for _, name := range opts.RequiredTLSContexts {
		if err := s.loadTLSContext(name); err != nil {
			return nil, fmt.Errorf(
				"[secrets-client] required TLS context %q could not be assembled: %w",
				name, err,
			)
		}
	}

	s.debounced = newDebouncedHandler(s.handleRename, debounceMs)

	var err error
	s.watcher, err = newDirectoryWatcher(root, s.debounced.call, func(e error) {
		s.onError("watcher:fs", e)
	})
	if err != nil {
		return nil, fmt.Errorf("[secrets-client] failed to start watcher: %w", err)
	}

	return s, nil
}

// ── Init helpers ─────────────────────────────────────────────────────────────

func (s *secretStoreImpl) loadRequired(key string) error {
	normalized, err := normalizeKey(key)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(s.root, normalized))
	if err != nil {
		return err
	}
	s.cache[normalized] = data
	return nil
}

func (s *secretStoreImpl) loadTLSContext(name string) error {
	if err := validateTLSName(name); err != nil {
		return err
	}
	dir := filepath.Join(s.root, "tls", name)
	ctx, err := newReloadableTLSContext(dir, s.tlsCoalesceMs, s.onError)
	if err != nil {
		return err
	}
	s.tlsContexts[name] = ctx
	return nil
}

// ── Public API ────────────────────────────────────────────────────────────────

func (s *secretStoreImpl) GetString(key string) (string, error) {
	b, err := s.GetBytes(key)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (s *secretStoreImpl) GetBytes(key string) ([]byte, error) {
	normalized, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	b, ok := s.cache[normalized]
	if !ok {
		return nil, fmt.Errorf(
			"[secrets-client] key %q not in cache; declare it in RequiredKeys", key,
		)
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	return cp, nil
}

func (s *secretStoreImpl) GetJSON(key string, v any) error {
	b, err := s.GetBytes(key)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (s *secretStoreImpl) Watch(key string, cb func(string)) (Unsubscribe, error) {
	normalized, err := normalizeKey(key)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if _, ok := s.cache[normalized]; !ok {
		s.mu.Unlock()
		return nil, fmt.Errorf(
			"[secrets-client] cannot watch key %q: not declared in RequiredKeys", key,
		)
	}
	id := s.nextSubID
	s.nextSubID++
	if s.subscribers[normalized] == nil {
		s.subscribers[normalized] = make(map[uint64]func(string))
	}
	s.subscribers[normalized][id] = cb
	s.mu.Unlock()

	return func() {
		s.mu.Lock()
		delete(s.subscribers[normalized], id)
		s.mu.Unlock()
	}, nil
}

func (s *secretStoreImpl) GetTLSContext(name string) (TLSContext, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ctx, ok := s.tlsContexts[name]
	if !ok {
		return nil, fmt.Errorf(
			"[secrets-client] TLS context %q not declared in RequiredTLSContexts", name,
		)
	}
	return ctx, nil
}

func (s *secretStoreImpl) Close() {
	if s.watcher != nil {
		s.watcher.close()
	}
	if s.debounced != nil {
		s.debounced.cancel()
	}
	s.mu.Lock()
	for _, ctx := range s.tlsContexts {
		ctx.close()
	}
	s.subscribers = make(map[string]map[uint64]func(string))
	s.tlsContexts = make(map[string]*reloadableTLSContext)
	s.mu.Unlock()
}

// ── Rotation handler ──────────────────────────────────────────────────────────

func (s *secretStoreImpl) handleRename(filePath string) {
	rel, err := filepath.Rel(s.root, filePath)
	if err != nil {
		return
	}
	// Normalise to forward slashes for consistent matching on all platforms.
	rel = filepath.ToSlash(rel)

	// The CSI driver rotates content by atomically renaming the "..data"
	// symlink to a new timestamped directory. Individual file paths resolve
	// through "..data", so their content changes without generating rename
	// events of their own. Treat any "..data" rename as a full reload signal.
	isDataRotation := rel == "..data" || strings.HasSuffix(rel, "/..data")
	if isDataRotation {
		s.mu.RLock()
		keys := make([]string, 0, len(s.cache))
		for k := range s.cache {
			keys = append(keys, k)
		}
		ctxs := make([]*reloadableTLSContext, 0, len(s.tlsContexts))
		for _, ctx := range s.tlsContexts {
			ctxs = append(ctxs, ctx)
		}
		s.mu.RUnlock()
		for _, k := range keys {
			s.reloadKey(k)
		}
		for _, ctx := range ctxs {
			ctx.scheduleReload()
		}
		return
	}

	// TLS file rename: tls/<name>/{cert,chain,key}.pem
	if m := tlsFileRe.FindStringSubmatch(rel); m != nil {
		name := m[1]
		s.mu.RLock()
		ctx := s.tlsContexts[name]
		s.mu.RUnlock()
		if ctx != nil {
			ctx.scheduleReload()
		}
		return
	}

	// Plain secret key rename.
	s.mu.RLock()
	_, tracked := s.cache[rel]
	s.mu.RUnlock()
	if !tracked {
		return
	}
	s.reloadKey(rel)
}

func (s *secretStoreImpl) reloadKey(key string) {
	data, err := os.ReadFile(filepath.Join(s.root, key))
	if err != nil {
		s.mu.Lock()
		count := s.consecutiveErrors[key] + 1
		s.consecutiveErrors[key] = count
		s.mu.Unlock()
		if count >= consecutiveErrThreshold {
			s.onError(key, fmt.Errorf(
				"[secrets-client] %d consecutive rotation read errors for key %q; last: %w",
				count, key, err,
			))
		} else {
			s.onError(key, err)
		}
		return // cache retains last-known-good; subscribers are NOT invoked
	}

	s.mu.Lock()
	prev := s.cache[key]
	if bytes.Equal(prev, data) {
		s.mu.Unlock()
		return // identical bytes — skip notification
	}
	s.cache[key] = data
	s.consecutiveErrors[key] = 0
	subs := make(map[uint64]func(string), len(s.subscribers[key]))
	for id, cb := range s.subscribers[key] {
		subs[id] = cb
	}
	s.mu.Unlock()

	value := string(data)
	for _, cb := range subs {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					s.onError(key, fmt.Errorf("[secrets-client] subscriber panic: %v", rec))
				}
			}()
			cb(value)
		}()
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// normalizeKey validates and returns a canonical forward-slash relative path.
// Rejects absolute paths and ".." segments; collapses "." segments.
func normalizeKey(key string) (string, error) {
	slashKey := filepath.ToSlash(key)
	if filepath.IsAbs(key) || strings.HasPrefix(slashKey, "/") {
		return "", fmt.Errorf(
			"[secrets-client] invalid key %q: must be relative to the secrets root", key,
		)
	}
	for _, part := range strings.Split(slashKey, "/") {
		if part == ".." {
			return "", fmt.Errorf(
				"[secrets-client] invalid key %q: must not contain \"..\" segments", key,
			)
		}
	}
	// filepath.Clean collapses "." segments and normalises separators.
	normalized := filepath.ToSlash(filepath.Clean(slashKey))
	if normalized == "." {
		return "", fmt.Errorf("[secrets-client] invalid key %q: empty or \".\" key", key)
	}
	return normalized, nil
}

func validateTLSName(name string) error {
	for _, c := range name {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			return fmt.Errorf(
				"[secrets-client] invalid TLS context name %q: only letters, digits, hyphens, and underscores allowed",
				name,
			)
		}
	}
	return nil
}
