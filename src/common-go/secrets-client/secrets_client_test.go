package secretsclient_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	secretsclient "github.com/agentstudio/common/secrets-client"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

// atomicWrite writes content to path via a temp-file rename, mirroring
// the CSI driver's atomic rotation mechanism.
func atomicWrite(t *testing.T, path, content string) {
	t.Helper()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		t.Fatalf("atomicWrite WriteFile: %v", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		t.Fatalf("atomicWrite Rename: %v", err)
	}
}

// waitFor polls cond every 10 ms until it returns true or timeout elapses.
func waitFor(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("waitFor timed out after %v", timeout)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// tlsFixture generates a self-signed ECDSA cert/key pair and writes
// cert.pem, key.pem, and an empty chain.pem under dir/tls/name/.
func tlsFixture(t *testing.T, root, name string) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour),
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	certDir := filepath.Join(root, "tls", name)
	if err := os.MkdirAll(certDir, 0o700); err != nil {
		t.Fatalf("mkdir tls: %v", err)
	}
	if err := os.WriteFile(filepath.Join(certDir, "cert.pem"), certPEM, 0o600); err != nil {
		t.Fatalf("write cert.pem: %v", err)
	}
	if err := os.WriteFile(filepath.Join(certDir, "key.pem"), keyPEM, 0o600); err != nil {
		t.Fatalf("write key.pem: %v", err)
	}
	if err := os.WriteFile(filepath.Join(certDir, "chain.pem"), []byte{}, 0o600); err != nil {
		t.Fatalf("write chain.pem: %v", err)
	}
	return certPEM, keyPEM
}

// ── T-L1: Happy-path init ──────────────────────────────────────────────────

func TestCreateSecretStore_HappyPath(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "db", "url"), []byte("postgresql://host/db"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
	})
	if err != nil {
		t.Fatalf("CreateSecretStore: %v", err)
	}
	defer store.Close()

	if store == nil {
		t.Fatal("expected non-nil store")
	}
}

// ── T-L2: Fail-fast on missing key ────────────────────────────────────────

func TestCreateSecretStore_MissingKey(t *testing.T) {
	root := t.TempDir()
	_, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
	})
	if err == nil {
		t.Fatal("expected error for missing required key")
	}
}

// ── T-L3: GetString returns file content ──────────────────────────────────

func TestGetString_ReturnsContent(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "db", "url"), []byte("postgresql://host/db"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.GetString("db/url")
	if err != nil {
		t.Fatalf("GetString: %v", err)
	}
	if got != "postgresql://host/db" {
		t.Errorf("got %q, want %q", got, "postgresql://host/db")
	}
}

// ── T-L4: Atomic rename triggers Watch callback ────────────────────────────

func TestWatch_AtomicRenameTriggersCallback(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var mu sync.Mutex
	var received []string
	_, err = store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("Watch: %v", err)
	}

	atomicWrite(t, filePath, "v2")

	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(received) >= 1
	})

	mu.Lock()
	defer mu.Unlock()
	if len(received) == 0 || received[len(received)-1] != "v2" {
		t.Errorf("got callbacks %v, want last value \"v2\"", received)
	}
}

// ── T-L5: Two renames within debounce window collapse to one callback ──────

func TestWatch_DebounceCollapses(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	const debounceMs = 300
	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   debounceMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var mu sync.Mutex
	var received []string
	_, _ = store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})

	atomicWrite(t, filePath, "v2")
	atomicWrite(t, filePath, "v3")

	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(received) >= 1
	})

	// Wait a full debounce window + buffer so any spurious second call arrives.
	time.Sleep((debounceMs + 100) * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 1 {
		t.Errorf("expected exactly 1 callback, got %d: %v", len(received), received)
	}
	if received[0] != "v3" {
		t.Errorf("expected value \"v3\", got %q", received[0])
	}
}

// ── T-L8: Unreadable file keeps last-known-good; OnError called ───────────

