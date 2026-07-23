"""Authentication for the agent framework HTTP + WebSocket interface.

Provides a pluggable authentication system with:

- :class:`AuthMiddleware`: Abstract base class for authentication schemes.
  Implementations accept both ``starlette.requests.Request`` (HTTP) and
  ``starlette.websockets.WebSocket`` (WS handshake) — they only need to
  read ``.headers``, which both types expose identically.
- :class:`APIKeyAuthMiddleware`: Built-in API key validator using the
  ``X-API-Key`` header (configurable).
- :class:`AgentAuthMiddleware`: Starlette ``BaseHTTPMiddleware`` that
  gates **HTTP requests** under ``/api/v1/projects``. **Important: this
  middleware does NOT see WebSocket connections** — Starlette's
  ``BaseHTTPMiddleware`` only runs in the HTTP request/response cycle.
- :func:`build_auth_middleware`: Factory that creates the appropriate
  provider from config.

**Coverage split** — both must be wired for full protection:

- **HTTP** (REST + SSE under ``/api/v1/projects/...``): authenticated by
  :class:`AgentAuthMiddleware` via the ASGI middleware chain in
  :func:`agent_service_maf.interface_layer.api.create_app`.
- **WebSocket** (``.../agent-teams/{team_id}/ws`` and
  ``.../agents/{agent_id}/ws``): authenticated by
  ``_authenticate_websocket`` in
  :mod:`agent_service_maf.interface_layer.routes`, which runs the same
  provider (stashed on ``app.state.auth_provider``) against the WS
  handshake headers **before** ``websocket.accept()`` is called. On
  failure the socket is closed with WS application-close code 4401
  (mirrors HTTP 401, and pairs with the existing 4029 / HTTP-429
  per-IP-limit close used in ``ws_handler``).

The ``GET /health`` endpoint and FastAPI doc routes (``/docs``,
``/openapi.json``, ``/redoc``) are always exempt to support Kubernetes
liveness/readiness probes.

Configuration (``interface.auth`` section):

.. code-block:: yaml

    interface:
      auth:
        enabled: false            # Primary switch (disabled for local dev)
        scheme: api_key           # api_key | oauth2 | mtls
        api_key_header: X-API-Key
        api_keys: []              # Prefer env var: AGENT_INTERFACE__AUTH__API_KEYS

When ``auth.enabled`` is ``False``, the :class:`NoopAuthMiddleware` is used
which accepts all requests and returns empty claims. This applies to both
HTTP and WebSocket paths.

Security note: API keys MUST come from the ``AGENT_INTERFACE__AUTH__API_KEYS``
environment variable, not from the JSON config file. Storing secrets in config
files violates the secrets management standard (engineering-standards.md §1.3).
"""

from __future__ import annotations

import hashlib
import hmac
import uuid
from abc import ABC, abstractmethod
from typing import Any

import structlog
from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from agent_service_maf.core.identity import IdentityContext

logger = structlog.get_logger(__name__)

# Paths that are always exempt from authentication.
# ``/health`` is the liveness probe; ``/ready`` is the §5.8 readiness
# probe -- both are called by infrastructure probes that don't carry
# user credentials.
_AUTH_EXEMPT_PATHS: frozenset[str] = frozenset(
    {
        "/health",
        "/ready",
        "/docs",
        "/openapi.json",
        "/redoc",
    }
)

# Paths that require authentication when auth is enabled. All resource
# routes live under one of these prefixes; ``/health``, ``/ready``, and
# FastAPI doc routes are unaffected. ``str.startswith`` accepts a tuple
# so we keep the dispatch a single, fast call.
#
# - ``/api/v1/projects`` — every project-scoped resource (agents, teams,
#   tasks, websockets).
# - ``/api/v1/admin``   — the operator/admin surface, currently the
#   full path ``/api/v1/admin/config/invalidate`` (the router decorator
#   is ``/admin/config/invalidate`` but ``api_router`` is mounted under
#   ``/api/v1``). Without this prefix the middleware would treat the
#   route as unprotected — letting any caller wipe the config-service
#   cache.
# - ``/admin``          — the un-prefixed admin mount on
#   ``system_router``, currently the full path ``/admin/config/status``.
#   Returns operational cache metrics (hit rate, sizes, TTL) which are
#   reconnaissance-useful and must not be reachable without auth.
_AUTH_REQUIRED_PREFIX: tuple[str, ...] = (
    "/api/v1/projects",
    "/api/v1/admin",
    "/admin",
)


