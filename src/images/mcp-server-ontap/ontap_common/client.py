"""Thin REST client for the NetApp ONTAP API.

Design notes:

- Either basic auth (username + password) OR mutual TLS (client cert + key) is
  used; the caller passes whatever fields are present in the credential dict
  and this client picks the right transport.
- Cert / key / CA bundle PEM strings are written to per-call temp files with
  0600 / 0444 perms. Files are unlinked in finally; nothing is cached across
  calls because the worker is multi-threaded.
- Pagination: ONTAP returns `_links.next.href` with a relative URL.
  ``get_paginated`` follows it until either the hard cap (default 1000) or
  the server stops returning ``_links.next``. The cap is exposed to callers
  via the ``truncated`` flag on the result.
- ``requests.exceptions.SSLError`` is mapped to ``OntapTLSVerifyError`` so
  the caller can produce a TLS_VERIFY_FAILED hint to the user. Other
  network failures map to ``OntapNetworkError`` / ``OntapTimeoutError``.

This module deliberately has no Temporal / activity dependencies and no
ExplorerNode dependencies; it is shared with the in-tree MCP server image.
"""
from __future__ import annotations

import contextlib
from observability_client_runtime import get_logger
import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple, Union
from urllib.parse import urljoin, urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .errors import (
    OntapAuthError,
    OntapHTTPError,
    OntapNetworkError,
    OntapTimeoutError,
    OntapTLSVerifyError,
)

logger = get_logger()

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_RECORDS = 1000
DEFAULT_PAGE_SIZE = 100
OntapRequestParams = Union[Mapping[str, Any], Sequence[Tuple[str, Any]]]


def _coerce_verify_tls_bool(value: Any, *, default: bool = True) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return False if value == 0 else True
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("false", "0", "no", "off"):
            return False
        if v in ("true", "1", "yes", "on"):
            return True
    return default


def verify_tls_from_connector_config(config: Mapping[str, Any]) -> bool:
    """Read TLS verify flag from REST/Temporal connector config maps.

    Supports ``verify_tls`` (canonical), ``verifyTls`` (camelCase), and legacy
    ``verify_ssl``. When all are absent, defaults to ``True`` (verify certificates).
    """
    raw = config.get("verify_tls")
    if raw is None:
        raw = config.get("verifyTls")
    if raw is None:
        raw = config.get("verify_ssl")
    return _coerce_verify_tls_bool(raw, default=True)


@dataclass
class PaginatedResult:
    records: List[Dict[str, Any]] = field(default_factory=list)
    truncated: bool = False
    total_records: Optional[int] = None


