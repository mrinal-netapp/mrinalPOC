"""
pytest configuration for the secrets-client Python library.

On non-Linux platforms (macOS, Windows) watchdog's InotifyObserver is
unavailable and raises UnsupportedLibcError on import, which prevents the
test suite from even collecting.  This conftest shims the inotify module with
a stub that delegates to the platform-native watchdog Observer (kqueue /
FSEvents on macOS, ReadDirectoryChangesW on Windows) so tests can run locally
without changing production code.

On Linux the real InotifyObserver is imported as normal.
"""
from __future__ import annotations

import sys


def _install_inotify_shim() -> None:
    try:
        import watchdog.observers.inotify  # noqa: F401 — just probe; may raise
    except Exception:
        from types import ModuleType
        from unittest.mock import MagicMock

        from watchdog.observers import Observer as _NativeObserver

        stub = MagicMock(spec=ModuleType("watchdog.observers.inotify"))
        stub.InotifyObserver = _NativeObserver
        sys.modules["watchdog.observers.inotify"] = stub


_install_inotify_shim()