class AuthMiddleware(ABC):
    """Abstract base class for pluggable authentication providers.

    Implement this to add custom authentication schemes (OAuth2, mTLS, JWT, etc.)
    without modifying the framework core.

    The ``authenticate()`` method returns a claims dict on success or raises an
    ``HTTPException`` with status 401 on failure. The claims dict is stored in
    ``request.state.claims`` (for HTTP requests) by :class:`AgentAuthMiddleware`,
    and reachable on ``websocket.state.claims`` (for WS handshakes) by the
    ``_authenticate_websocket`` helper in
    :mod:`agent_service_maf.interface_layer.routes`.

    Both ``starlette.requests.Request`` and ``starlette.websockets.WebSocket``
    expose ``.headers`` and ``.url`` — implementations should only rely on
    those attributes so they work for both connection types.

    Example:
        >>> class JWTAuthMiddleware(AuthMiddleware):
        ...     async def authenticate(self, conn: Request | WebSocket) -> dict[str, Any]:
        ...         token = conn.headers.get("Authorization", "").removeprefix("Bearer ")
        ...         if not token:
        ...             from fastapi import HTTPException
        ...             raise HTTPException(status_code=401, detail="Missing Authorization header")
        ...         return decode_jwt(token)  # Returns claims dict
    """

    @abstractmethod
    async def authenticate(self, request: Request | WebSocket) -> dict[str, Any]:
        """Authenticate an incoming connection and return claims.

        Args:
            request: The incoming HTTP request (``starlette.requests.Request``)
                or WebSocket handshake (``starlette.websockets.WebSocket``).
                Both expose the same ``.headers`` and ``.url`` surface, so a
                provider can ignore the concrete type and just read headers.

        Returns:
            Claims dict with at minimum ``{"authenticated": True}``. May include
            additional claims like ``principal``, ``roles``, ``scopes``, etc.
            Stored on ``request.state.claims`` (HTTP) or
            ``websocket.state.claims`` (WS) by the caller.

        Raises:
            fastapi.HTTPException: With status 401 if credentials are missing or
                invalid. The response is formatted as JSON for HTTP requests by
                :class:`AgentAuthMiddleware`; for WebSocket handshakes the
                routes-layer helper closes the socket with code 4401 and uses
                the exception ``detail`` as the close reason (truncated to
                Starlette's reason-length cap).

        Example:
            >>> claims = await auth.authenticate(request)
            >>> print(claims.get("principal"))
        """
        ...


class NoopAuthMiddleware(AuthMiddleware):
    """No-operation authentication middleware.

    Used when ``interface.auth.enabled`` is ``False`` (the default for local
    development). Accepts all requests and returns empty claims.

    This middleware should NEVER be used in production environments.
    Set ``interface.auth.enabled: true`` and configure a real scheme.

    Example:
        >>> noop = NoopAuthMiddleware()
        >>> claims = await noop.authenticate(request)
        >>> claims
        {}
    """

    async def authenticate(self, request: Request | WebSocket) -> dict[str, Any]:
        """Accept all requests / handshakes and return empty claims.

        Args:
            request: The incoming HTTP request or WebSocket handshake (not
                inspected).

        Returns:
            Empty dict — no claims available when auth is disabled.
        """
        return {}


