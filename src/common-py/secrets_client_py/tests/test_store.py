"""
Python acceptance test suite for the secrets-client library.

Covers core scenarios from the TypeScript test suite but does not claim
one-to-one parity in test IDs: T-L9 here tests the CSI ..data symlink-swap
pattern (no direct TS equivalent), and TLS-specific tests (TS T-L9/T-L10)
and the high-frequency rotation test (TS T-L11) are not duplicated here.
Tests use real tmpfs-backed temp directories and actual atomic renames so the
watcher exercises real inotify/FSEvents code paths.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from secrets_client import SecretStore, create_secret_store


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_file(path: Path, content: str) -> None:
    """Creates all parent directories and writes a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def atomic_write(path: Path, content: str) -> None:
    """Writes `content` to `path` via an atomic rename (tmp → target)."""
    tmp = path.parent / f".tmp-{time.time_ns()}"
    tmp.write_text(content, encoding="utf-8")
    tmp.rename(path)


def sleep(ms: int) -> None:
    time.sleep(ms / 1000.0)


def wait_for(
    condition: Callable[[], bool],
    *,
    timeout_ms: int = 5000,
    poll_ms: int = 20,
    msg: str = "Timed out waiting for condition",
) -> None:
    """
    Polls `condition` every `poll_ms` ms until it returns True or `timeout_ms`
    elapses.  Prefer this over a fixed sleep for positive-assertion tests so
    that assertions pass as soon as the event fires rather than after a worst-
    case delay.  Mirrors the TypeScript ``waitFor`` helper.
    """
    deadline = time.monotonic() + timeout_ms / 1000.0
    while not condition():
        if time.monotonic() >= deadline:
            raise TimeoutError(msg)
        time.sleep(poll_ms / 1000.0)


# ---------------------------------------------------------------------------
# T-L1: Happy-path init
# ---------------------------------------------------------------------------

def test_tl1_happy_path_init(tmp_path: Path) -> None:
    write_file(tmp_path / "db" / "url", "postgresql://host/db")
    store = create_secret_store(root=str(tmp_path), required_keys=["db/url"])
    assert store is not None
    store.close()


# ---------------------------------------------------------------------------
# T-L2: Fail-fast on missing key
# ---------------------------------------------------------------------------

def test_tl2_fail_fast_missing_key(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="db/url"):
        create_secret_store(root=str(tmp_path), required_keys=["db/url"])


# ---------------------------------------------------------------------------
# T-L3: get_str after init returns file content
# ---------------------------------------------------------------------------

def test_tl3_get_str_returns_file_content(tmp_path: Path) -> None:
    write_file(tmp_path / "db" / "url", "postgresql://host/db")
    store = create_secret_store(root=str(tmp_path), required_keys=["db/url"])
    try:
        assert store.get_str("db/url") == "postgresql://host/db"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L4: Atomic rename triggers watch callback exactly once with new value
# ---------------------------------------------------------------------------

