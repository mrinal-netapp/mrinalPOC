//! `agentstudio-secrets-client` — Rust parity library for the Secrets Store
//! CSI Driver integration.
//!
//! Reads secrets from CSI-mounted files under `/mnt/secrets/<group>/<key>` and
//! provides live rotation via inotify-backed file watching.
//!
//! API surface is intentionally parallel to the TypeScript and Python
//! secrets-client libraries:
//!
//! ```no_run
//! use agentstudio_secrets_client::{create_secret_store, Options};
//!
//! let store = create_secret_store(Options {
//!     required_keys: vec!["db/url".into(), "keycloak/client-secret".into()],
//!     required_tls_contexts: vec!["server".into()],
//!     ..Default::default()
//! })
//! .expect("secret store init failed");
//!
//! let url = store.get_string("db/url").unwrap();
//! let _unsub = store.watch("db/url", |next| println!("rotated: {next}")).unwrap();
//!
//! let tls = store.get_tls_context("server").unwrap();
//! let _unsub_tls = tls.on_rotate(|| println!("TLS rotated"));
//! ```

use std::{
    collections::HashMap,
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use parking_lot::RwLock;

mod tls;
mod watcher;

pub use tls::ReloadableTlsContext;

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("[secrets-client] Key {0:?} not in cache; declare it in required_keys")]
    KeyNotFound(String),
    #[error("[secrets-client] TLS context {0:?} not declared in required_tls_contexts")]
    TlsContextNotFound(String),
    #[error("[secrets-client] Invalid key {key:?}: {reason}")]
    InvalidKey { key: String, reason: String },
    #[error("[secrets-client] I/O error for {key:?}: {source}")]
    Io {
        key: String,
        #[source]
        source: std::io::Error,
    },
    #[error("[secrets-client] {0}")]
    Other(String),
}

impl SecretError {
    pub(crate) fn io(key: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            key: key.into(),
            source,
        }
    }
    pub(crate) fn invalid_key(key: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidKey {
            key: key.into(),
            reason: reason.into(),
        }
    }
}

// ── Public types ──────────────────────────────────────────────────────────────

/// An unsubscribe function returned by [`SecretStore::watch`].
pub type Unsubscribe = Box<dyn Fn() + Send + Sync + 'static>;

/// Error-callback function pointer type, shared by [`Options`] and [`SecretStoreInner`].
pub(crate) type OnErrorFn = dyn Fn(&str, &dyn std::error::Error) + Send + Sync;

/// Per-key subscriber callback type.
pub(crate) type SubFn = dyn Fn(&str) + Send + Sync + 'static;

// ── Options ───────────────────────────────────────────────────────────────────

/// Configuration for [`create_secret_store`].
pub struct Options {
    /// Secrets mount root. Defaults to `$SECRETS_ROOT` or `/mnt/secrets`.
    pub root: Option<String>,
    /// Debounce window for rename events in milliseconds. Defaults to 250.
    pub debounce_ms: u64,
    /// Coalescing window for TLS triple-rename events in milliseconds. Defaults to 500.
    pub tls_coalesce_ms: u64,
    /// Required keys verified eagerly at init.
    pub required_keys: Vec<String>,
    /// Required TLS context names verified eagerly at init.
    pub required_tls_contexts: Vec<String>,
    /// Error callback invoked on rotation read errors. Defaults to stderr logging.
    pub on_error: Option<Arc<OnErrorFn>>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            root: None,
            debounce_ms: 250,
            tls_coalesce_ms: 500,
            required_keys: vec![],
            required_tls_contexts: vec![],
            on_error: None,
        }
    }
}

// ── SecretStore ───────────────────────────────────────────────────────────────