class OntapClient:
    """Stateless ONTAP REST client. Construct per call; do not share between threads."""

    def __init__(
        self,
        cluster_url: str,
        credential: Mapping[str, str],
        *,
        verify_tls: bool = True,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        if not cluster_url:
            raise ValueError("cluster_url is required")
        self.base_url = cluster_url.rstrip("/")
        self.credential = dict(credential)
        self.verify_tls = bool(verify_tls)
        self.timeout = float(timeout)
        # Passed explicitly on each request so env (REQUESTS_CA_BUNDLE / SSL_CERT_FILE)
        # cannot override verify=False when TLS verification is disabled.
        self._request_verify: Any = True
        # Temp files created in __enter__ get cleaned up in __exit__.
        self._exit_stack = contextlib.ExitStack()
        self._session: Optional[requests.Session] = None

    # ── Context-manager lifecycle ──────────────────────────────────────────

    def __enter__(self) -> "OntapClient":
        self._exit_stack.__enter__()
        self._session = self._build_session()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if self._session is not None:
                self._session.close()
        finally:
            self._session = None
            self._exit_stack.__exit__(exc_type, exc, tb)

    # ── Public API ─────────────────────────────────────────────────────────

    def get(self, path: str, params: Optional[OntapRequestParams] = None) -> Dict[str, Any]:
        """GET a single resource (no pagination). Returns the parsed JSON dict."""
        return self._request("GET", path, params=params)

    def get_paginated(
        self,
        path: str,
        params: Optional[OntapRequestParams] = None,
        *,
        max_records: int = DEFAULT_MAX_RECORDS,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> PaginatedResult:
        """GET a collection, following `_links.next.href` until ``max_records`` are
        accumulated or the server stops paginating.
        """
        if isinstance(params, Mapping):
            merged: OntapRequestParams = dict(params)
            merged.setdefault("max_records", page_size)  # type: ignore[union-attr]
        else:
            merged = list(params or [])
            if not any(key == "max_records" for key, _ in merged):
                merged.append(("max_records", page_size))

        records: List[Dict[str, Any]] = []
        truncated = False
        total: Optional[int] = None

        next_path: Optional[str] = path
        next_params: Optional[OntapRequestParams] = merged

        while next_path:
            resp = self._request("GET", next_path, params=next_params)
            page = resp.get("records", [])
            if total is None and "num_records" in resp:
                # ONTAP returns num_records per page, not always cluster-wide; treat as a hint only.
                total = int(resp.get("num_records", 0)) if isinstance(resp.get("num_records"), int) else None
            records.extend(page)

            if len(records) >= max_records:
                truncated = True
                records = records[:max_records]
                break

            next_link = (resp.get("_links") or {}).get("next") or {}
            next_href = next_link.get("href")
            if not next_href:
                break
            # ONTAP's _links.next.href is relative ("/api/storage/volumes?...").
            # Subsequent requests should not re-send `params` — the href encodes them.
            next_path = next_href
            next_params = None

        return PaginatedResult(records=records, truncated=truncated, total_records=total)

    # ── Internals ──────────────────────────────────────────────────────────

    def _build_session(self) -> requests.Session:
        session = requests.Session()

        # Retry only on idempotent 5xx; never on auth failures.
        retry = Retry(
            total=2,
            connect=2,
            read=1,
            backoff_factor=0.5,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset({"GET", "HEAD"}),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        session.mount("https://", adapter)
        session.mount("http://", adapter)

        creds = self.credential
        username = (creds.get("username") or "").strip()
        password = creds.get("password") or ""
        cert_pem = creds.get("client_cert_pem") or ""
        key_pem = creds.get("client_key_pem") or ""
        ca_pem = creds.get("ca_bundle_pem") or ""

        # mTLS takes precedence when both pairs are supplied (ONTAP often supports
        # cert auth with a higher trust score than basic).
        if cert_pem and key_pem:
            cert_path = self._write_temp_pem(cert_pem, mode=0o600, suffix=".crt")
            key_path = self._write_temp_pem(key_pem, mode=0o600, suffix=".key")
            session.cert = (cert_path, key_path)
        elif username and password:
            session.auth = (username, password)
        else:
            raise OntapAuthError(
                "ONTAP credential is missing both basic auth (username/password) "
                "and mutual TLS (client_cert_pem/client_key_pem)."
            )

        if not self.verify_tls:
            session.verify = False
            self._request_verify = False
            # Suppress the InsecureRequestWarning chatter when the user has
            # explicitly opted into verify_tls=false.
            try:
                requests.packages.urllib3.disable_warnings(  # type: ignore[attr-defined]
                    requests.packages.urllib3.exceptions.InsecureRequestWarning  # type: ignore[attr-defined]
                )
            except Exception:
                pass
        elif ca_pem:
            ca_path = self._write_temp_pem(ca_pem, mode=0o444, suffix=".pem")
            session.verify = ca_path
            self._request_verify = ca_path
        else:
            session.verify = True
            self._request_verify = True

        session.headers.update({"Accept": "application/json"})
        if os.environ.get("ONTAP_TRUST_ENV", "").strip().lower() in ("false", "0", "no", "off"):
            session.trust_env = False
        return session

    def _write_temp_pem(self, contents: str, *, mode: int, suffix: str) -> str:
        """Write a PEM block to a per-call tempfile with restricted perms.

        The file is registered with the client's ExitStack so it is unlinked
        when the client closes.
        """
        fd, path = tempfile.mkstemp(suffix=suffix, prefix="ontap-")
        try:
            with os.fdopen(fd, "w") as fp:
                fp.write(contents)
            os.chmod(path, mode)
        except Exception:
            with contextlib.suppress(OSError):
                os.unlink(path)
            raise

        @self._exit_stack.callback
        def _cleanup() -> None:
            with contextlib.suppress(OSError):
                os.unlink(path)

        return path

    def _build_url(self, path_or_href: str) -> str:
        """Resolve either a relative API path ('/api/cluster') or a path returned
        by ONTAP in `_links.next.href`. Absolute URLs pass through.
        """
        parsed = urlparse(path_or_href)
        if parsed.scheme and parsed.netloc:
            return path_or_href
        if path_or_href.startswith("/"):
            return f"{self.base_url}{path_or_href}"
        return urljoin(self.base_url + "/", path_or_href)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[OntapRequestParams] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if self._session is None:
            # Allow ad-hoc use without an explicit context manager — build a
            # one-shot session.
            with self as bound:
                return bound._request(method, path, params=params, json_body=json_body)

        url = self._build_url(path)
        started = time.monotonic()
        try:
            resp = self._session.request(
                method,
                url,
                params=params,
                json=json_body,
                timeout=self.timeout,
                verify=self._request_verify,
            )
        except requests.exceptions.SSLError as e:
            raise OntapTLSVerifyError() from e
        except requests.exceptions.ConnectTimeout as e:
            raise OntapTimeoutError(f"Connect timeout to {url}") from e
        except requests.exceptions.ReadTimeout as e:
            raise OntapTimeoutError(f"Read timeout from {url}") from e
        except requests.exceptions.ConnectionError as e:
            raise OntapNetworkError(f"Network error contacting {url}: {e}") from e
        except requests.RequestException as e:
            raise OntapNetworkError(f"Request to {url} failed: {e}") from e

        elapsed_ms = int((time.monotonic() - started) * 1000)
        logger.debug("ONTAP %s %s -> %s in %dms", method, url, resp.status_code, elapsed_ms)

        if resp.status_code in (401, 403):
            raise OntapAuthError(
                f"ONTAP rejected credentials ({resp.status_code}) for {url}",
                status=resp.status_code,
            )
        if resp.status_code >= 400:
            body_excerpt = (resp.text or "")[:500]
            raise OntapHTTPError(
                f"ONTAP returned {resp.status_code} for {url}: {body_excerpt}",
                status=resp.status_code,
            )

        if not resp.content:
            return {}
        try:
            return resp.json()
        except ValueError as e:
            raise OntapHTTPError(f"ONTAP response from {url} was not valid JSON: {e}") from e


def split_host_port(cluster_url: str) -> Tuple[str, int]:
    """Parse host and port from an ONTAP cluster URL. Defaults to 443 for https."""
    parsed = urlparse(cluster_url)
    host = parsed.hostname or ""
    if parsed.port:
        port = int(parsed.port)
    else:
        port = 80 if parsed.scheme == "http" else 443
    return host, port
