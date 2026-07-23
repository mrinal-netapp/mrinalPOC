//! Integration tests for agentstudio-secrets-client.
//!
//! Uses real tmpfs-backed temp directories and actual atomic renames so the
//! watcher exercises real inotify/kqueue code paths.  Mirrors the TypeScript
//! and Python test suites (T-L1 through T-L22).

use std::{
    fs,
    path::Path,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use agentstudio_secrets_client::{create_secret_store, Options};
use rcgen::{generate_simple_self_signed, CertifiedKey};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn atomic_write(path: &Path, content: &[u8]) {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).expect("atomic_write: write temp");
    fs::rename(&tmp, path).expect("atomic_write: rename");
}

fn wait_for(timeout: Duration, cond: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while !cond() {
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
    true
}

fn tls_fixture(root: &Path, name: &str) -> CertifiedKey {
    let ck = generate_simple_self_signed(vec!["test".into()]).unwrap();
    let cert_dir = root.join("tls").join(name);
    fs::create_dir_all(&cert_dir).unwrap();
    fs::write(cert_dir.join("cert.pem"), ck.cert.pem()).unwrap();
    fs::write(cert_dir.join("key.pem"), ck.key_pair.serialize_pem()).unwrap();
    fs::write(cert_dir.join("chain.pem"), b"").unwrap();
    ck
}

// ── T-L1: Happy-path init ──────────────────────────────────────────────────

#[test]
fn tl1_happy_path_init() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    fs::write(root.join("db/url"), b"postgresql://host/db").unwrap();

    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        ..Default::default()
    })
    .expect("init should succeed");

    store.close();
}

// ── T-L2: Fail-fast on missing key ────────────────────────────────────────

#[test]
fn tl2_fail_fast_missing_key() {
    let dir = tempfile::tempdir().unwrap();
    let result = create_secret_store(Options {
        root: Some(dir.path().to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        ..Default::default()
    });
    assert!(result.is_err(), "expected error for missing key");
    assert!(result.err().unwrap().to_string().contains("db/url"));
}

// ── T-L3: get_string returns file content ─────────────────────────────────

#[test]
fn tl3_get_string_returns_content() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    fs::write(root.join("db/url"), b"postgresql://host/db").unwrap();

    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        ..Default::default()
    })
    .unwrap();

    assert_eq!(store.get_string("db/url").unwrap(), "postgresql://host/db");
    store.close();
}

// ── T-L4: Atomic rename triggers watch callback ───────────────────────────

#[test]
fn tl4_atomic_rename_triggers_watch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    let file_path = root.join("db/url");
    fs::write(&file_path, b"v1").unwrap();

    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        debounce_ms: 50,
        ..Default::default()
    })
    .unwrap();

    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let recv_clone = Arc::clone(&received);
    let _unsub = store
        .watch("db/url", move |next| {
            recv_clone.lock().unwrap().push(next.to_string());
        })
        .unwrap();

    atomic_write(&file_path, b"v2");

    assert!(
        wait_for(Duration::from_secs(5), || {
            !received.lock().unwrap().is_empty()
        }),
        "watch callback never fired"
    );

    let r = received.lock().unwrap();
    assert!(
        r.iter().any(|v| v == "v2"),
        "expected v2 in callbacks, got {:?}",
        r
    );
    store.close();
}

// ── T-L5: Two renames within debounce window collapse to one callback ──────

#[test]
fn tl5_debounce_collapses_rapid_renames() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    let file_path = root.join("db/url");
    fs::write(&file_path, b"v1").unwrap();

    const DEBOUNCE_MS: u64 = 300;
    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        debounce_ms: DEBOUNCE_MS,
        ..Default::default()
    })
    .unwrap();

    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let recv_clone = Arc::clone(&received);
    let _unsub = store
        .watch("db/url", move |next| {
            recv_clone.lock().unwrap().push(next.to_string());
        })
        .unwrap();

    atomic_write(&file_path, b"v2");
    atomic_write(&file_path, b"v3");

    assert!(
        wait_for(Duration::from_secs(5), || {
            !received.lock().unwrap().is_empty()
        }),
        "debounced callback never fired"
    );

    thread::sleep(Duration::from_millis(DEBOUNCE_MS + 100));

    let r = received.lock().unwrap();
    assert_eq!(r.len(), 1, "expected exactly 1 callback, got {:?}", r);
    assert_eq!(r[0], "v3");
    store.close();
}

// ── T-L8: Unreadable file keeps last-known-good ───────────────────────────