def test_tl4_atomic_rename_triggers_watch(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=50
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    try:
        atomic_write(file_path, "v2")
        wait_for(lambda: len(received) >= 1, msg="T-L4: watch callback never fired")
        assert received == ["v2"]
        assert store.get_str("db/url") == "v2"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L5: Two renames within debounce window collapse to one callback
# ---------------------------------------------------------------------------

def test_tl5_debounce_collapses_rapid_renames(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    debounce_ms = 300
    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=debounce_ms
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    try:
        atomic_write(file_path, "v2")
        atomic_write(file_path, "v3")
        wait_for(lambda: len(received) >= 1, msg="T-L5: debounced callback never fired")
        # Wait a full debounce window (plus a small buffer) so any spurious
        # second callback has time to arrive before we assert exactly one.
        sleep(debounce_ms + 100)
        assert len(received) == 1
        assert received[0] == "v3"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L6: Two renames separated by > debounce window invoke callback twice
# ---------------------------------------------------------------------------

def test_tl6_two_renames_outside_debounce_window(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    debounce_ms = 100
    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=debounce_ms
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    try:
        atomic_write(file_path, "v2")
        wait_for(lambda: "v2" in received, msg="T-L6: first callback (v2) never fired")

        atomic_write(file_path, "v3")
        wait_for(lambda: "v3" in received, msg="T-L6: second callback (v3) never fired")

        assert received == ["v2", "v3"]
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L7: Plain write to a temp file does NOT invoke callback
# ---------------------------------------------------------------------------

def test_tl7_plain_write_does_not_invoke_callback(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=50
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    try:
        # Write a staging file that is NOT the tracked key.
        staging = tmp_path / "db" / ".tmp-staging"
        staging.write_text("v2", encoding="utf-8")
        sleep(300)
        assert received == []
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L8: Unreadable file mid-rotation keeps last-known-good; on_error called
# ---------------------------------------------------------------------------

def test_tl8_unreadable_file_keeps_last_known_good(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    errors: list[tuple[str, Exception]] = []

    store = create_secret_store(
        root=str(tmp_path),
        required_keys=["db/url"],
        debounce_ms=50,
        on_error=lambda k, e: errors.append((k, e)),
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    try:
        # Simulate a mid-rotation read failure: rename an unreadable (chmod 0)
        # decoy onto the target path. The watchdog on_moved event fires, but
        # _reload_key's read_bytes() raises PermissionError — last-known-good
        # must be preserved and on_error must be called without invoking any
        # watch subscribers.
        file_path.unlink()
        decoy = tmp_path / "db" / ".decoy"
        decoy.write_text("", encoding="utf-8")
        decoy.chmod(0o000)
        decoy.rename(file_path)

        wait_for(lambda: len(errors) > 0, msg="T-L8: on_error never called for unreadable file")

        assert received == []
        assert store.get_str("db/url") == "v1"
        assert errors[0][0] == "db/url"
    finally:
        # Restore permissions so pytest tmp_path cleanup can delete the file.
        try:
            file_path.chmod(0o644)
        except Exception:
            pass
        store.close()


# ---------------------------------------------------------------------------
# T-L9: ..data symlink rename (CSI driver pattern) reloads all cached keys
# ---------------------------------------------------------------------------

def test_tl9_dotdata_rename_reloads_all_keys(tmp_path: Path) -> None:
    """
    Simulates the exact rotation mechanism used by the CSI Secrets Store driver:
    secret files are symlinks that resolve through a `..data` symlink pointing
    to the current timestamped data directory.  On rotation the driver atomically
    renames `..data` to a new target; the individual secret paths (still pointing
    through `..data`) therefore reflect new content without generating rename
    events of their own.

    Layout:
        tmp/
          ..data -> ..data_v1/          (symlink, will be swapped to ..data_v2/)
          ..data_v1/
            db/url                      (real file, v1)
          ..data_v2/
            db/url                      (real file, v2)
          db/url -> ..data/db/url       (symlink read by the store)
    """
    # Build v1 data dir and symlink tree.
    v1_dir = tmp_path / "..data_v1"
    (v1_dir / "db").mkdir(parents=True)
    (v1_dir / "db" / "url").write_text("v1", encoding="utf-8")

    data_link = tmp_path / "..data"
    data_link.symlink_to(v1_dir)

    (tmp_path / "db").mkdir(parents=True)
    (tmp_path / "db" / "url").symlink_to(Path("../..data/db/url"))

    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=50
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    assert store.get_str("db/url") == "v1"

    try:
        # Build v2 data dir and atomically swap the ..data symlink (CSI pattern).
        v2_dir = tmp_path / "..data_v2"
        (v2_dir / "db").mkdir(parents=True)
        (v2_dir / "db" / "url").write_text("v2", encoding="utf-8")

        # Atomic symlink swap: create a new symlink in a tmp name then rename it.
        tmp_link = tmp_path / "..data_tmp"
        tmp_link.symlink_to(v2_dir)
        tmp_link.rename(data_link)  # IN_MOVED_TO for ..data

        wait_for(
            lambda: "v2" in received,
            msg=f"T-L9: ..data rotation not reflected; received={received}",
        )

        assert received == ["v2"]
        assert store.get_str("db/url") == "v2"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L12: SECRETS_ROOT env var works identically against a local directory
# ---------------------------------------------------------------------------

def test_tl12_secrets_root_env_var(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write_file(tmp_path / "llm" / "api-key", "sk-test-key")
    monkeypatch.setenv("SECRETS_ROOT", str(tmp_path))

    store = create_secret_store(required_keys=["llm/api-key"])
    try:
        assert store.get_str("llm/api-key") == "sk-test-key"
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L13: unsubscribe permanently removes the callback
# ---------------------------------------------------------------------------

def test_tl13_unsubscribe_removes_callback(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=50
    )
    received: list[str] = []
    unsubscribe = store.watch("db/url", received.append)
    unsubscribe()

    try:
        atomic_write(file_path, "v2")
        sleep(300)
        assert received == []
    finally:
        store.close()


# ---------------------------------------------------------------------------
# T-L14: close() stops the watcher; callbacks stop firing
# ---------------------------------------------------------------------------

def test_tl14_close_stops_watcher(tmp_path: Path) -> None:
    file_path = tmp_path / "db" / "url"
    write_file(file_path, "v1")

    store = create_secret_store(
        root=str(tmp_path), required_keys=["db/url"], debounce_ms=50
    )
    received: list[str] = []
    store.watch("db/url", received.append)

    store.close()

    atomic_write(file_path, "v2")
    sleep(300)

    assert received == []
