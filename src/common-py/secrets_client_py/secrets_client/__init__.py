"""
secrets_client — Python parity library for the Secrets Store CSI Driver integration.

Reads secrets from CSI-mounted files under /mnt/secrets/<group>/<key> and
provides live rotation via inotify-backed file watching.

API surface is intentionally parallel to the TypeScript secrets-client library:

    store = create_secret_store(
        required_keys=["db/url", "keycloak/client-secret"],
        required_tls_contexts=["server"],
    )

    url = store.get_str("db/url")
    store.watch("db/url", lambda next_url: reconfigure_pool(next_url))

    tls_ctx = store.get_tls_context("server")
    tls_ctx.on_rotate(lambda: logger.info("TLS rotated"))
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Optional, Sequence

from ._tls import ReloadableSSLContext
from ._watcher import Debouncer, DirectoryWatcher

__all__ = [
    "SecretStore",
    "ReloadableSSLContext",
    "create_secret_store",
]

_DEFAULT_ROOT = "/mnt/secrets"
_DEFAULT_DEBOUNCE_MS = 250
_DEFAULT_TLS_COALESCE_MS = 500
_CONSECUTIVE_ERROR_THRESHOLD = 5

_TLS_FILE_RE = re.compile(r"^tls/([^/]+)/(cert|chain|key)\.pem$")


class SecretStore:
    """
    Long-lived secret store for the life of the process.

    All reads are O(1) from an in-memory cache. The cache is kept fresh by a
    file watcher that reacts to inotify rename events (IN_MOVED_TO).
    """

    def __init__(
        self,
        root: Path,
        debounce_ms: int,
        tls_coalesce_ms: int,
        on_error: Callable[[str, Exception], None],
    ) -> None:
        self._root = root
        self._tls_coalesce_ms = tls_coalesce_ms
        self._on_error = on_error
        self._cache: dict[str, bytes] = {}
        self._subscribers: dict[str, list[Callable[[str], None]]] = {}
        self._tls_contexts: dict[str, ReloadableSSLContext] = {}
        self._consecutive_errors: dict[str, int] = {}
        self._lock = threading.Lock()

        self._debouncer = Debouncer(self._handle_rename, debounce_ms)
        self._watcher = DirectoryWatcher(root, self._debouncer)

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    def get_str(self, key: str) -> str:
        return self._read_cache(self._normalize_key(key)).decode("utf-8")

    def get_bytes(self, key: str) -> bytes:
        return self._read_cache(self._normalize_key(key))

    def get_json(self, key: str) -> Any:
        return json.loads(self.get_str(key))

    def watch(
        self, key: str, cb: Callable[[str], None]
    ) -> Callable[[], None]:
        normalized = self._normalize_key(key)
        if normalized not in self._cache:
            raise KeyError(
                f"[secrets-client] Cannot watch key '{key}': "
                "it was not declared in required_keys."
            )
        with self._lock:
            self._subscribers.setdefault(normalized, []).append(cb)

        def _unsub() -> None:
            with self._lock:
                subs = self._subscribers.get(normalized, [])
                try:
                    subs.remove(cb)
                except ValueError:
                    pass

        return _unsub

    def get_tls_context(self, name: str) -> ReloadableSSLContext:
        ctx = self._tls_contexts.get(name)
        if ctx is None:
            raise KeyError(
                f"[secrets-client] TLS context '{name}' was not declared in required_tls_contexts"
            )
        return ctx

    def close(self) -> None:
        self._watcher.close()
        self._debouncer.cancel()
        for ctx in self._tls_contexts.values():
            ctx.close()
        with self._lock:
            self._subscribers.clear()
            self._tls_contexts.clear()

    # -------------------------------------------------------------------------
    # Init helpers (called from create_secret_store)
    # -------------------------------------------------------------------------

    @staticmethod
    def _normalize_key(key: str) -> str:
        """Validates and returns a canonical POSIX-relative key.

        Converts backslashes to forward slashes and collapses any ``.`` path
        segments (e.g. ``./db/url`` → ``db/url``, ``db/./url`` → ``db/url``)
        so cache keys always match the watcher-emitted paths and align with
        the TypeScript client's normalization behaviour.  Raises if the key
        is absolute or contains ``..`` segments.
        """
        normalized = key.replace("\\", "/")
        p = PurePosixPath(normalized)
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(
                f"[secrets-client] Invalid required key '{key}': "
                "keys must be relative to the secrets root and must not contain '..' segments."
            )
        normalized_str = str(p)
        if not normalized_str or normalized_str == '.':
            raise ValueError(
                f"[secrets-client] Invalid required key '{key}': "
                "key must not be empty or resolve to the secrets root."
            )
        return normalized_str

    @staticmethod
    def _validate_tls_name(name: str) -> None:
        """Rejects TLS context names that contain path separators or '..' segments."""
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError(
                f"[secrets-client] Invalid TLS context name '{name}': "
                "only letters, digits, hyphens, and underscores are allowed."
            )

    def _load_required(self, key: str) -> None:
        """Eagerly loads a required key into the cache. Raises if missing."""
        normalized = self._normalize_key(key)
        file_path = self._root / normalized
        self._cache[normalized] = file_path.read_bytes()

    def _load_tls_context(self, name: str) -> None:
        """Eagerly assembles a TLS context. Raises if any PEM file is missing."""
        self._validate_tls_name(name)
        cert_dir = self._root / "tls" / name
        ctx = ReloadableSSLContext(cert_dir, self._tls_coalesce_ms, self._on_error)
        self._tls_contexts[name] = ctx

    # -------------------------------------------------------------------------
    # Internal
    # -------------------------------------------------------------------------

    def _read_cache(self, key: str) -> bytes:
        cached = self._cache.get(key)
        if cached is None:
            raise KeyError(
                f"[secrets-client] Key '{key}' is not in the cache. "
                "Declare it in required_keys."
            )
        return cached

    def _handle_rename(self, file_path: Path) -> None:
        relative = str(file_path.relative_to(self._root)).replace("\\", "/")

        # The CSI Secrets Store driver rotates content atomically by renaming
        # the `..data` symlink to point at a new timestamped directory. The
        # individual file paths (e.g. `db/url`) are symlinks through `..data`,
        # so their content changes without generating a rename event of their
        # own. Treat any `..data` rename as a signal that every cached key and
        # every TLS context may have been updated.
        #
        # Match both the root-level case ("..data") and paths ending with
        # "/..data" (e.g. "db/..data") depending on how the volume is laid out
        # and which directory the watcher reports the event from.
        if relative == "..data" or relative.endswith("/..data"):
            for key in list(self._cache.keys()):
                self._reload_key(key)
            for ctx in self._tls_contexts.values():
                ctx.schedule_reload()
            return

        tls_match = _TLS_FILE_RE.match(relative)
        if tls_match:
            name = tls_match.group(1)
            ctx = self._tls_contexts.get(name)
            if ctx:
                ctx.schedule_reload()
            return

        key = relative
        if key not in self._cache:
            return

        self._reload_key(key)

    def _reload_key(self, key: str) -> None:
        file_path = self._root / key
        try:
            data = file_path.read_bytes()
            with self._lock:
                prev = self._cache.get(key)
                # Skip notification if content is byte-for-byte identical.
                if prev is not None and prev == data:
                    return
                self._cache[key] = data
                self._consecutive_errors[key] = 0
                subs = list(self._subscribers.get(key, []))

            value = data.decode("utf-8")
            for cb in subs:
                try:
                    cb(value)
                except Exception as err:
                    self._on_error(key, err)

        except Exception as err:
            with self._lock:
                count = self._consecutive_errors.get(key, 0) + 1
                self._consecutive_errors[key] = count
                threshold_err: Exception | None = (
                    RuntimeError(
                        f"[secrets-client] {count} consecutive rotation read errors "
                        f"for key '{key}'; last error: {err}"
                    )
                    if count >= _CONSECUTIVE_ERROR_THRESHOLD
                    else None
                )
            self._on_error(key, threshold_err if threshold_err is not None else err)


def create_secret_store(
    *,
    root: Optional[str] = None,
    debounce_ms: int = _DEFAULT_DEBOUNCE_MS,
    tls_coalesce_ms: int = _DEFAULT_TLS_COALESCE_MS,
    required_keys: Sequence[str],
    required_tls_contexts: Sequence[str] = (),
    on_error: Optional[Callable[[str, Exception], None]] = None,
) -> SecretStore:
    """
    Creates and initialises a long-lived SecretStore.

    Eagerly reads every `required_key` and assembles every `required_tls_context`.
    Raises if any key is missing or any TLS context cannot be assembled — the
    application should abort on init rather than run with missing secrets (L-5).
    """
    resolved_root = Path(root or os.environ.get("SECRETS_ROOT", _DEFAULT_ROOT))
    resolved_on_error = on_error or (
        lambda key, err: __import__("logging")
        .getLogger("secrets_client")
        .error("Secret store error for '%s': %s", key, err)
    )

    store = SecretStore(resolved_root, debounce_ms, tls_coalesce_ms, resolved_on_error)

    for key in required_keys:
        try:
            store._load_required(key)
        except Exception as err:
            store.close()
            raise RuntimeError(
                f"[secrets-client] Required key '{key}' is missing "
                f"at '{resolved_root}/{key}': {err}"
            ) from err

    for name in required_tls_contexts:
        try:
            store._load_tls_context(name)
        except Exception as err:
            store.close()
            raise RuntimeError(
                f"[secrets-client] Required TLS context '{name}' could not be assembled: {err}"
            ) from err

    return store
