"""
File-system watcher for the secrets-client library.

Uses `watchdog` with the InotifyObserver explicitly — Linux / inotify only.
Fires a callback when a file is moved into place (IN_MOVED_TO), which is the
exact event the CSI driver emits after its atomic rename.

Plain writes (IN_MODIFY / on_modified) are intentionally ignored: the driver
never writes in-place, so a modify event on the secrets mount is either a
staging write to a temp file (irrelevant) or a spurious duplicate (harmless).

DirectoryWatcher places a non-recursive inotify watch on the root directory
and on every real (non-symlink) subdirectory, recursing into new ones as they
appear. Directories whose names start with ".." (e.g. CSI driver versioned
data dirs such as "..data_v2") are deliberately skipped — they accumulate on
long-lived clusters and adding an inotify watch for each would exhaust the
per-process inotify handle limit. The `..data` symlink-swap rotation is
detected at the root level instead.

The watcher runs on a dedicated daemon thread managed by watchdog.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers.inotify import InotifyObserver

RenameCallback = Callable[[Path], None]


class _RenameHandler(FileSystemEventHandler):
    """
    Forwards IN_MOVED_TO events to the appropriate callback.

    File renames go to `on_file`; directory renames that do NOT start with
    ".." go to `on_dir` so DirectoryWatcher can lazily add watches for newly
    appearing subdirectories.
    """

    def __init__(
        self,
        on_file: RenameCallback,
        on_dir: Callable[[Path], None],
    ) -> None:
        super().__init__()
        self._on_file = on_file
        self._on_dir = on_dir

    def on_moved(self, event: FileSystemEvent) -> None:
        dest = Path(str(event.dest_path))
        if event.is_directory:
            # Skip CSI versioned data directories (..data_v2, ..2026_01_01_…).
            if not dest.name.startswith('..'):
                self._on_dir(dest)
        else:
            self._on_file(dest)


class DirectoryWatcher:
    """
    Watches `root_dir` for IN_MOVED_TO events (inotify) and invokes
    `on_rename` with the absolute destination path of the renamed file.

    Places a non-recursive InotifyObserver watch on the root directory and on
    every real (non-symlink) subdirectory, mirroring the TypeScript
    DirectoryWatcher implementation. Directories starting with ".." are never
    watched — see module docstring for rationale.

    Uses InotifyObserver directly — Linux only, no polling fallback.
    """

    def __init__(self, root_dir: Path, on_rename: RenameCallback) -> None:
        self._on_rename = on_rename
        self._observer: InotifyObserver = InotifyObserver()
        self._observer.daemon = True
        self._watched: set[str] = set()
        self._lock = threading.Lock()

        self._watch_dir(root_dir)
        self._observer.start()

    def _watch_dir(self, dir_path: Path) -> None:
        """Add a non-recursive watch for dir_path, then recurse into existing
        real non-'..' subdirectories."""
        key = str(dir_path)
        with self._lock:
            if key in self._watched:
                return
            self._watched.add(key)

        handler = _RenameHandler(self._on_rename, self._on_new_dir)
        self._observer.schedule(handler, key, recursive=False)

        try:
            for entry in dir_path.iterdir():
                if entry.name.startswith('..'):
                    continue
                try:
                    if entry.is_dir() and not entry.is_symlink():
                        self._watch_dir(entry)
                except OSError:
                    pass
        except OSError:
            pass

    def _on_new_dir(self, dir_path: Path) -> None:
        """Lazily watch a directory that was renamed into a watched location."""
        try:
            if dir_path.is_dir() and not dir_path.is_symlink():
                self._watch_dir(dir_path)
        except OSError:
            pass

    def close(self) -> None:
        self._observer.stop()
        self._observer.join(timeout=5)


class Debouncer:
    """
    Collapses rapid calls within `delay_ms` into a single invocation, calling
    the handler once for every *unique* path seen during the window.

    Matches the TypeScript `debounce` helper: accumulating unique paths ensures
    that all rotated files receive a reload call regardless of the order in
    which rename events arrive (e.g. driver writing cert/chain/key in quick
    succession will trigger three separate _handle_rename calls after the
    window, not just the last one).
    """

    def __init__(self, fn: Callable[[Path], None], delay_ms: int) -> None:
        self._fn = fn
        self._delay = delay_ms / 1000.0
        self._timer: threading.Timer | None = None
        self._lock = threading.Lock()
        self._pending: set[Path] = set()

    def __call__(self, file_path: Path) -> None:
        with self._lock:
            self._pending.add(file_path)
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._delay, self._flush)
            self._timer.daemon = True
            self._timer.start()

    def _flush(self) -> None:
        with self._lock:
            paths = list(self._pending)
            self._pending.clear()
            self._timer = None
        for p in paths:
            self._fn(p)

    def cancel(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._pending.clear()
