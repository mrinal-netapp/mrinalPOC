"""
Hot-swapping TLS context for the Python secrets-client library.

Reads three PEM files — cert.pem, chain.pem, key.pem — from a directory and
builds an ssl.SSLContext. A rotation event on any of the three files schedules
a coalesced reload (within coalesce_ms) so that three rapid renames produce
exactly one context swap.

File semantics:
  cert.pem  — leaf server certificate (required).
  key.pem   — private key matching cert.pem (required).
  chain.pem — intermediate CA certificates to append to cert.pem so peers can
              verify the full chain up to a trusted root. Optional; omit or
              leave empty when the leaf cert is directly signed by a root CA or
              when intermediates are already concatenated into cert.pem.

The swap is a single reference assignment under a threading.Lock, ensuring
callers of `context()` always see a consistent, fully-assembled SSLContext.
"""

from __future__ import annotations

import os
import ssl
import tempfile
import threading
from pathlib import Path
from typing import Callable


def _build_ssl_context(cert_dir: Path) -> ssl.SSLContext:
    cert_path = cert_dir / "cert.pem"
    chain_path = cert_dir / "chain.pem"
    key_path = cert_dir / "key.pem"

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)

    chain_bytes = b""
    if chain_path.exists() and chain_path.stat().st_size > 0:
        chain_bytes = chain_path.read_bytes()

    if chain_bytes:
        # ssl.SSLContext.load_cert_chain requires a file path, not bytes, so
        # concatenate the leaf cert + intermediates into a temporary file.
        combined = cert_path.read_bytes() + b"\n" + chain_bytes
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".pem")
        try:
            with os.fdopen(tmp_fd, "wb") as tmp_file:
                tmp_file.write(combined)
            ctx.load_cert_chain(certfile=tmp_path, keyfile=str(key_path))
        finally:
            os.unlink(tmp_path)
    else:
        ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))

    return ctx


class ReloadableSSLContext:
    """
    Wraps an ssl.SSLContext that is atomically hot-swapped on TLS rotation.

    Parity with the TypeScript `TlsContext` interface.
    """

    def __init__(
        self,
        cert_dir: Path,
        coalesce_ms: int,
        on_error: Callable[[str, Exception], None],
    ) -> None:
        self._cert_dir = cert_dir
        self._coalesce_ms = coalesce_ms
        self._on_error = on_error
        self._lock = threading.Lock()
        self._current: ssl.SSLContext = _build_ssl_context(cert_dir)
        self._subscribers: list[Callable[[], None]] = []
        self._timer: threading.Timer | None = None

    def context(self) -> ssl.SSLContext:
        """Returns the current SSLContext; always reflects the latest rotation."""
        with self._lock:
            return self._current

    def on_rotate(self, cb: Callable[[], None]) -> Callable[[], None]:
        """Subscribe to rotation. Returns an unsubscribe callable."""
        with self._lock:
            self._subscribers.append(cb)

        def _unsub() -> None:
            with self._lock:
                try:
                    self._subscribers.remove(cb)
                except ValueError:
                    pass

        return _unsub

    def schedule_reload(self) -> None:
        """Signal that one of the three TLS files may have changed."""
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
            delay = self._coalesce_ms / 1000.0
            self._timer = threading.Timer(delay, self._reload)
            self._timer.daemon = True
            self._timer.start()

    def _reload(self) -> None:
        try:
            new_ctx = _build_ssl_context(self._cert_dir)
            with self._lock:
                self._current = new_ctx
                subs = list(self._subscribers)
            for cb in subs:
                try:
                    cb()
                except Exception as err:
                    self._on_error(f"tls:{self._cert_dir.name}:on_rotate", err)
        except Exception as err:
            self._on_error(f"tls:{self._cert_dir.name}", err)

    def close(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._subscribers.clear()
