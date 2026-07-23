"""§E1+E2 / §3 — MCP identity-propagation helpers (two-token model).

This module is the single source of truth for the **outbound MCP header
shape** when an identity is bound to the active request. It exposes
two small, pure helpers and one transport-shaped wrapper so the
calling code (``MCPManager`` / ``MCPConnectionManager`` /
``MCPToolInvoker``) stays uncluttered.

Two-token model (locked, see §3 of the plan)
--------------------------------------------

Every outbound MCP HTTP/SSE call carries **two distinct authorization
concerns**, separated:

* ``Authorization`` header  -> **service-account token**
    Proves "this is MAF calling". One per-deployment value sourced
    from the ``mcp.service_token`` config knob (env-only secret
    ``AGENT_MCP__SERVICE_TOKEN``).

* ``X-User-Token`` header   -> **user JWT** (on-behalf-of)
    Forwarded from the inbound user request via
    :attr:`IdentityContext.user_token`. Optional; only sent when the
    user supplied a token.

Legacy fallback (§3 table): when no service token is configured the
wrapper degrades gracefully -- it forwards the user JWT as
``Authorization`` (preserves the legacy ``mcp_pool.py:28-29`` shape)
*and* still adds ``X-User-Token`` so the MCP server can migrate at
its own pace. Once every MCP server reads ``X-User-Token``, the
fallback can be retired by simply requiring ``MCP_SERVICE_TOKEN``
in config validation.

stdio servers (§E3)
-------------------

stdio MCP transports cannot carry HTTP headers; identity is propagated
via the MCP protocol-level ``_meta`` field instead -- see
:func:`build_identity_meta`. The MCP transport frames are loggable, so
``_meta.identity`` MUST exclude both the user JWT and any service
token.
"""

from __future__ import annotations

from typing import Any

import structlog

from agent_service_maf.core.identity import IdentityContext

logger = structlog.get_logger(__name__)


# Outbound header names. Kept in one place so tests can import them and
# downstream consumers (kb-retrieval, MCP servers) can pin against the
# same constants.
HDR_AUTHORIZATION: str = "Authorization"
HDR_USER_TOKEN: str = "X-User-Token"
HDR_USER_ID: str = "X-User-ID"
HDR_PROJECT_ID: str = "X-Project-ID"
HDR_USER_EMAIL: str = "X-User-Email"
HDR_USER_NAME: str = "X-User-Name"
HDR_CORRELATION_ID: str = "X-Correlation-ID"


def build_identity_headers(
    identity: IdentityContext | None,
    service_token: str | None,
) -> dict[str, str]:
    """Build the outbound HTTP header dict for an MCP HTTP/SSE call.

    Applies the §3 two-token model:

    1. ``Authorization`` <- ``Bearer {service_token}`` when configured;
       otherwise the inbound user JWT (legacy fallback) when present.
    2. ``X-User-Token``  <- the inbound user JWT (always, when present).
    3. ``X-User-ID`` / ``X-Project-ID`` / ``X-User-Email`` /
       ``X-User-Name`` <- identity attribution fields (whatever the
       identity carries).

    The returned dict contains only string values and never includes
    a ``None`` -- safe to splat into any httpx / SDK headers param.

    Args:
        identity: The bound :class:`IdentityContext`, or ``None`` if no
            identity was bound (dev / no-auth mode). When ``None`` and
            no service token is configured, the returned dict is empty.
        service_token: The per-deployment MCP service-account token
            from ``mcp.service_token`` config. ``None`` / empty
            triggers the legacy-compat fallback path.

    Returns:
        Header dict ready to merge into the outbound request.
    """
    headers: dict[str, str] = {}

    # ---- Transport auth: Authorization = service-account token ----
    if service_token:
        headers[HDR_AUTHORIZATION] = f"Bearer {service_token}"
    elif identity is not None and identity.user_token:
        # Legacy-compat fallback (§3 table): no service token
        # configured -- forward the user JWT as Authorization so MCP
        # servers on the legacy shape (mcp_pool.py:28-29) continue
        # to work. The X-User-Token below means the same server can
        # migrate to the new contract at its own pace.
        headers[HDR_AUTHORIZATION] = f"Bearer {identity.user_token}"

    # ---- User-on-behalf-of: identity headers (always) + X-User-Token --
    if identity is not None:
        if identity.user_id:
            headers[HDR_USER_ID] = identity.user_id
        if identity.project_id:
            headers[HDR_PROJECT_ID] = identity.project_id
        if identity.user_email:
            headers[HDR_USER_EMAIL] = identity.user_email
        if identity.user_name:
            headers[HDR_USER_NAME] = identity.user_name
        if identity.user_token:
            headers[HDR_USER_TOKEN] = identity.user_token
        if identity.correlation_id:
            headers[HDR_CORRELATION_ID] = identity.correlation_id

    return headers


