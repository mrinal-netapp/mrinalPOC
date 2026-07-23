//! File-system watcher for the secrets-client library.
//!
//! Uses the `notify` crate which maps to inotify on Linux and kqueue on macOS.
//! Fires a callback when a file is moved into place (IN_MOVED_TO equivalent),
//! which is the exact event the CSI Secrets Store driver emits after its
//! atomic rename.
//!
//! `DirectoryWatcher` places a non-recursive watch on the root directory and
//! every real (non-symlink) subdirectory. Directories whose names start with
//! ".." (CSI versioned data directories such as "..data_v2") are deliberately
//! skipped to avoid inotify handle exhaustion on long-lived clusters.
//!
//! `Debouncer` collapses rapid calls within `delay_ms` into a single
//! invocation per unique path, matching the TypeScript and Python debounce
//! helpers.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};

use notify::{
    event::{EventKind, ModifyKind, RenameMode},
    Config, Event, RecommendedWatcher, RecursiveMode, Watcher,
};

pub type RenameCallback = Arc<dyn Fn(PathBuf) + Send + Sync + 'static>;

// Internal command sent to the DirectoryWatcher worker thread.
enum Cmd {
    Watch(PathBuf),
    Shutdown,
}

/// Watches `root` for rename/create events using a non-recursive inotify watch
/// on the root and every real (non-symlink, non-`..`-prefixed) subdirectory.
/// Mirrors the Go/TypeScript/Python `DirectoryWatcher` implementations.
///
/// When a new real subdirectory appears, the watcher automatically adds it to
/// the watch set. CSI versioned-data directories (`..data_v2`, etc.) are
/// deliberately skipped to avoid inotify fd exhaustion.
///
/// The underlying `RecommendedWatcher` is owned by a background worker thread.
/// Dropping `DirectoryWatcher` sends a `Shutdown` command; the worker exits
/// and drops the watcher cleanly.
pub struct DirectoryWatcher {
    cmd_tx: mpsc::Sender<Cmd>,
}

impl DirectoryWatcher {
    pub fn new(root: PathBuf, on_rename: RenameCallback) -> Result<Self, notify::Error> {
        let (cmd_tx, cmd_rx) = mpsc::channel::<Cmd>();
        let cmd_tx_for_handler = cmd_tx.clone();
        let on_rename_clone = Arc::clone(&on_rename);

        // Build the watcher and register initial watches synchronously so
        // callers can start writing files immediately after new() returns.
        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    Self::handle_event(&event, &on_rename_clone, &cmd_tx_for_handler);
                }
            },
            Config::default(),
        )?;

        // Initial non-recursive walk happens HERE (calling thread) to guarantee
        // watches are active before new() returns, avoiding a race with callers
        // that immediately rename files after construction.
        walk_and_watch(&mut watcher, &root);

        thread::spawn(move || {
            let mut w = watcher;
            while let Ok(Cmd::Watch(dir)) = cmd_rx.recv() {
                walk_and_watch(&mut w, &dir);
            }
            // `w` drops here, closing all inotify handles.
        });

        Ok(Self { cmd_tx })
    }

    fn handle_event(event: &Event, on_rename: &RenameCallback, cmd_tx: &mpsc::Sender<Cmd>) {
        let is_relevant = matches!(
            event.kind,
            EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(ModifyKind::Name(
                    RenameMode::To | RenameMode::Both | RenameMode::Any
                ))
        );
        if !is_relevant {
            return;
        }
        for path in &event.paths {
            // For Create/Rename: if a real non-".." subdirectory appeared, queue it.
            // Remove events skip this check (the dir no longer exists).
            if !matches!(event.kind, EventKind::Remove(_)) {
                let base = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !base.starts_with("..") {
                    if let Ok(meta) = fs::symlink_metadata(path) {
                        if meta.is_dir() && !meta.file_type().is_symlink() {
                            let _ = cmd_tx.send(Cmd::Watch(path.clone()));
                        }
                    }
                }
            }
            on_rename(path.clone());
        }
    }
}

impl Drop for DirectoryWatcher {
    fn drop(&mut self) {
        // Signal the worker to exit. The worker drops the watcher on exit,
        // releasing all inotify handles.
        let _ = self.cmd_tx.send(Cmd::Shutdown);
    }
}

/// Adds a non-recursive watch on `dir` and recurses into real (non-symlink,
/// non-`..`-prefixed) subdirectories. Errors (e.g. dir already watched or
/// no longer exists) are silently ignored to keep the watcher idempotent.
fn walk_and_watch(watcher: &mut RecommendedWatcher, dir: &Path) {
    let _ = watcher.watch(dir, RecursiveMode::NonRecursive);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("..") {
            continue;
        }
        if let Ok(meta) = fs::symlink_metadata(entry.path()) {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                walk_and_watch(watcher, &entry.path());
            }
        }
    }
}

/// Collapses rapid calls within `delay_ms` into a single invocation for each
/// unique path seen during the quiet window. A single background thread is
/// used — no per-call thread spawning.
///
/// The background thread blocks until a path arrives, then accumulates paths
/// until `delay_ms` of silence, then flushes. This matches the
/// TypeScript/Python debounce helpers.
pub struct Debouncer {
    tx: std::sync::Mutex<Option<mpsc::Sender<PathBuf>>>,
    cancelled: Arc<AtomicBool>,
}

impl Debouncer {
    pub fn new(fn_ptr: impl Fn(PathBuf) + Send + Sync + 'static, delay_ms: u64) -> Self {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let delay = Duration::from_millis(delay_ms);

        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_worker = Arc::clone(&cancelled);

        thread::spawn(move || {
            let mut pending = HashSet::<PathBuf>::new();
            loop {
                // Block until at least one path arrives.
                match rx.recv() {
                    Err(_) => break,
                    Ok(path) => {
                        pending.insert(path);
                    }
                }
                // Drain additional paths arriving within the debounce window.
                loop {
                    match rx.recv_timeout(delay) {
                        Ok(path) => {
                            pending.insert(path);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            // Only flush pending paths if the debouncer was not
                            // cancelled — cancel() is intended to discard pending
                            // work (matching the TS cancel() semantics).
                            if !cancelled_worker.load(Ordering::Acquire) {
                                for p in pending.drain() {
                                    fn_ptr(p);
                                }
                            }
                            return;
                        }
                    }
                }
                for p in pending.drain() {
                    fn_ptr(p);
                }
            }
        });

        Self {
            tx: std::sync::Mutex::new(Some(tx)),
            cancelled,
        }
    }

    pub fn call(&self, path: PathBuf) {
        if let Some(tx) = self.tx.lock().unwrap().as_ref() {
            let _ = tx.send(path);
        }
    }

    /// Discards any pending paths and stops the worker thread.
    /// Matches the TypeScript `cancel()` semantics: pending work is dropped,
    /// not flushed.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        *self.tx.lock().unwrap() = None;
    }
}
