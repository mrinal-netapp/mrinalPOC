"""§3 / §A1 — Server-side identity carrier and ContextVar binding.

This module is the single source of truth for *who* a request is for.
It exposes:

* :class:`IdentityContext` -- typed, frozen, camelCase-on-the-wire
  Pydantic model carrying ``userId`` / ``projectId`` /
  ``userEmail`` / ``userName`` / ``userToken`` (the raw user JWT).
  Bound once at the auth-middleware edge and propagated unchanged to
  every downstream call.

* A request-scoped :class:`contextvars.ContextVar` (
  :data:`_identity_var`) plus three helpers
  (:func:`get_current_identity`, :func:`set_current_identity`,
  :func:`reset_current_identity`) so function tools and async-aware
  helpers can read the active identity without it being part of the
  tool / function signature. The LLM must never be able to set the
  identity by hallucinating a parameter, hence the strict separation.

Two-token model (locked, see §3 of the plan)
--------------------------------------------

The plan keeps two authorization tokens strictly separate:

* **Service-account token** -- placed on outbound ``Authorization``
  headers; proves "this is MAF calling". One per downstream
  (``MCP_SERVICE_TOKEN``, ``BIFROST_API_KEY``, ``KB_SERVICE_TOKEN``).
  Server-side config; NEVER held on :class:`IdentityContext`.

* **User token** = ``user_token`` field below -- the inbound user
  JWT. Forwarded to downstreams on the **separate
  ``X-User-Token``** header so downstream services can validate the
  user's identity / scopes / per-user authorization without
  conflating it with service-to-service trust.

Concurrency / async behavior (§3 + §I3)
---------------------------------------

:class:`contextvars.ContextVar` is asyncio-task-scoped. Two concurrent
invocations on the same process see distinct identities because each
HTTP request handler runs in its own asyncio Task. The same guarantee
is what the existing ``core.session._memory_degraded_var`` relies on.

Across :func:`asyncio.create_task` boundaries the parent context is
*snapshotted* at task-creation time but is **not** automatically
refreshed when the parent rebinds. That is why §D2 of the plan calls
out the explicit ``set_current_identity(task.identity)`` re-bind at
the top of the async-task runner.
"""

from __future__ import annotations

import contextvars

from pydantic import ConfigDict, Field

from agent_service_maf.core._base_model import CamelCaseModel


