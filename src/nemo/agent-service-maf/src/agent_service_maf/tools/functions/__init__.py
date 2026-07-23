"""Function-binding registry.

Hosts every Python callable that can be referenced by a
:class:`~agent_service_maf.tools.binding.FunctionBinding` via
``function_ref``. Each callable is the concrete implementation behind
one or more bindings — bindings differ only in their pinned ``params``.

Conventions for a registered function::

    from typing import Annotated, Any
    from agent_service_maf.tools.functions import register_function

    @register_function("kb_retrieve")
    async def kb_retrieve(
        query: Annotated[str, "Natural-language query."],
        top_k: Annotated[int, "Maximum chunks to return."] = 10,
        *,
        params: dict[str, Any],
    ) -> str:
        '''Default description; the binding's description overrides this.'''
        ...

Rules
-----
* Async callable.
* Positional/positional-or-keyword arguments are exposed to the LLM.
* ``Annotated[T, "..."]`` provides the per-parameter description shown
  to the LLM via SK's ``KernelParameterMetadata``.
* The trailing keyword-only ``params: dict`` is **invisible to the LLM**
  and is filled at call time from the binding's pinned ``params``. It
  carries deployment-fixed values (tenant ids, kb ids, ...).
* Returns either a plain ``str`` (LLM-facing tool result) or a
  :class:`FunctionToolResult` carrying ``text`` plus optional
  ``kb_citations``. The framework hands ``text`` to the LLM and threads
  ``kb_citations`` onto the tool-result event metadata and the
  :class:`~agent_service_maf.core.interfaces.Citations` envelope without
  any per-tool allowlist — a function emits citations iff it returns
  them.
* Owns its HTTP / DB / retry / serialisation logic — the dispatcher is
  intentionally dumb.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class FunctionToolResult:
    """Structured return for function tools that surface KB citations.

    Function tools that have no citations to emit may keep returning a
    plain ``str`` and this dataclass is irrelevant to them. Tools that
    want to populate ``tools[].kbCitations`` on the wire return one of
    these instead.

    Attributes:
        text: The LLM-facing tool result. This is what the framework
            feeds back into the conversation -- equivalent to the old
            plain-``str`` return.
        kb_citations: KB citation dicts (or
            :class:`~agent_service_maf.core.interfaces.KbCitation`
            instances) parsed from the tool's response. The framework
            does not validate field shape here; the response builder
            coerces and silently drops malformed entries.
        tool_type: Optional discriminator forwarded onto
            :class:`~agent_service_maf.core.interfaces.ToolExecution.tool_type`.
            ``"kb"`` for KB retrieval tools (``kb_retrieve`` and equivalents);
            unset for plain function tools, which the adapter then defaults
            to ``"toolset"`` on the wire payload.
        tokens_used: Optional estimate of context tokens this tool's
            response will consume on the next LLM call. The UI Statistics
            panel uses this to compute "Context window usage" (``sum
            tokens_used / model context limit``). Tools that don't know
            should leave it ``None``.
    """

    text: str
    kb_citations: list[Any] = field(default_factory=list)
    tool_type: str | None = None
    tokens_used: int | None = None


# Type alias for the union of legal function-tool returns.
FunctionToolReturn = str | FunctionToolResult


# Registry. Stable name → async callable.
_REGISTRY: dict[str, Callable[..., Awaitable[FunctionToolReturn]]] = {}


def register_function(
    name: str,
) -> Callable[
    [Callable[..., Awaitable[FunctionToolReturn]]],
    Callable[..., Awaitable[FunctionToolReturn]],
]:
    """Decorator that registers an async function under *name*.

    Args:
        name: Stable identifier referenced by ``FunctionBinding.function_ref``.
            Re-registration under the same name raises — duplicates are
            almost always programmer error.

    Returns:
        The original function, unchanged. Side effect: it now appears
        in :func:`get_function` and :func:`registered_function_names`.

    Raises:
        ValueError: When *name* is already registered.
    """

    def _decorator(
        fn: Callable[..., Awaitable[FunctionToolReturn]],
    ) -> Callable[..., Awaitable[FunctionToolReturn]]:
        if name in _REGISTRY:
            raise ValueError(
                f"Tool function '{name}' is already registered. Each function_ref must be unique."
            )
        _REGISTRY[name] = fn
        logger.debug("Registered tool function", name=name, callable=fn.__qualname__)
        return fn

    return _decorator


def get_function(
    name: str,
) -> Callable[..., Awaitable[FunctionToolReturn]] | None:
    """Return the registered callable for *name*, or ``None`` if unknown."""
    return _REGISTRY.get(name)


def registered_function_names() -> list[str]:
    """Return a sorted list of registered function names (stable iteration)."""
    return sorted(_REGISTRY)


def _clear_registry_for_tests() -> None:
    """Test hook — wipes the registry. Do not call from production code."""
    _REGISTRY.clear()


# Eagerly import concrete functions so their @register_function decorators
# run at framework import time. Add new function modules here.
from agent_service_maf.tools.functions import kb_retrieve as _kb_retrieve  # noqa: E402, F401

__all__ = [
    "FunctionToolResult",
    "FunctionToolReturn",
    "get_function",
    "register_function",
    "registered_function_names",
]