struct StoreState {
    cache: HashMap<String, Vec<u8>>,
    // Store subscriber callbacks as Arc so we can snapshot them out of the
    // RwLock before calling, without holding the lock during invocation.
    subscribers: HashMap<String, HashMap<u64, Arc<SubFn>>>,
    tls_contexts: HashMap<String, Arc<ReloadableTlsContext>>,
    consecutive_errors: HashMap<String, u32>,
    next_sub_id: u64,
}

struct SecretStoreInner {
    root: PathBuf,
    state: RwLock<StoreState>,
    on_error: Arc<OnErrorFn>,
    _watcher: watcher::DirectoryWatcher,
    debouncer: watcher::Debouncer,
}

/// Long-lived secret store for the life of the process.
///
/// All reads are O(1) from an in-memory cache. The cache is kept fresh by a
/// file watcher reacting to inotify rename events. Clone is cheap (Arc).
#[derive(Clone)]
pub struct SecretStore {
    inner: Arc<SecretStoreInner>,
}

const CONSECUTIVE_ERR_THRESHOLD: u32 = 5;

impl SecretStore {
    /// Returns the current value of `key` as a UTF-8 string.
    pub fn get_string(&self, key: &str) -> Result<String, SecretError> {
        let bytes = self.get_bytes(key)?;
        String::from_utf8(bytes).map_err(|e| SecretError::Other(e.to_string()))
    }

    /// Returns the raw bytes for `key`.
    pub fn get_bytes(&self, key: &str) -> Result<Vec<u8>, SecretError> {
        let normalized = normalize_key(key)?;
        let state = self.inner.state.read();
        state
            .cache
            .get(&normalized)
            .cloned()
            .ok_or_else(|| SecretError::KeyNotFound(key.to_string()))
    }

    /// JSON-decodes the value of `key` into `T`.
    pub fn get_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<T, SecretError> {
        let s = self.get_string(key)?;
        serde_json::from_str(&s).map_err(|e| SecretError::Other(e.to_string()))
    }

