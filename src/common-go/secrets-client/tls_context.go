package secretsclient

import (
	"crypto/tls"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// TLSContext is a hot-swapping TLS context backed by three PEM files:
// cert.pem, chain.pem, and key.pem.
//
// A rotation event on any of the three files schedules a coalesced reload
// so that three rapid renames produce exactly one context swap. The swap
// is a single pointer assignment under a read-write lock, so callers of
// Current() always see a consistent, fully-assembled *tls.Config.
type TLSContext interface {
	// Current returns the latest *tls.Config; always reflects the most
	// recently rotated certificate material.
	Current() *tls.Config
	// OnRotate registers a callback invoked after each successful context
	// swap. Returns an unsubscribe function.
	OnRotate(cb func()) Unsubscribe
}

type reloadableTLSContext struct {
	dir        string
	coalesceMs int
	onError    func(key string, err error)

	mu      sync.RWMutex
	current *tls.Config
	subs    map[uint64]func()
	nextID  uint64
	timer   *time.Timer
}

func newReloadableTLSContext(
	dir string,
	coalesceMs int,
	onError func(key string, err error),
) (*reloadableTLSContext, error) {
	cfg, err := buildTLSConfig(dir)
	if err != nil {
		return nil, err
	}
	return &reloadableTLSContext{
		dir:        dir,
		coalesceMs: coalesceMs,
		onError:    onError,
		current:    cfg,
		subs:       make(map[uint64]func()),
	}, nil
}

// buildTLSConfig reads cert.pem, key.pem, and optionally chain.pem from dir
// and returns a *tls.Config with the resulting certificate loaded.
//
// cert.pem  — leaf server certificate (required).
// key.pem   — private key matching cert.pem (required).
// chain.pem — intermediate CA certificates appended to cert.pem so peers
//
//	can verify the full chain. Optional; ENOENT is silently ignored.
func buildTLSConfig(dir string) (*tls.Config, error) {
	certPEM, err := os.ReadFile(filepath.Join(dir, "cert.pem"))
	if err != nil {
		return nil, fmt.Errorf("reading cert.pem: %w", err)
	}
	keyPEM, err := os.ReadFile(filepath.Join(dir, "key.pem"))
	if err != nil {
		return nil, fmt.Errorf("reading key.pem: %w", err)
	}

	fullCert := certPEM
	chainPath := filepath.Join(dir, "chain.pem")
	if chain, err := os.ReadFile(chainPath); err == nil && len(chain) > 0 {
		fullCert = append(append(certPEM, '\n'), chain...)
	} else if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("reading chain.pem: %w", err)
	}

	cert, err := tls.X509KeyPair(fullCert, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("assembling X509 key pair: %w", err)
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}}, nil
}

func (r *reloadableTLSContext) Current() *tls.Config {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.current
}

func (r *reloadableTLSContext) OnRotate(cb func()) Unsubscribe {
	r.mu.Lock()
	id := r.nextID
	r.nextID++
	r.subs[id] = cb
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.subs, id)
		r.mu.Unlock()
	}
}

func (r *reloadableTLSContext) scheduleReload() {
	r.mu.Lock()
	if r.timer != nil {
		r.timer.Stop()
	}
	r.timer = time.AfterFunc(
		time.Duration(r.coalesceMs)*time.Millisecond,
		r.reload,
	)
	r.mu.Unlock()
}

func (r *reloadableTLSContext) reload() {
	next, err := buildTLSConfig(r.dir)
	if err != nil {
		r.onError("tls:"+filepath.Base(r.dir), err)
		return // current retains last-known-good
	}

	r.mu.Lock()
	r.current = next
	subs := make(map[uint64]func(), len(r.subs))
	for id, cb := range r.subs {
		subs[id] = cb
	}
	r.mu.Unlock()

	for _, cb := range subs {
		func() {
			defer func() {
				if rec := recover(); rec != nil {
					r.onError(
						"tls:"+filepath.Base(r.dir)+":onRotate",
						fmt.Errorf("subscriber panic: %v", rec),
					)
				}
			}()
			cb()
		}()
	}
}

func (r *reloadableTLSContext) close() {
	r.mu.Lock()
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
	r.subs = make(map[uint64]func())
	r.mu.Unlock()
}