func TestReloadKey_UnreadableFileKeepsLastGood(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var errKeys []string
	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
		OnError: func(key string, _ error) {
			mu.Lock()
			errKeys = append(errKeys, key)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var subMu sync.Mutex
	var subCalled []string
	_, _ = store.Watch("db/url", func(next string) {
		subMu.Lock()
		subCalled = append(subCalled, next)
		subMu.Unlock()
	})

	// Rename the file away so the watcher sees a Rename event for db/url and
	// reloadKey attempts to read it — which fails with ENOENT, triggering onError.
	// os.Remove would generate only a DELETE event which the watcher ignores.
	if err := os.Rename(filePath, filePath+".gone"); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(errKeys) > 0
	})

	// Subscribers must NOT be invoked on read error.
	subMu.Lock()
	n := len(subCalled)
	subMu.Unlock()
	if n != 0 {
		t.Errorf("expected no subscriber calls on error, got %d", n)
	}

	// Old value must be preserved.
	got, _ := store.GetString("db/url")
	if got != "v1" {
		t.Errorf("expected cached value \"v1\", got %q", got)
	}

	mu.Lock()
	defer mu.Unlock()
	if errKeys[0] != "db/url" {
		t.Errorf("expected error key \"db/url\", got %q", errKeys[0])
	}
}

// ── T-L12: SECRETS_ROOT env var ───────────────────────────────────────────

func TestSecretsRootEnvVar(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "llm"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "llm", "api-key"), []byte("sk-test"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("SECRETS_ROOT", root)

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		RequiredKeys: []string{"llm/api-key"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.GetString("llm/api-key")
	if err != nil {
		t.Fatal(err)
	}
	if got != "sk-test" {
		t.Errorf("got %q, want %q", got, "sk-test")
	}
}

// ── T-L13: Unsubscribe removes callback ───────────────────────────────────

func TestUnsubscribe_RemovesCallback(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var mu sync.Mutex
	var received []string
	unsub, _ := store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})
	unsub()

	atomicWrite(t, filePath, "v2")
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 0 {
		t.Errorf("expected no callbacks after unsubscribe, got %v", received)
	}
}

// ── T-L14: Close stops watcher ────────────────────────────────────────────

func TestClose_StopsCallbacks(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
	})
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var received []string
	_, _ = store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})

	store.Close()
	atomicWrite(t, filePath, "v2")
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 0 {
		t.Errorf("expected no callbacks after Close, got %v", received)
	}
}

// ── T-L15: GetBytes and GetJSON ───────────────────────────────────────────

func TestGetBytesAndGetJSON(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "data", "raw"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgJSON, _ := json.Marshal(map[string]int{"port": 5432})
	if err := os.WriteFile(filepath.Join(root, "data", "cfg"), cfgJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"data/raw", "data/cfg"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	b, err := store.GetBytes("data/raw")
	if err != nil {
		t.Fatalf("GetBytes: %v", err)
	}
	if !bytes.Equal(b, []byte("hello")) {
		t.Errorf("GetBytes: got %q, want %q", b, "hello")
	}

	var cfg map[string]int
	if err := store.GetJSON("data/cfg", &cfg); err != nil {
		t.Fatalf("GetJSON: %v", err)
	}
	if cfg["port"] != 5432 {
		t.Errorf("GetJSON: port=%d, want 5432", cfg["port"])
	}
}

// ── T-L16: GetTLSContext throws for undeclared context ────────────────────

func TestGetTLSContext_Undeclared(t *testing.T) {
	root := t.TempDir()
	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	_, err = store.GetTLSContext("missing")
	if err == nil {
		t.Fatal("expected error for undeclared TLS context")
	}
}

// ── T-L19: Identical content reload does NOT notify subscribers ───────────

func TestReloadKey_IdenticalContentSkipsNotification(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "db"), 0o700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(root, "db", "url")
	if err := os.WriteFile(filePath, []byte("same"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	var mu sync.Mutex
	var received []string
	_, _ = store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})

	atomicWrite(t, filePath, "same") // identical bytes
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(received) != 0 {
		t.Errorf("expected no callbacks for identical content, got %v", received)
	}
}