class IdentityContext(CamelCaseModel):
    """Server-side identity bound to a single agent invocation.

    Frozen and immutable on purpose -- once bound at the edge it must
    flow unchanged to every downstream callout. To mutate (e.g. to
    fill ``project_id`` from the URL path when the inbound header was
    empty), call :meth:`model_copy` and re-bind the ContextVar with
    the new instance.

    The model is :class:`CamelCaseModel` so any external serialization
    emits camelCase keys -- but :attr:`user_token` is
    :func:`~pydantic.Field`-excluded from :meth:`model_dump` /
    :meth:`model_dump_json` output (see §H3 of the plan and the
    associated test ``test_user_token_never_serialized``). Logging,
    citations, session messages, task results, and trace spans must
    never contain the raw token.

    Attributes:
        user_id: The authenticated user identifier from the gateway
            (``X-User-ID`` header). REQUIRED -- ``401`` upstream if
            missing.
        project_id: The project / tenant identifier
            (``X-Project-ID`` header *or* the URL path when the
            header is empty). REQUIRED on protected routes -- the
            ``validate_project_access`` helper enforces both presence
            and a match with the URL path.
        user_email: Optional ``X-User-Email`` for downstream
            attribution / debugging.
        user_name: Optional ``X-User-Name`` for downstream
            attribution / debugging.
        user_token: The raw user JWT extracted from the inbound
            ``Authorization: Bearer ...`` header. Forwarded to
            downstreams on the separate ``X-User-Token`` header. NEVER
            placed on the outbound ``Authorization`` header (that
            slot is reserved for the per-downstream service-account
            token). NEVER serialized to the wire (see :attr:`Config`
            below + §H3 of the plan).
        correlation_id: Optional request correlation id used to
            stitch identity-derived logs / traces back to the
            originating invocation. Bound by the auth middleware to
            the same UUID the route handler will use.

    Example:
        >>> identity = IdentityContext(
        ...     user_id="alice",
        ...     project_id="proj-123",
        ...     user_email="alice@example.com",
        ...     user_token="<jwt>",
        ... )
        >>> json_blob = identity.model_dump_json()
        >>> "<jwt>" in json_blob
        False
    """

    user_id: str = Field(..., description="Authenticated user id (X-User-ID)")
    project_id: str = Field(
        default="",
        description=(
            "Project id (X-Project-ID or URL path). May be empty at "
            "middleware boundary and filled from the URL by "
            "validate_project_access."
        ),
    )
    user_email: str | None = Field(default=None, description="Optional X-User-Email")
    user_name: str | None = Field(default=None, description="Optional X-User-Name")
    user_token: str | None = Field(
        default=None,
        description=(
            "Raw user JWT (Authorization: Bearer <jwt> from gateway). "
            "Forwarded on X-User-Token. EXCLUDED from model_dump."
        ),
        # §H3: user_token must never appear in any serialized output --
        # response bodies, task results, session messages, citations,
        # structlog records, Phoenix spans. ``exclude=True`` keeps
        # model_dump / model_dump_json from emitting it; the only
        # legal reader is the typed Python attribute access.
        exclude=True,
    )
    correlation_id: str = Field(default="", description="Request correlation id")
    session_id: str = Field(
        default="",
        description=(
            "Conversation/session id for the current turn. Bound in the invoke "
            "route from AgentExecutionContext.session_id so the Phoenix span "
            "processor can stamp the OpenInference session.id on every span, "
            "enabling session -> trace lookups."
        ),
    )

    # CamelCaseModel sets ``populate_by_name=True`` + ``alias_generator``;
    # add ``frozen=True`` so the value cannot be mutated in place after
    # binding (mutation must go through model_copy + re-bind).
    model_config = ConfigDict(
        alias_generator=CamelCaseModel.model_config["alias_generator"],
        populate_by_name=True,
        frozen=True,
    )


# ---------------------------------------------------------------------------
# ContextVar binding
# ---------------------------------------------------------------------------


_identity_var: contextvars.ContextVar[IdentityContext | None] = contextvars.ContextVar(
    "agent_request_identity",
    default=None,
)


def get_current_identity() -> IdentityContext | None:
    """Return the identity bound to the active asyncio task.

    Returns ``None`` when no identity has been bound (e.g. during
    framework startup, in tests that don't go through the auth
    middleware, or when the active scheme is ``noop`` / ``api_key``).

    Callers that strictly require identity (KB tool, MCP transport
    in production mode) should branch on ``None`` and either fall
    back to anonymous behavior or surface a clear error -- never
    blindly dereference.

    Example:
        >>> identity = get_current_identity()
        >>> if identity is None:
        ...     # No identity bound — likely a dev / no-auth path.
        ...     pass
    """
    return _identity_var.get()


def set_current_identity(identity: IdentityContext) -> contextvars.Token[IdentityContext | None]:
    """Bind ``identity`` to the active asyncio task and return the reset token.

    Use the returned :class:`~contextvars.Token` with
    :func:`reset_current_identity` (typically in a ``try`` / ``finally``
    block) so nested binds restore the prior identity cleanly. This
    matters for the async-task runner (§D2) and for SSE generators
    that may run after the route handler returns.

    Example:
        >>> tok = set_current_identity(identity)
        >>> try:
        ...     await do_work()
        ... finally:
        ...     reset_current_identity(tok)
    """
    return _identity_var.set(identity)


def reset_current_identity(token: contextvars.Token[IdentityContext | None]) -> None:
    """Restore the identity that was active before ``set_current_identity``.

    Symmetric counterpart to :func:`set_current_identity`. Always
    pair them; orphaned :class:`~contextvars.Token` objects leak the
    bound identity into the next task that reuses the asyncio
    context.
    """
    _identity_var.reset(token)


__all__ = [
    "IdentityContext",
    "get_current_identity",
    "set_current_identity",
    "reset_current_identity",
]