class APIKeyAuthMiddleware(AuthMiddleware):
    """API key authentication via the ``X-API-Key`` request header.

    Validates the key using a constant-time comparison to prevent timing attacks.
    Keys are stored as a set of their SHA-256 hashes, not as plaintext, to minimize
    the impact of memory dumps or log leakage.

    Configuration:

    .. code-block:: yaml

        interface:
          auth:
            scheme: api_key
            api_key_header: X-API-Key   # Header name
            api_keys: []                # Prefer AGENT_INTERFACE__AUTH__API_KEYS env var

    Args:
        valid_keys: List of valid API key strings. Use the
            ``AGENT_INTERFACE__AUTH__API_KEYS`` environment variable, not config files.
        header_name: Header name to read the API key from. Defaults to ``"X-API-Key"``.

    Raises:
        ValueError: If ``valid_keys`` is empty.

    Example:
        >>> import os
        >>> keys = os.environ.get("AGENT_INTERFACE__AUTH__API_KEYS", "").split(",")
        >>> auth = APIKeyAuthMiddleware(valid_keys=keys)
    """

    def __init__(
        self,
        valid_keys: list[str],
        header_name: str = "X-API-Key",
    ) -> None:
        if not valid_keys:
            raise ValueError(
                "valid_keys must contain at least one API key. "
                "Set the AGENT_INTERFACE__AUTH__API_KEYS environment variable "
                "with a comma-separated list of valid keys. "
                "Do not store API keys in config files."
            )
        self._header_name = header_name
        # Store hashes to avoid keeping plaintext keys in memory.
        self._key_hashes: frozenset[bytes] = frozenset(
            hashlib.sha256(k.encode()).digest() for k in valid_keys if k
        )

    async def authenticate(self, request: Request | WebSocket) -> dict[str, Any]:
        """Validate the ``X-API-Key`` header (or configured header name).

        Uses constant-time comparison against stored SHA-256 hashes to prevent
        timing attacks. Works for both HTTP requests and WebSocket
        handshakes — both expose ``.headers`` as a mapping with the same
        ``get`` semantics.

        Args:
            request: The incoming HTTP request or WebSocket handshake. Reads
                the configured header name from ``request.headers``.

        Returns:
            Claims dict ``{"authenticated": True, "scheme": "api_key"}`` on success.

        Raises:
            fastapi.HTTPException: With status 401 if the header is missing or the
                key does not match any stored valid key. For HTTP this becomes a
                JSON 401; for WebSocket the routes-layer helper translates it
                into a close with code 4401.

        Example:
            >>> # Client sends: X-API-Key: my-secret-key
            >>> claims = await auth.authenticate(request)
            >>> claims["authenticated"]
            True
        """
        from fastapi import HTTPException

        provided_key = request.headers.get(self._header_name, "")
        if not provided_key:
            logger.warning(
                "Authentication failed: missing API key header",
                header=self._header_name,
                path=str(request.url.path),
            )
            raise HTTPException(
                status_code=401,
                detail=(
                    f"Missing '{self._header_name}' header. "
                    "Provide a valid API key in this header to access protected endpoints."
                ),
            )

        provided_hash = hashlib.sha256(provided_key.encode()).digest()

        # Constant-time check against all stored hashes.
        authenticated = any(
            hmac.compare_digest(provided_hash, stored_hash) for stored_hash in self._key_hashes
        )

        if not authenticated:
            logger.warning(
                "Authentication failed: invalid API key",
                header=self._header_name,
                path=str(request.url.path),
            )
            raise HTTPException(
                status_code=401,
                detail=(
                    f"Invalid API key in '{self._header_name}' header. "
                    "Check AGENT_INTERFACE__AUTH__API_KEYS environment variable "
                    "for the list of valid keys."
                ),
            )

        logger.debug("Authentication succeeded", scheme="api_key", path=str(request.url.path))
        return {"authenticated": True, "scheme": "api_key"}


# ---------------------------------------------------------------------------
# §B1 — Gateway-injected identity authentication
# ---------------------------------------------------------------------------


# Headers carried by every gateway-authenticated request. ``X-User-ID`` is
# required (fail-closed); the rest are optional. ``X-User-Token`` is the
# canonical name we'd prefer the gateway to use, but legacy clients send
# the user JWT on ``Authorization: Bearer <jwt>``. We accept either and
# converge them on :attr:`IdentityContext.user_token`.
_HDR_USER_ID = "x-user-id"
_HDR_PROJECT_ID = "x-project-id"
_HDR_USER_EMAIL = "x-user-email"
_HDR_USER_NAME = "x-user-name"
_HDR_USER_TOKEN_EXPLICIT = "x-user-token"
_HDR_AUTHORIZATION = "authorization"
_HDR_CORRELATION_ID = "x-correlation-id"