// ── T-L9 (TLS): Three renames within coalesce window produce one swap ─────

func TestTLSContext_CoalescesThreeRenames(t *testing.T) {
	root := t.TempDir()
	certPEM, keyPEM := tlsFixture(t, root, "server")

	const coalesceMs = 300
	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:                root,
		RequiredKeys:        []string{},
		RequiredTLSContexts: []string{"server"},
		DebounceMs:          50,
		TLSCoalesceMs:       coalesceMs,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	tlsCtx, err := store.GetTLSContext("server")
	if err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var rotations []time.Time
	tlsCtx.OnRotate(func() {
		mu.Lock()
		rotations = append(rotations, time.Now())
		mu.Unlock()
	})

	certDir := filepath.Join(root, "tls", "server")
	atomicWrite(t, filepath.Join(certDir, "cert.pem"), string(certPEM))
	atomicWrite(t, filepath.Join(certDir, "chain.pem"), "")
	atomicWrite(t, filepath.Join(certDir, "key.pem"), string(keyPEM))

	waitFor(t, 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(rotations) >= 1
	})

	time.Sleep((coalesceMs + 100) * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(rotations) != 1 {
		t.Errorf("expected exactly 1 TLS rotation, got %d", len(rotations))
	}
	if tlsCtx.Current() == nil {
		t.Error("TLS context is nil after rotation")
	}
}

// ── T-L22: Fail-fast on missing TLS PEM files ─────────────────────────────

func TestCreateSecretStore_MissingTLSContext(t *testing.T) {
	root := t.TempDir()
	_, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:                root,
		RequiredKeys:        []string{},
		RequiredTLSContexts: []string{"missing-tls"},
	})
	if err == nil {
		t.Fatal("expected error for missing TLS context PEM files")
	}
}

// ── T-L24: ..data symlink rename reloads all cached keys ─────────────────

func TestDotDataRotation_ReloadsAllKeys(t *testing.T) {
	root := t.TempDir()

	// Build v1 layout: ..data -> ..data_v1/, db/url is a symlink through ..data
	v1Dir := filepath.Join(root, "..data_v1", "db")
	if err := os.MkdirAll(v1Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v1Dir, "url"), []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}

	dataLink := filepath.Join(root, "..data")
	if err := os.Symlink(filepath.Join(root, "..data_v1"), dataLink); err != nil {
		t.Fatal(err)
	}

	dbDir := filepath.Join(root, "db")
	if err := os.MkdirAll(dbDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..data", "db", "url"), filepath.Join(dbDir, "url")); err != nil {
		t.Fatal(err)
	}

	store, err := secretsclient.CreateSecretStore(secretsclient.Options{
		Root:         root,
		RequiredKeys: []string{"db/url"},
		DebounceMs:   50,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, _ := store.GetString("db/url")
	if got != "v1" {
		t.Fatalf("initial value: got %q, want v1", got)
	}

	var mu sync.Mutex
	var received []string
	_, _ = store.Watch("db/url", func(next string) {
		mu.Lock()
		received = append(received, next)
		mu.Unlock()
	})

	// Build v2 layout and atomically swap ..data symlink.
	v2Dir := filepath.Join(root, "..data_v2", "db")
	if err := os.MkdirAll(v2Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v2Dir, "url"), []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	tmpLink := filepath.Join(root, "..data_tmp")
	if err := os.Symlink(filepath.Join(root, "..data_v2"), tmpLink); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmpLink, dataLink); err != nil {
		t.Fatal(err)
	}

	waitFor(t, 5*time.Second, func() bool {
		got, _ := store.GetString("db/url")
		return got == "v2"
	})

	got, _ = store.GetString("db/url")
	if got != "v2" {
		t.Errorf("after rotation: got %q, want v2", got)
	}

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, v := range received {
		if v == "v2" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected watch callback with v2, got %v", received)
	}
}
