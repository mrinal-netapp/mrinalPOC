"""ToolExecutionStrategy — pluggable interface for tool call execution.

Defines the ``ToolExecutionStrategy`` Protocol so the ``LLMGateway`` tool-use
loop is not coupled to a single execution model. Alternative strategies
(sequential, concurrent, conditional) can be injected without modifying the
gateway.

Phase 5 (MCPManager / ToolRegistry) provides concrete implementations. Until
then, the interface is defined here so Phase 3 files can type-check cleanly.

Example::

    from agent_service_maf.gateway.tool_strategy import ToolExecutionStrategy

    class MySequentialStrategy:
        async def execute(
            self,
            tool_calls: list[dict[str, object]],
            context: object,
        ) -> list[dict[str, object]]:
            results = []
            for tc in tool_calls:
                results.append(await run_tool(tc))
            return results

    gateway = LLMGateway(config, tool_strategy=MySequentialStrategy())
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class ToolExecutionStrategy(Protocol):
    """Protocol for tool-call execution strategies injected into ``LLMGateway``.

    Implementors receive the raw list of tool-call dicts returned by the LLM
    (OpenAI function-call format) and an opaque ``context`` object provided by
    the gateway (may include MCPManager, guardrail callbacks, config, etc.).

    They return a parallel list of tool-result dicts, one per input tool call,
    in the same order. If a tool call fails, the strategy should return an error
    result dict rather than raise (so the conversation can continue).

    Each result dict must contain at minimum::

        {
            "tool_call_id": str,   # Echo of the tool_call["id"]
            "role":         "tool",
            "content":      str,   # Result text or error message
        }
    """

    async def execute(
        self,
        tool_calls: list[dict[str, Any]],
        context: object,
    ) -> list[dict[str, Any]]:
        """Execute a batch of tool calls and return their results.

        Args:
            tool_calls: List of OpenAI-format tool-call dicts, each containing
                ``id``, ``type``, and ``function`` (``name`` + ``arguments``).
            context: Opaque execution context supplied by ``LLMGateway``.
                Concrete strategies cast this to whatever type they expect.

        Returns:
            List of tool-result dicts (same length and order as ``tool_calls``),
            each with ``tool_call_id``, ``role="tool"``, and ``content`` keys.
        """
        ...