class GatewayIdentityAuthMiddleware(AuthMiddleware):
    """§B1 — Trust gateway-injected identity headers and build an
    :class:`~agent_service_maf.core.identity.IdentityContext`.

    **Trust model (read carefully before deploying)**: this scheme
    treats inbound headers (``X-User-ID``, ``X-Project-ID``, etc.) as
    *already authenticated by the API gateway in front of MAF*. It does
    NOT validate the user JWT here -- doing so would duplicate the
    gateway's responsibility. The agent-service-maf pod MUST therefore
    be unreachable from outside the cluster except through the gateway;
    a Kubernetes NetworkPolicy + ingress configuration that pins the
    only allowed caller to the gateway is required. Without that
    network isolation, **anyone able to reach the pod can spoof the
    headers and impersonate any user**. This is the standard
    service-mesh pattern and is the §7 #4 verification item in the
    plan.

    **Header contract (§3 of the plan)**:

    * ``X-User-ID`` -- required. Missing → 401.
    * ``X-Project-ID`` -- optional at this layer; the
      :func:`validate_project_access` helper later in the request
      lifecycle enforces "URL ``project_id`` must match the header
      when the header is present" and fills the field from the URL
      when the header was empty.
    * ``X-User-Email`` / ``X-User-Name`` -- optional, attribution only.
    * ``X-User-Token`` -- the user JWT (preferred). When absent we
      fall back to ``Authorization: Bearer <jwt>`` for clients still
      on the legacy shape, and stash the extracted JWT on
      :attr:`IdentityContext.user_token`.
    * The inbound ``Authorization`` header is consumed at this layer
      and **not copied into ``request.state.claims``** (the §B1 "no
      accidental header-copy" guarantee + the §I12 test). Downstream
      code MUST read the user token through
      :func:`get_current_identity` /
      :attr:`AgentExecutionContext.identity`, not via
      ``request.headers``. Note: Starlette middleware cannot mutate
      the request object, so the inbound header is still technically
      present on ``request.headers`` for any code that reaches for it
      directly. Treat raw header reads / logs as a code-review
      regression (the lint guard in §G3 flags new occurrences).

    Returns a claims dict containing:

    * ``"_identity"``: the typed :class:`IdentityContext` (Pydantic).
      This is the canonical handle downstream code reads.
    * ``"sub"``: a copy of ``user_id`` so the existing
      :func:`agent_service_maf.interface_layer.routes._resolve_user_id`
      helper (which already reads ``claims["sub"]``) picks up the
      gateway-supplied id with zero code change.
    * ``"authenticated": True`` and ``"scheme": "gateway_identity"``
      for parity with the other middlewares' shape.

    Failure modes:

    * ``401 Missing X-User-ID header`` -- the only required-header
      check at this layer. Project access enforcement is centralized
      in the route via :func:`validate_project_access`.
    """

    async def authenticate(self, request: Request | WebSocket) -> dict[str, Any]:
        """Extract identity headers and return the claims dict.

        Args:
            request: HTTP request or WebSocket handshake -- both expose
                ``.headers`` identically.

        Returns:
            Claims dict with ``_identity`` (the typed IdentityContext),
            ``sub`` (the user id, for legacy claim consumers), plus
            ``authenticated`` / ``scheme`` markers.

        Raises:
            HTTPException(401): if ``X-User-ID`` is missing or empty.
        """
        headers = request.headers
        user_id = (headers.get(_HDR_USER_ID) or "").strip()
        if not user_id:
            logger.warning(
                "gateway_identity_missing_user_id",
                path=str(getattr(request, "url", "")),
            )
            raise HTTPException(
                status_code=401,
                detail=(
                    f"Missing or empty '{_HDR_USER_ID}' header. "
                    "Requests must originate from an authenticated gateway that "
                    "injects gateway identity headers."
                ),
            )

        # ``X-Project-ID`` is optional at this stage; the per-route
        # :func:`validate_project_access` helper takes the URL path as
        # the source of truth and either matches the header or fills
        # the field. Pass it through verbatim (without stripping
        # whitespace surrounding non-empty values, since project ids
        # are opaque tokens).
        project_id = (headers.get(_HDR_PROJECT_ID) or "").strip()

        user_email = (headers.get(_HDR_USER_EMAIL) or "").strip() or None
        user_name = (headers.get(_HDR_USER_NAME) or "").strip() or None

        # Pull the user JWT. Prefer the explicit ``X-User-Token``; fall
        # back to ``Authorization: Bearer <jwt>`` for legacy clients.
        # Either way the value lands on the typed accessor and is
        # erased from header-visibility via claims.
        user_token = (headers.get(_HDR_USER_TOKEN_EXPLICIT) or "").strip() or None
        if user_token is None:
            authorization = headers.get(_HDR_AUTHORIZATION, "")
            if authorization.lower().startswith("bearer "):
                user_token = authorization[len("bearer ") :].strip() or None

        correlation_id = (headers.get(_HDR_CORRELATION_ID) or "").strip()
        if not correlation_id:
            correlation_id = str(uuid.uuid4())

        identity = IdentityContext(
            user_id=user_id,
            project_id=project_id,
            user_email=user_email,
            user_name=user_name,
            user_token=user_token,
            correlation_id=correlation_id,
        )

        logger.debug(
            "gateway_identity_authenticated",
            user_id=user_id,
            project_id=project_id or "<from-url>",
            correlation_id=correlation_id,
            has_user_token=bool(user_token),
        )

        # Claims dict shape:
        # - ``_identity`` is the canonical accessor for downstream code.
        # - ``sub`` keeps backward-compat with the existing
        #   ``_resolve_user_id`` lookup chain (it already reads
        #   ``claims["sub"]`` first when ``request.state.user_id`` is
        #   absent).
        # - Intentionally omit any field carrying the raw user token
        #   (no ``Authorization``, no ``user_token``). The only legal
        #   path to read the token is the typed
        #   ``IdentityContext.user_token`` attribute.
        return {
            "authenticated": True,
            "scheme": "gateway_identity",
            "sub": user_id,
            "_identity": identity,
        }


