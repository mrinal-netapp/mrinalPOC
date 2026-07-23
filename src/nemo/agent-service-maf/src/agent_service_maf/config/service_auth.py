"""Keycloak client-credentials helper for MAF.

Port of ``agent-service/src/service_auth.py`` (same logic, MAF logger
conventions). The cached token is shared process-wide so every outbound
config-service request reuses a single bearer until it expires.

Key invariants:

- A single :class:`asyncio.Lock` guards the cache so two concurrent cache
  misses do not stampede the Keycloak token endpoint.
- The token is considered expired ``REFRESH_LEEWAY_SECONDS`` *before* its
  actual ``exp`` (default 60 s) so an in-flight request never carries a
  bearer that will reject mid-call.
- All errors surface as :class:`ConfigurationError` so the caller can wrap
  them in the same unhealthy-bundle path used elsewhere in MAF.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import structlog

from agent_service_maf.core.exceptions import ConfigurationError

logger = structlog.get_logger(__name__)


class ServiceAccountClient:
    """Async Keycloak client-credentials client with in-memory token cache.

    Usage:
        >>> auth = ServiceAccountClient(
        ...     issuer="https://kc.example.com/realms/internal",
        ...     client_id="maf",
        ...     client_secret="...",
        ... )
        >>> headers = await auth.auth_headers()
        >>> resp = await httpx.AsyncClient().get(url, headers=headers)

    Args:
        issuer: The full realm issuer URL — e.g.
            ``https://keycloak/realms/internal``. The ``/protocol/openid-connect/token``
            suffix is appended automatically.
        client_id: Service-account client id registered in Keycloak.
        client_secret: Service-account client secret. Never logged.
        timeout: Per-request HTTP timeout for the token endpoint.
        refresh_leeway_seconds: Safety window applied before the real
            ``expires_in``. The cached token is treated as expired this many
            seconds early so callers never get a bearer that will reject in
            flight.
    """

    def __init__(
        self,
        *,
        issuer: str,
        client_id: str,
        client_secret: str,
        timeout: float = 10.0,
        refresh_leeway_seconds: int = 60,
    ) -> None:
        self._issuer = issuer.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._timeout = timeout
        self._refresh_leeway = max(0, refresh_leeway_seconds)
        self._token: str | None = None
        # Deadline on the ``time.monotonic()`` clock at which the cached
        # token is considered expired. NOT seconds-since-epoch — the
        # monotonic clock has an arbitrary reference point but is
        # guaranteed not to jump backwards on NTP adjustment, which is
        # what we want for an expiry window. ``0.0`` means "no cached
        # token" (acceptable sentinel because the monotonic clock starts
        # well above zero on any real process).
        self._expires_at: float = 0.0
        self._lock = asyncio.Lock()

    @property
    def token_endpoint(self) -> str:
        """The fully-qualified Keycloak token URL.

        Public attribute so tests can assert against it without poking at
        protected state. Computed once from the issuer.
        """
        return f"{self._issuer}/protocol/openid-connect/token"

    async def auth_headers(self) -> dict[str, str]:
        """Return ``{"Authorization": "Bearer <token>"}``.

        Acquires a fresh token if the cache is empty or the cached token is
        within ``refresh_leeway_seconds`` of expiry. Uses an asyncio lock so
        concurrent callers do not stampede the Keycloak endpoint.

        Returns:
            A new dict suitable for direct splat into ``httpx`` calls.

        Raises:
            ConfigurationError: When the token endpoint is unreachable,
                returns a non-2xx status, or the response body is missing
                ``access_token`` / ``expires_in``.
        """
        now = time.monotonic()
        # Fast path: cached + not within the leeway window.
        if self._token is not None and now < self._expires_at:
            return {"Authorization": f"Bearer {self._token}"}

        async with self._lock:
            # Re-check inside the lock — another coroutine may have
            # refreshed while we were waiting.
            now = time.monotonic()
            if self._token is not None and now < self._expires_at:
                return {"Authorization": f"Bearer {self._token}"}
            await self._refresh()
            # Refresh either set the token or raised; if we reach here the
            # token attribute is non-None.
            assert self._token is not None  # noqa: S101  (narrowing for type checker)
            return {"Authorization": f"Bearer {self._token}"}

    async def _refresh(self) -> None:
        """Fetch a fresh access token from Keycloak.

        Must be called under ``self._lock``. Writes ``self._token`` and
        ``self._expires_at`` on success; raises on failure.
        """
        data = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(
                    self.token_endpoint,
                    data=data,
                    headers={"Accept": "application/json"},
                )
        except httpx.HTTPError as exc:
            logger.error(
                "service_auth_token_request_failed",
                endpoint=self.token_endpoint,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise ConfigurationError(
                f"Failed to reach Keycloak token endpoint: {exc}",
                details={"endpoint": self.token_endpoint},
            ) from exc

        if resp.status_code >= 400:
            # Body might contain ``error_description``; surface it but keep
            # the secret out of logs.
            try:
                body: dict[str, Any] = resp.json()
            except ValueError:
                body = {}
            logger.error(
                "service_auth_token_rejected",
                endpoint=self.token_endpoint,
                status=resp.status_code,
                kc_error=body.get("error"),
                kc_error_description=body.get("error_description"),
            )
            raise ConfigurationError(
                f"Keycloak rejected client_credentials grant "
                f"(status={resp.status_code}, error={body.get('error')!r}).",
                details={
                    "status": resp.status_code,
                    "kc_error": body.get("error"),
                },
            )

        try:
            payload: dict[str, Any] = resp.json()
        except ValueError as exc:
            raise ConfigurationError(
                f"Keycloak returned non-JSON token response: {exc}",
                details={"endpoint": self.token_endpoint},
            ) from exc

        token = payload.get("access_token")
        expires_in = payload.get("expires_in")
        if not isinstance(token, str) or not token:
            raise ConfigurationError(
                "Keycloak response missing 'access_token'.",
                details={"keys": sorted(payload.keys())},
            )
        if not isinstance(expires_in, (int, float)) or expires_in <= 0:
            raise ConfigurationError(
                "Keycloak response missing 'expires_in' (or non-positive).",
                details={"expires_in": expires_in},
            )

        self._token = token
        # ``time.monotonic`` is used here so the absolute clock cannot skew
        # the safety window (e.g. NTP corrections). ``_refresh_leeway`` is
        # subtracted up front so the comparison in ``auth_headers`` is a
        # single ``<``.
        self._expires_at = time.monotonic() + float(expires_in) - float(self._refresh_leeway)
        logger.info(
            "service_auth_token_refreshed",
            endpoint=self.token_endpoint,
            expires_in_seconds=int(expires_in),
            refresh_leeway_seconds=self._refresh_leeway,
        )

    def invalidate(self) -> None:
        """Drop the cached token. Next ``auth_headers()`` will refresh.

        Useful for tests that need to assert the refresh path runs, and
        as an operator-driven recovery hook if Keycloak revokes the
        client.
        """
        self._token = None
        self._expires_at = 0.0


__all__ = ["ServiceAccountClient"]
