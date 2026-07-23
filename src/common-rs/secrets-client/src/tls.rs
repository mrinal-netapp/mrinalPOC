//! Hot-swapping TLS context for the Rust secrets-client library.
//!
//! Reads three PEM files — cert.pem, chain.pem, key.pem — from a directory
//! and builds a `rustls::ServerConfig`. A rotation event on any of the three
//! files schedules a coalesced reload (within `coalesce_ms`) so that three
//! rapid renames produce exactly one context swap.
//!
//! The swap is a single `arc_swap::ArcSwap` store — readers calling
//! `current()` always see a consistent, fully-assembled `ServerConfig`.

use std::{
    collections::HashMap,
    fs,
    io::BufReader,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex, Weak},
    thread,
    time::Duration,
};

use arc_swap::ArcSwap;
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer},
    ServerConfig,
};
use rustls_pemfile::{certs, private_key};

use crate::SecretError;

/// Builds a `rustls::ServerConfig` from the three PEM files in `cert_dir`.
///
/// - `cert.pem`  — leaf server certificate (required).
/// - `key.pem`   — private key matching cert.pem (required).
/// - `chain.pem` — intermediate CA certificates appended to cert.pem.
///   Optional; ENOENT is silently ignored.
pub(crate) fn build_server_config(
    cert_dir: &std::path::Path,
) -> Result<Arc<ServerConfig>, SecretError> {
    // Ensure the ring crypto provider is installed. This call is idempotent;
    // if another call already installed it, the Err is silently ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cert_pem =
        fs::read(cert_dir.join("cert.pem")).map_err(|e| SecretError::io("cert.pem", e))?;
    let key_pem = fs::read(cert_dir.join("key.pem")).map_err(|e| SecretError::io("key.pem", e))?;

    let mut combined_cert_pem = cert_pem;
    let chain_path = cert_dir.join("chain.pem");
    match fs::read(&chain_path) {
        Ok(chain) if !chain.is_empty() => {
            combined_cert_pem.push(b'\n');
            combined_cert_pem.extend_from_slice(&chain);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(SecretError::io("chain.pem", e)),
        _ => {}
    }

    let cert_list: Vec<CertificateDer<'static>> = {
        let mut reader = BufReader::new(combined_cert_pem.as_slice());
        certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| SecretError::Other(format!("parsing cert.pem: {e}")))?
    };

    let key: PrivateKeyDer<'static> = {
        let mut reader = BufReader::new(key_pem.as_slice());
        private_key(&mut reader)
            .map_err(|e| SecretError::Other(format!("parsing key.pem: {e}")))?
            .ok_or_else(|| SecretError::Other("no private key found in key.pem".into()))?
    };

    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_list, key)
        .map_err(|e| SecretError::Other(format!("building ServerConfig: {e}")))?;

    Ok(Arc::new(config))
}

/// Hot-swapping TLS context backed by three PEM files in a directory.
pub struct ReloadableTlsContext {
    cert_dir: PathBuf,
    on_error: Arc<crate::OnErrorFn>,
    current: ArcSwap<ServerConfig>,
    // Store subscribers as Arc<dyn Fn()> so we can clone them out of the map
    // before calling, avoiding holding the lock during callback invocation.
    subs: Mutex<HashMap<u64, Arc<dyn Fn() + Send + Sync + 'static>>>,
    next_id: Mutex<u64>,
    // Sending on this channel requests a coalesced reload.
    reload_tx: mpsc::Sender<()>,
}

impl ReloadableTlsContext {
    pub(crate) fn new(
        cert_dir: PathBuf,
        coalesce_ms: u64,
        on_error: Arc<crate::OnErrorFn>,
    ) -> Result<Arc<Self>, SecretError> {
        let config = build_server_config(&cert_dir)?;
        let (reload_tx, reload_rx) = mpsc::channel::<()>();
        let coalesce = Duration::from_millis(coalesce_ms);

        // Use a Weak slot to give the worker a back-reference without creating
        // an Arc cycle. The slot is populated immediately after Arc::new; no
        // schedule_reload() can fire before new() returns.
        let weak_slot: Arc<Mutex<Option<Weak<ReloadableTlsContext>>>> = Arc::new(Mutex::new(None));
        let weak_slot_for_worker = Arc::clone(&weak_slot);

        thread::spawn(move || {
            loop {
                // Block until at least one reload is requested.
                if reload_rx.recv().is_err() {
                    break;
                }
                // Drain additional rapid requests within the coalesce window.
                loop {
                    match reload_rx.recv_timeout(coalesce) {
                        Ok(()) => continue,
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        // Channel closed during coalesce — skip reload and exit.
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if let Some(weak) = weak_slot_for_worker.lock().unwrap().as_ref() {
                    if let Some(ctx) = weak.upgrade() {
                        ctx.reload();
                    }
                }
            }
        });

        let ctx = Arc::new(Self {
            cert_dir,
            on_error,
            current: ArcSwap::from(config),
            subs: Mutex::new(HashMap::new()),
            next_id: Mutex::new(0),
            reload_tx,
        });

        // Populate the slot now that the Arc exists.
        *weak_slot.lock().unwrap() = Some(Arc::downgrade(&ctx));

        Ok(ctx)
    }

    /// Returns the current `ServerConfig`; always reflects the latest rotation.
    pub fn current(&self) -> Arc<ServerConfig> {
        self.current.load_full()
    }

    /// Registers a callback invoked after each successful context swap.
    /// Returns an unsubscribe function.
    pub fn on_rotate(self: &Arc<Self>, cb: impl Fn() + Send + Sync + 'static) -> impl Fn() {
        let cb: Arc<dyn Fn() + Send + Sync + 'static> = Arc::new(cb);
        let mut id_guard = self.next_id.lock().unwrap();
        let id = *id_guard;
        *id_guard += 1;
        drop(id_guard);
        self.subs.lock().unwrap().insert(id, cb);

        let weak = Arc::downgrade(self);
        move || {
            if let Some(ctx) = weak.upgrade() {
                ctx.subs.lock().unwrap().remove(&id);
            }
        }
    }

    /// Schedules a coalesced TLS reload. Rapid calls within `coalesce_ms`
    /// collapse to a single rebuild.
    pub(crate) fn schedule_reload(&self) {
        let _ = self.reload_tx.send(());
    }

    fn reload(&self) {
        match build_server_config(&self.cert_dir) {
            Ok(next) => {
                self.current.store(next);
                // Snapshot Arc-cloned subscribers before calling to avoid
                // holding the lock during callback invocation.
                let cbs: Vec<Arc<dyn Fn() + Send + Sync>> =
                    self.subs.lock().unwrap().values().cloned().collect();

                let name = self
                    .cert_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                for cb in cbs {
                    if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb()))
                    {
                        (self.on_error)(
                            &format!("tls:{name}:on_rotate"),
                            &SecretError::Other(format!("subscriber panic: {e:?}"))
                                as &dyn std::error::Error,
                        );
                    }
                }
            }
            Err(e) => {
                let name = self
                    .cert_dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                (self.on_error)(&format!("tls:{name}"), &e as &dyn std::error::Error);
                // current retains last-known-good
            }
        }
    }
}