class AgentAuthMiddleware:
    """Pure-ASGI **HTTP-only** middleware that applies authentication to
    protected paths.

    Wraps an :class:`AuthMiddleware` implementation and applies it to all
    HTTP requests whose path starts with ``/api/v1/projects``. Exempt paths
    (``/health``, ``/docs``, etc.) always pass through without
    authentication.

    .. note::
       Implemented as **raw ASGI** rather than Starlette's
       ``BaseHTTPMiddleware`` on purpose. ``BaseHTTPMiddleware`` runs the
       downstream app inside an anyio task group / cancel scope; that is
       incompatible with long-lived streaming responses
       (``EventSourceResponse`` for SSE). When an SSE client disconnects
       mid-stream the cancel scope is exited from a different task than it
       was entered, raising ``RuntimeError: Attempted to exit a cancel scope
       that isn't the current task's current cancel scope`` and a noisy
       500 in the access log. A pure-ASGI middleware simply forwards the same
       ``scope``/``receive``/``send`` callables, so streaming + disconnect
       work cleanly. See the SSE stream routes in ``routes.py``.

    .. warning::
       Only HTTP scopes are authenticated here — WebSocket connections are
       passed straight through. WebSocket routes under
       ``/api/v1/projects/.../ws`` are authenticated separately by
       :func:`agent_service_maf.interface_layer.routes._authenticate_websocket`,
       which runs the same provider (stashed on ``app.state.auth_provider``
       by :func:`agent_service_maf.interface_layer.api.create_app`) at
       handshake time. Both wirings must be present for full coverage; the
       module docstring has the full split.

    Stores the returned claims in ``request.state.claims`` (i.e.
    ``scope["state"]["claims"]``) for use by route handlers. (The WS path
    stashes claims on ``websocket.state.claims``.)

    Args:
        app: The ASGI application to wrap.
        auth_provider: The authentication provider to use. Pass
            :class:`NoopAuthMiddleware` when ``interface.auth.enabled`` is
            ``False``.

    Example:
        >>> app.add_middleware(AgentAuthMiddleware, auth_provider=APIKeyAuthMiddleware(keys))
        >>> app.state.auth_provider = auth_provider   # also reachable by WS routes
    """

    def __init__(self, app: ASGIApp, auth_provider: AuthMiddleware) -> None:
        self.app = app
        self._auth_provider = auth_provider

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """ASGI entry point — authenticate HTTP requests, then forward.

        Non-HTTP scopes (``websocket`` handshakes, ``lifespan``) are passed
        through untouched. For HTTP, exempt paths skip the provider; protected
        paths run it and stash claims on ``scope["state"]``; auth failures are
        rendered as a JSON 401 envelope without ever entering the downstream
        app (so no stack trace leaks).

        Args:
            scope: ASGI connection scope.
            receive: ASGI receive callable (forwarded untouched — the body is
                never consumed here).
            send: ASGI send callable.
        """
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        path = request.url.path

        # Always exempt health and docs endpoints — provider never runs, and
        # claims are intentionally left unset (matches the prior contract).
        if path in _AUTH_EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return

        if path.startswith(_AUTH_REQUIRED_PREFIX):
            try:
                claims = await self._auth_provider.authenticate(request)
            except Exception as exc:
                # Catch HTTPException from auth providers and return proper response.
                from fastapi import HTTPException as FastAPIHTTPException

                if isinstance(exc, FastAPIHTTPException):
                    response = JSONResponse(
                        status_code=exc.status_code,
                        content={"error": exc.detail, "error_type": "AuthenticationError"},
                    )
                else:
                    logger.error("Unexpected auth error", error=str(exc), path=path)
                    response = JSONResponse(
                        status_code=401,
                        content={
                            "error": "Authentication error. Check server logs for details.",
                            "error_type": "AuthenticationError",
                        },
                    )
                await response(scope, receive, send)
                return
            # ``request.state`` is backed by ``scope["state"]``, so the
            # downstream route handler (a fresh Request over the same scope)
            # reads exactly what we set here.
            request.state.claims = claims
        else:
            # Non-protected path — set empty claims.
            request.state.claims = {}

        await self.app(scope, receive, send)


