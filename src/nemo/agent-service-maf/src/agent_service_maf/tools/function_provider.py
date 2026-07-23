"""FunctionToolProvider — registry-backed dispatcher for ``type='function'`` bindings.

Each binding becomes a distinct callable tool. The provider:

1. Holds the bindings keyed by name.
2. On invocation, looks up the binding's ``function_ref`` in the
   :mod:`agent_service_maf.tools.functions` registry and calls the
   registered async function with the LLM-supplied arguments plus a
   keyword-only ``params`` argument carrying the binding's pinned
   parameters.

Server-wins is enforced by Python signature: the registered function
declares ``params`` as keyword-only, so the LLM cannot reach it by
positional argument or by overriding via the LLM-supplied dict.

The dispatcher does **no** HTTP, no schema validation, no retry, no
response shaping — those concerns live in each registered function and
are unit-testable in isolation.
"""

from __future__ import annotations

from typing import Any

import structlog

from agent_service_maf.tools.binding import FunctionBinding
from agent_service_maf.tools.functions import FunctionToolResult, get_function

logger = structlog.get_logger(__name__)


class FunctionToolError(Exception):
    """Raised when a function-tool call fails irrecoverably.

    The message always names the offending binding so log searches can
    pinpoint the source quickly.
    """


class FunctionToolProvider:
    """Dispatcher for function-typed tool bindings.

    Args:
        bindings: Function bindings to register. Disabled bindings
            should already be filtered out by the caller (parse_tool_bindings
            handles that). MCP bindings should not be passed here.
    """

    def __init__(self, bindings: list[FunctionBinding]) -> None:
        self._bindings: dict[str, FunctionBinding] = {b.name: b for b in bindings}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def binding_names(self) -> list[str]:
        """Stable iteration order over registered binding names."""
        return list(self._bindings)

    def get_binding(self, name: str) -> FunctionBinding | None:
        """Return the binding registered under *name*, or ``None``."""
        return self._bindings.get(name)

    def get_default_arguments(self, name: str) -> dict[str, Any]:
        """Return the binding's pinned ``params`` (parity with MCPManager).

        Used by the SK plugin layer / trace recorder when surfacing the
        deployment-pinned values that drove a tool call. The LLM cannot
        see or override these — they're injected via the function's
        keyword-only ``params`` argument at call time.
        """
        binding = self._bindings.get(name)
        return dict(binding.params) if binding else {}

    async def call_tool(
        self,
        binding_name: str,
        arguments: dict[str, Any],
    ) -> str | FunctionToolResult:
        """Invoke the function tool registered as *binding_name*.

        Args:
            binding_name: Name of the binding to call.
            arguments: LLM-supplied keyword arguments. Passed positionally
                via ``**arguments``. The binding's ``params`` are passed
                separately as the keyword-only ``params`` argument.

        Returns:
            Whatever the registered function returned: either a plain
            ``str`` (LLM-facing tool result, the historical contract) or
            a :class:`FunctionToolResult` that also carries
            ``kb_citations``. The provider is intentionally pass-through
            -- the unpacking happens in the SK adapter's recording
            executor so ``tool_history`` captures the citations and the
            LLM still receives a plain string via ``.text``.

        Raises:
            FunctionToolError: For any irrecoverable failure (unknown
                binding, missing function in registry, exception raised
                by the function). The message names the binding and is
                safe to surface to operators.
        """
        binding = self._bindings.get(binding_name)
        if binding is None:
            raise FunctionToolError(
                f"Unknown function binding '{binding_name}'. "
                f"Configured bindings: {sorted(self._bindings)}."
            )

        fn = get_function(binding.function_ref)
        if fn is None:
            raise FunctionToolError(
                f"Function binding '{binding_name}' references function_ref="
                f"'{binding.function_ref}' which is not registered."
            )

        try:
            return await fn(**arguments, params=dict(binding.params))
        except FunctionToolError:
            raise
        except TypeError as exc:
            # Most likely a missing/unexpected LLM-supplied argument —
            # surface the binding name so operators don't have to grep.
            raise FunctionToolError(
                f"Function binding '{binding_name}' argument mismatch: {exc}."
            ) from exc
        except Exception as exc:
            raise FunctionToolError(f"Function binding '{binding_name}' raised: {exc}.") from exc