    /// Subscribes to future rotations of `key`. The callback receives the new
    /// value as a `&str` after each rotation. Returns an [`Unsubscribe`]
    /// function. Returns an error if `key` was not in `required_keys`.
    pub fn watch(
        &self,
        key: &str,
        cb: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Unsubscribe, SecretError> {
        let normalized = normalize_key(key)?;
        let mut state = self.inner.state.write();
        if !state.cache.contains_key(&normalized) {
            return Err(SecretError::KeyNotFound(key.to_string()));
        }
        let id = state.next_sub_id;
        state.next_sub_id += 1;
        let cb: Arc<dyn Fn(&str) + Send + Sync + 'static> = Arc::new(cb);
        state
            .subscribers
            .entry(normalized.clone())
            .or_default()
            .insert(id, cb);
        drop(state);

        let inner = Arc::clone(&self.inner);
        let key_clone = normalized;
        Ok(Box::new(move || {
            let mut state = inner.state.write();
            if let Some(subs) = state.subscribers.get_mut(&key_clone) {
                subs.remove(&id);
            }
        }))
    }

    /// Returns the hot-swapping TLS context for `name`.
    pub fn get_tls_context(&self, name: &str) -> Result<Arc<ReloadableTlsContext>, SecretError> {
        let state = self.inner.state.read();
        state
            .tls_contexts
            .get(name)
            .cloned()
            .ok_or_else(|| SecretError::TlsContextNotFound(name.to_string()))
    }

    /// Releases file-watch handles and all timers. Test-only.
    pub fn close(self) {
        self.inner.debouncer.cancel();
    }

    // ── Internal handlers ─────────────────────────────────────────────────────

    fn handle_rename(&self, file_path: PathBuf) {
        let rel = match file_path.strip_prefix(&self.inner.root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => return,
        };

        let is_data_rotation = rel == "..data" || rel.ends_with("/..data");
        if is_data_rotation {
            let (keys, ctxs): (Vec<String>, Vec<Arc<ReloadableTlsContext>>) = {
                let state = self.inner.state.read();
                (
                    state.cache.keys().cloned().collect(),
                    state.tls_contexts.values().cloned().collect(),
                )
            };
            for key in keys {
                self.reload_key(&key);
            }
            for ctx in ctxs {
                ctx.schedule_reload();
            }
            return;
        }

        // TLS file: tls/<name>/{cert,chain,key}.pem
        if let Some(ctx) = self.match_tls_path(&rel) {
            ctx.schedule_reload();
            return;
        }

        // Plain secret key.
        let tracked = self.inner.state.read().cache.contains_key(&rel);
        if tracked {
            self.reload_key(&rel);
        }
    }

    fn match_tls_path(&self, rel: &str) -> Option<Arc<ReloadableTlsContext>> {
        let parts: Vec<&str> = rel.splitn(4, '/').collect();
        if parts.len() == 3
            && parts[0] == "tls"
            && matches!(parts[2], "cert.pem" | "chain.pem" | "key.pem")
        {
            let state = self.inner.state.read();
            return state.tls_contexts.get(parts[1]).cloned();
        }
        None
    }

    fn reload_key(&self, key: &str) {
        let file_path = self.inner.root.join(key);
        match fs::read(&file_path) {
            Ok(data) => {
                // Snapshot subscribers as Arcs before releasing the write lock.
                let cbs: Vec<Arc<SubFn>> = {
                    let mut state = self.inner.state.write();
                    let prev = state.cache.get(key);
                    if prev.map(|p| p == &data).unwrap_or(false) {
                        return; // identical bytes — skip notification
                    }
                    state.cache.insert(key.to_string(), data.clone());
                    *state.consecutive_errors.entry(key.to_string()).or_insert(0) = 0;
                    state
                        .subscribers
                        .get(key)
                        .map(|m| m.values().cloned().collect())
                        .unwrap_or_default()
                };

                let value = match String::from_utf8(data) {
                    Ok(s) => s,
                    Err(e) => {
                        let err = SecretError::Other(format!(
                            "[secrets-client] invalid UTF-8 for key {key:?} after rotation: {e}"
                        ));
                        (self.inner.on_error)(key, &err as &dyn std::error::Error);
                        return;
                    }
                };
                for cb in cbs {
                    let v = value.clone();
                    if let Err(e) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(v.as_str())))
                    {
                        let err = SecretError::Other(format!("subscriber panic: {e:?}"));
                        (self.inner.on_error)(key, &err as &dyn std::error::Error);
                    }
                }
            }
            Err(e) => {
                let count = {
                    let mut state = self.inner.state.write();
                    let c = state.consecutive_errors.entry(key.to_string()).or_insert(0);
                    *c += 1;
                    *c
                };
                let err: SecretError = if count >= CONSECUTIVE_ERR_THRESHOLD {
                    SecretError::Other(format!(
                        "[secrets-client] {count} consecutive rotation read errors for \
                         key {key:?}; last: {e}"
                    ))
                } else {
                    SecretError::io(key, e)
                };
                (self.inner.on_error)(key, &err as &dyn std::error::Error);
            }
        }
    }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/// Creates and initialises a long-lived [`SecretStore`].
