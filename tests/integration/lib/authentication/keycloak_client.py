"""Keycloak ``client_credentials`` token client for agent-service / config-service.

Separate from the KB/platform password-grant flow in ``lib.common.auth``. This
client fetches a service-account bearer token from Keycloak using the
``client_credentials`` grant and caches it in-memory until shortly before
expiry (handles short-lived tokens, e.g. 5 minutes).

Enabled per service via the ``ENABLE_AUTH_AGENT_SERVICE`` /
``ENABLE_AUTH_CONFIG_SERVICE`` env flags; credentials come from
``KEYCLOAK_INTERNAL_ISSUER`` / ``KEYCLOAK_SERVICE_CLIENT_ID`` /
``KEYCLOAK_SERVICE_CLIENT_SECRET`` (legacy ``KEYCLOAK_CLIENT_ID`` /
``KEYCLOAK_CLIENT_SECRET`` still honored as a fallback).
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

_REFRESH_LEEWAY_SEC = 60


def _strip(value: str | None) -> str:
    if not value:
        return ""
    return value.strip().strip('"').strip("'")


def auth_enabled(flag_name: str) -> bool:
    """True when the env flag is set to a truthy value (1/true/yes/on)."""
    val = _strip(os.environ.get(flag_name)).lower()
    if not val:
        return False
    return val in ("1", "true", "yes", "on")


class KeycloakClient:
    """Caches a ``client_credentials`` bearer token, refreshing before expiry."""

    def __init__(
        self,
        issuer: str,
        client_id: str,
        client_secret: str,
        *,
        verify_tls: bool = True,
    ) -> None:
        self._issuer = issuer.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._expires_at: float = 0.0
        self._http = httpx.Client(
            verify=verify_tls, timeout=httpx.Timeout(30.0, connect=15.0), trust_env=False
        )

    @property
    def token_endpoint(self) -> str:
        return f"{self._issuer}/protocol/openid-connect/token"

    def close(self) -> None:
        self._http.close()

    def _is_expiring_soon(self) -> bool:
        return time.time() >= (self._expires_at - _REFRESH_LEEWAY_SEC)

    def get_access_token(self) -> str:
        """Return a valid access token, fetching/refreshing as needed."""
        if self._token is None or self._is_expiring_soon():
            self._fetch_token()
        assert self._token is not None
        return self._token

    def bearer_header(self) -> dict[str, str]:
        """Return ``{"Authorization": "Bearer <token>"}``."""
        return {"Authorization": f"Bearer {self.get_access_token()}"}

    def _fetch_token(self) -> None:
        # client_credentials grant; body is application/x-www-form-urlencoded.
        resp = self._http.post(
            self.token_endpoint,
            data={
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
            headers={"Accept": "application/json"},
        )
        try:
            payload: dict[str, Any] = resp.json() if resp.text else {}
        except ValueError:
            payload = {}
        # Keycloak returns 400/401 with {"error", "error_description"} on failure.
        if resp.status_code != 200:
            error = payload.get("error", "unknown_error")
            description = payload.get("error_description", resp.text)
            raise RuntimeError(
                f"Keycloak token request failed (HTTP {resp.status_code}): "
                f"{error} — {description}"
            )

        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError(
                f"Keycloak token response missing 'access_token' "
                f"(keys={sorted(payload.keys())})"
            )

        expires_in = payload.get("expires_in", 300)
        try:
            expires_in = float(expires_in)
        except (TypeError, ValueError):
            expires_in = 300.0
        self._token = token
        self._expires_at = time.time() + expires_in


def load_keycloak_client(*, verify_tls: bool = True) -> KeycloakClient:
    """Build a ``KeycloakClient`` from env vars.

    Reads ``KEYCLOAK_INTERNAL_ISSUER`` and the service-account client
    credentials ``KEYCLOAK_SERVICE_CLIENT_ID`` / ``KEYCLOAK_SERVICE_CLIENT_SECRET``
    (falling back to the legacy ``KEYCLOAK_CLIENT_ID`` / ``KEYCLOAK_CLIENT_SECRET``
    so existing ``.env.local`` files keep working). Raises a clear error when any
    is missing (only called when a service's auth flag is enabled).
    """
    issuer = _strip(os.environ.get("KEYCLOAK_INTERNAL_ISSUER"))
    client_id = _strip(os.environ.get("KEYCLOAK_SERVICE_CLIENT_ID")) or _strip(
        os.environ.get("KEYCLOAK_CLIENT_ID")
    )
    client_secret = _strip(os.environ.get("KEYCLOAK_SERVICE_CLIENT_SECRET")) or _strip(
        os.environ.get("KEYCLOAK_CLIENT_SECRET")
    )

    missing = [
        name
        for name, value in (
            ("KEYCLOAK_INTERNAL_ISSUER", issuer),
            ("KEYCLOAK_SERVICE_CLIENT_ID", client_id),
            ("KEYCLOAK_SERVICE_CLIENT_SECRET", client_secret),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Keycloak auth enabled but missing env vars: "
            f"{', '.join(missing)}. Set them in tests/integration/.env.local."
        )

    return KeycloakClient(
        issuer=issuer,
        client_id=client_id,
        client_secret=client_secret,
        verify_tls=verify_tls,
    )