#[test]
fn tl8_unreadable_file_keeps_last_known_good() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    let file_path = root.join("db/url");
    fs::write(&file_path, b"v1").unwrap();

    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let errors_clone = Arc::clone(&errors);
    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        debounce_ms: 50,
        on_error: Some(Arc::new(move |key, _| {
            errors_clone.lock().unwrap().push(key.to_string());
        })),
        ..Default::default()
    })
    .unwrap();

    let sub_called: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let sub_clone = Arc::clone(&sub_called);
    let _unsub = store
        .watch("db/url", move |next| {
            sub_clone.lock().unwrap().push(next.to_string());
        })
        .unwrap();

    fs::remove_file(&file_path).unwrap();

    assert!(
        wait_for(Duration::from_secs(5), || {
            !errors.lock().unwrap().is_empty()
        }),
        "on_error never called"
    );

    // Subscribers must NOT be invoked on read error.
    assert_eq!(sub_called.lock().unwrap().len(), 0);
    // Old value must be preserved.
    assert_eq!(store.get_string("db/url").unwrap(), "v1");

    store.close();
}

// ── T-L12: SECRETS_ROOT env var ───────────────────────────────────────────

#[test]
fn tl12_secrets_root_env_var() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("llm")).unwrap();
    fs::write(root.join("llm/api-key"), b"sk-test").unwrap();

    std::env::set_var("SECRETS_ROOT", root.to_str().unwrap());
    let store = create_secret_store(Options {
        required_keys: vec!["llm/api-key".into()],
        ..Default::default()
    })
    .unwrap();
    std::env::remove_var("SECRETS_ROOT");

    assert_eq!(store.get_string("llm/api-key").unwrap(), "sk-test");
    store.close();
}

// ── T-L13: Unsubscribe removes callback ───────────────────────────────────

#[test]
fn tl13_unsubscribe_removes_callback() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    let file_path = root.join("db/url");
    fs::write(&file_path, b"v1").unwrap();

    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        debounce_ms: 50,
        ..Default::default()
    })
    .unwrap();

    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let recv_clone = Arc::clone(&received);
    let unsub = store
        .watch("db/url", move |next| {
            recv_clone.lock().unwrap().push(next.to_string());
        })
        .unwrap();

    unsub();
    atomic_write(&file_path, b"v2");
    thread::sleep(Duration::from_millis(300));

    assert_eq!(received.lock().unwrap().len(), 0);
    store.close();
}

// ── T-L19: Identical content does not notify ──────────────────────────────

#[test]
fn tl19_identical_content_skips_notification() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("db")).unwrap();
    let file_path = root.join("db/url");
    fs::write(&file_path, b"same").unwrap();

    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        required_keys: vec!["db/url".into()],
        debounce_ms: 50,
        ..Default::default()
    })
    .unwrap();

    let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
    let recv_clone = Arc::clone(&received);
    let _unsub = store
        .watch("db/url", move |next| {
            recv_clone.lock().unwrap().push(next.to_string());
        })
        .unwrap();

    atomic_write(&file_path, b"same");
    thread::sleep(Duration::from_millis(300));

    assert_eq!(received.lock().unwrap().len(), 0);
    store.close();
}

// ── T-L22: Fail-fast on missing TLS context ───────────────────────────────

#[test]
fn tl22_fail_fast_missing_tls_context() {
    let dir = tempfile::tempdir().unwrap();
    let result = create_secret_store(Options {
        root: Some(dir.path().to_str().unwrap().into()),
        required_tls_contexts: vec!["missing-tls".into()],
        ..Default::default()
    });
    assert!(result.is_err());
    assert!(result.err().unwrap().to_string().contains("missing-tls"));
}

// ── T-L9 (TLS): Three renames coalesce into one swap ─────────────────────

#[test]
fn tl9_tls_coalesces_three_renames() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let ck = tls_fixture(root, "server");

    const COALESCE_MS: u64 = 300;
    let store = create_secret_store(Options {
        root: Some(root.to_str().unwrap().into()),
        tls_coalesce_ms: COALESCE_MS,
        debounce_ms: 50,
        required_tls_contexts: vec!["server".into()],
        ..Default::default()
    })
    .unwrap();

    let tls_ctx = store.get_tls_context("server").unwrap();
    let rotations: Arc<Mutex<u32>> = Arc::new(Mutex::new(0));
    let rot_clone = Arc::clone(&rotations);
    let _unsub = tls_ctx.on_rotate(move || {
        *rot_clone.lock().unwrap() += 1;
    });

    let cert_dir = root.join("tls/server");
    atomic_write(&cert_dir.join("cert.pem"), ck.cert.pem().as_bytes());
    atomic_write(&cert_dir.join("chain.pem"), b"");
    atomic_write(
        &cert_dir.join("key.pem"),
        ck.key_pair.serialize_pem().as_bytes(),
    );

    assert!(
        wait_for(Duration::from_secs(5), || {
            *rotations.lock().unwrap() >= 1
        }),
        "TLS rotation callback never fired"
    );

    thread::sleep(Duration::from_millis(COALESCE_MS + 100));
    assert_eq!(
        *rotations.lock().unwrap(),
        1,
        "expected exactly 1 TLS rotation"
    );

    store.close();
}