def build_identity_meta(identity: IdentityContext | None) -> dict[str, Any] | None:
    """Build the MCP-protocol ``_meta.identity`` payload for stdio calls.

    Used by :func:`agent_service_maf.mcp.mcp_manager.MCPManager.call_tool`
    when the transport is stdio (no HTTP headers available).

    **Never includes the user JWT or any service token**: MCP transport
    frames are loggable and ``_meta`` is treated as non-secret
    metadata. The user token stays on the typed
    :attr:`IdentityContext.user_token` accessor; the service token
    stays in server-side config. stdio MCP servers trust the local
    launch context for caller identity (since the MCP server is a
    child process MAF spawned) and read ``_meta.identity`` for the
    user-on-behalf-of context.

    Args:
        identity: The bound :class:`IdentityContext`, or ``None``.

    Returns:
        A dict to pass to the SDK's ``call_tool(..., meta=...)``, or
        ``None`` when no identity is bound (the SDK happily accepts
        ``None`` and elides the field on the wire).
    """
    if identity is None:
        return None
    payload: dict[str, Any] = {
        "userId": identity.user_id,
    }
    if identity.project_id:
        payload["projectId"] = identity.project_id
    if identity.user_email:
        payload["userEmail"] = identity.user_email
    if identity.user_name:
        payload["userName"] = identity.user_name
    if identity.correlation_id:
        payload["correlationId"] = identity.correlation_id
    # ``userToken`` is intentionally absent -- MCP transport frames
    # are loggable; the user JWT lives only on the typed accessor.
    return {"identity": payload}


class IdentityAwareHTTPTransport:
    """§E1 -- conceptual per-call header injector for HTTP/SSE MCP calls.

    Wraps an inner MCP transport-shaped object whose ``call_tool``
    coroutine accepts a ``headers=`` keyword. On every call, reads the
    active :class:`IdentityContext` from the ContextVar and assembles
    the §3 two-token-model header dict via
    :func:`build_identity_headers`.

    Phase-1 reality check (see plan §1, "Risks worth calling out"):
        The current MCP SDK's ``ClientSessionGroup.call_tool`` does NOT
        accept per-call HTTP headers -- they're baked into the
        underlying httpx client at connect-time. So this wrapper is
        used **only** by direct-httpx integrations (the KB-retrieval
        function tool is the canonical consumer). For HTTP/SSE MCP
        servers the static ``MCPServerConfig.headers`` is used for the
        service token, and the user-on-behalf-of identity is
        propagated via ``_meta`` (transport-agnostic; see
        :func:`build_identity_meta`). A future patch that bypasses
        ``ClientSessionGroup`` in favour of the lower-level
        ``sse_client`` / ``streamable_http_client`` + an
        :class:`httpx.Auth` flow can plug into this same wrapper to
        get true per-call header injection on the MCP transport.

    Example:
        >>> transport = IdentityAwareHTTPTransport(
        ...     inner=raw_transport,
        ...     mcp_service_token="svc-abc",
        ... )
        >>> await transport.call_tool("search", {"q": "hello"})
    """

    def __init__(
        self,
        inner: Any,  # noqa: ANN401 -- duck-typed transport
        mcp_service_token: str | None,
    ) -> None:
        self._inner = inner
        # ``mcp.service_token`` env-only secret -- see plan §3 table.
        self._service_token = mcp_service_token or None

    async def call_tool(  # noqa: ANN401
        self,
        name: str,
        arguments: dict[str, Any],
        **kwargs: Any,  # noqa: ANN401
    ) -> Any:  # noqa: ANN401
        # Import inside the method so the helpers can be imported in
        # contexts that don't have the ContextVar populated (tests).
        from agent_service_maf.core.identity import get_current_identity

        identity = get_current_identity()
        headers: dict[str, str] = kwargs.setdefault("headers", {})
        for key, value in build_identity_headers(identity, self._service_token).items():
            headers.setdefault(key, value)
        return await self._inner.call_tool(name, arguments, **kwargs)


__all__ = [
    "HDR_AUTHORIZATION",
    "HDR_CORRELATION_ID",
    "HDR_PROJECT_ID",
    "HDR_USER_EMAIL",
    "HDR_USER_ID",
    "HDR_USER_NAME",
    "HDR_USER_TOKEN",
    "IdentityAwareHTTPTransport",
    "build_identity_headers",
    "build_identity_meta",
]