def build_auth_middleware(
    enabled: bool,
    scheme: str = "api_key",
    api_keys: list[str] | None = None,
    api_key_header: str = "X-API-Key",
) -> AuthMiddleware:
    """Factory function that creates the appropriate auth middleware from config.

    Args:
        enabled: Whether authentication is enabled. When ``False``, returns
            :class:`NoopAuthMiddleware`.
        scheme: Authentication scheme. Currently supports ``"api_key"``.
            Future: ``"oauth2"``, ``"mtls"``.
        api_keys: List of valid API keys. Required when ``scheme="api_key"``
            and ``enabled=True``. Must come from environment variables.
        api_key_header: Header name for the API key. Defaults to ``"X-API-Key"``.

    Returns:
        An :class:`AuthMiddleware` implementation appropriate for the config.

    Raises:
        ValueError: If ``enabled=True`` and ``scheme="api_key"`` but ``api_keys``
            is empty or ``None``.

    Example:
        >>> import os
        >>> keys = os.environ.get("AGENT_INTERFACE__AUTH__API_KEYS", "").split(",")
        >>> auth = build_auth_middleware(enabled=True, api_keys=keys)
    """
    if not enabled:
        logger.info("Authentication disabled — using NoopAuthMiddleware")
        return NoopAuthMiddleware()

    if scheme == "api_key":
        keys = [k for k in (api_keys or []) if k]
        if not keys:
            raise ValueError(
                "API key authentication is enabled but no API keys are configured. "
                "Set AGENT_INTERFACE__AUTH__API_KEYS environment variable with "
                "a comma-separated list of valid keys."
            )
        return APIKeyAuthMiddleware(valid_keys=keys, header_name=api_key_header)

    if scheme == "gateway_identity":
        # §B2 — the gateway scheme is configuration-free: it derives
        # everything from the inbound headers populated by the API
        # gateway. The trust-model requirement (network policy locking
        # the pod behind the gateway) lives in the docstring on
        # :class:`GatewayIdentityAuthMiddleware`.
        logger.info(
            "Authentication enabled — using GatewayIdentityAuthMiddleware "
            "(trusts gateway-injected X-User-ID / X-Project-ID / "
            "X-User-Token headers)."
        )
        return GatewayIdentityAuthMiddleware()

    raise ValueError(
        f"Unsupported auth scheme '{scheme}'. "
        "Supported schemes: 'api_key', 'gateway_identity'. "
        "OAuth2 and mTLS are planned for future phases."
    )