///
/// Eagerly reads every `required_key` and assembles every `required_tls_context`.
/// Returns an error if any key is missing or any TLS context cannot be assembled.
pub fn create_secret_store(opts: Options) -> Result<SecretStore, SecretError> {
    let root = PathBuf::from(
        opts.root
            .or_else(|| env::var("SECRETS_ROOT").ok())
            .unwrap_or_else(|| "/mnt/secrets".into()),
    );

    let on_error: Arc<OnErrorFn> = opts.on_error.unwrap_or_else(|| {
        Arc::new(|key, err| {
            eprintln!("[secrets-client] Error for {key:?}: {err}");
        })
    });

    // Eagerly load required keys.
    let mut cache = HashMap::new();
    for key in &opts.required_keys {
        let normalized = normalize_key(key)?;
        let data = fs::read(root.join(&normalized)).map_err(|e| {
            SecretError::Other(format!(
                "[secrets-client] required key {key:?} missing at {:?}: {e}",
                root.join(&normalized)
            ))
        })?;
        cache.insert(normalized, data);
    }

    // Eagerly assemble required TLS contexts.
    let mut tls_contexts = HashMap::new();
    for name in &opts.required_tls_contexts {
        validate_tls_name(name)?;
        let cert_dir = root.join("tls").join(name);
        let ctx = ReloadableTlsContext::new(cert_dir, opts.tls_coalesce_ms, Arc::clone(&on_error))
            .map_err(|e| {
                SecretError::Other(format!(
                    "[secrets-client] required TLS context {name:?} could not be assembled: {e}"
                ))
            })?;
        tls_contexts.insert(name.clone(), ctx);
    }

    // Use a Weak slot to wire the rename callback back to the store without
    // creating a reference cycle. The slot is populated immediately after the
    // Arc is created; any events that fire before it is populated are no-ops
    // (no secrets are rotating during init).
    let weak_slot: Arc<Mutex<Option<std::sync::Weak<SecretStoreInner>>>> =
        Arc::new(Mutex::new(None));

    let slot_for_debouncer = Arc::clone(&weak_slot);
    let debouncer = watcher::Debouncer::new(
        move |path: PathBuf| {
            if let Some(weak) = slot_for_debouncer.lock().unwrap().as_ref() {
                if let Some(inner) = weak.upgrade() {
                    let store = SecretStore { inner };
                    store.handle_rename(path);
                }
            }
        },
        opts.debounce_ms,
    );

    let slot_for_watcher = Arc::clone(&weak_slot);
    let on_rename: watcher::RenameCallback = Arc::new(move |path: PathBuf| {
        if let Some(weak) = slot_for_watcher.lock().unwrap().as_ref() {
            if let Some(inner) = weak.upgrade() {
                inner.debouncer.call(path);
            }
        }
    });

    let fs_watcher = watcher::DirectoryWatcher::new(root.clone(), on_rename)
        .map_err(|e| SecretError::Other(e.to_string()))?;

    let inner = Arc::new(SecretStoreInner {
        root,
        state: RwLock::new(StoreState {
            cache,
            subscribers: HashMap::new(),
            tls_contexts,
            consecutive_errors: HashMap::new(),
            next_sub_id: 0,
        }),
        on_error,
        _watcher: fs_watcher,
        debouncer,
    });

    // Populate the weak slot now that the Arc exists.
    *weak_slot.lock().unwrap() = Some(Arc::downgrade(&inner));

    Ok(SecretStore { inner })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Validates and returns a canonical forward-slash relative key.
/// Rejects absolute paths and ".." segments; collapses "." segments.
fn normalize_key(key: &str) -> Result<String, SecretError> {
    let slash = key.replace('\\', "/");
    if slash.starts_with('/') {
        return Err(SecretError::invalid_key(
            key,
            "must be relative to the secrets root",
        ));
    }
    if slash.split('/').any(|p| p == "..") {
        return Err(SecretError::invalid_key(
            key,
            "must not contain \"..\" segments",
        ));
    }
    // Canonicalize by filtering out "." components.
    let normalized: PathBuf = PathBuf::from(&slash)
        .components()
        .filter(|c| *c != std::path::Component::CurDir)
        .collect();

    let result = normalized.to_string_lossy().replace('\\', "/");
    if result.is_empty() || result == "." {
        return Err(SecretError::invalid_key(key, "empty or \".\" key"));
    }
    Ok(result)
}

fn validate_tls_name(name: &str) -> Result<(), SecretError> {
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err(SecretError::invalid_key(
            name,
            "TLS context name: only letters, digits, hyphens, and underscores allowed",
        ))
    }
}
