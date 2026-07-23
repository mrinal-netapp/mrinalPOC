"""Unit tests for the registry-backed FunctionToolProvider.

Covers:
    * Discriminated-union parsing of `tool_bindings[]`.
    * Function-binding registration and dispatch.
    * Server-wins via keyword-only params (LLM cannot override).
    * Unknown binding / unregistered function_ref errors.
    * Function exceptions surface as FunctionToolError naming the binding.
    * Default args reflect binding params (trace parity).
"""

from __future__ import annotations

from typing import Annotated, Any

import pytest

from agent_service_maf.tools import (
    FunctionBinding,
    FunctionToolProvider,
    MCPBinding,
    parse_tool_bindings,
)
from agent_service_maf.tools.function_provider import FunctionToolError
from agent_service_maf.tools.functions import (
    _clear_registry_for_tests,
    register_function,
    registered_function_names,
)

# ---------------------------------------------------------------------------
# Test fixtures: a fresh registry per test so registrations don't leak.
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_registry() -> None:
    """Wipe the registry, then re-import kb_retrieve to restore the default."""
    _clear_registry_for_tests()
    # Re-register the canonical function so production-code paths still work.
    import importlib

    import agent_service_maf.tools.functions.kb_retrieve as _kb

    importlib.reload(_kb)


# ---------------------------------------------------------------------------
# parse_tool_bindings
# ---------------------------------------------------------------------------


class TestParseToolBindings:
    def test_parses_function_and_mcp_bindings(self) -> None:
        raw = [
            {
                "name": "kb_rfc",
                "type": "function",
                "function_ref": "kb_retrieve",
                "params": {"kbId": "x", "projectId": "y"},
            },
            {
                "name": "kb_mcp",
                "type": "mcp",
                "transport": "streamable-http",
                "url": "https://example.com/mcp",
            },
        ]
        bindings = parse_tool_bindings(raw)
        assert len(bindings) == 2
        assert isinstance(bindings[0], FunctionBinding)
        assert isinstance(bindings[1], MCPBinding)

    def test_skips_disabled(self) -> None:
        raw = [
            {
                "name": "a",
                "type": "function",
                "function_ref": "kb_retrieve",
                "enabled": False,
            },
            {"name": "b", "type": "function", "function_ref": "kb_retrieve"},
        ]
        bindings = parse_tool_bindings(raw)
        assert [b.name for b in bindings] == ["b"]

    def test_unknown_function_ref_raises_with_registry_listing(self) -> None:
        raw = [{"name": "kb", "type": "function", "function_ref": "does_not_exist"}]
        with pytest.raises(ValueError) as ei:
            parse_tool_bindings(raw)
        msg = str(ei.value)
        assert "does_not_exist" in msg
        assert "Registered functions" in msg
        assert "kb_retrieve" in msg, "actionable error must list available names"

    def test_invalid_name_raises_with_label(self) -> None:
        raw = [
            {
                "name": "bad name with spaces",
                "type": "function",
                "function_ref": "kb_retrieve",
            }
        ]
        with pytest.raises(ValueError, match="Invalid tool binding"):
            parse_tool_bindings(raw)

    def test_unknown_type_raises(self) -> None:
        with pytest.raises(ValueError, match="unknown or missing type"):
            parse_tool_bindings([{"name": "x", "type": "rest"}])

    def test_mcp_binding_without_url_raises(self) -> None:
        with pytest.raises(ValueError, match="has no 'url'"):
            parse_tool_bindings([{"name": "kb", "type": "mcp", "transport": "sse"}])


# ---------------------------------------------------------------------------
# Registry: register / lookup / duplicate detection
# ---------------------------------------------------------------------------


class TestFunctionRegistry:
    def test_register_and_lookup(self) -> None:
        @register_function("test_echo")
        async def _echo(message: str, *, params: dict[str, Any]) -> str:
            return f"{params.get('prefix', '')}{message}"

        from agent_service_maf.tools.functions import get_function

        assert get_function("test_echo") is _echo
        assert "test_echo" in registered_function_names()

    def test_duplicate_registration_raises(self) -> None:
        @register_function("dupe")
        async def _first(*, params: dict[str, Any]) -> str:
            return "first"

        with pytest.raises(ValueError, match="already registered"):

            @register_function("dupe")
            async def _second(*, params: dict[str, Any]) -> str:
                return "second"


# ---------------------------------------------------------------------------
# FunctionToolProvider dispatch
# ---------------------------------------------------------------------------


class TestProviderDispatch:
    @pytest.mark.asyncio
    async def test_dispatches_to_registered_function_with_pinned_params(self) -> None:
        captured: dict[str, Any] = {}

        @register_function("greeter")
        async def _greeter(
            name: Annotated[str, "Person to greet."],
            *,
            params: dict[str, Any],
        ) -> str:
            captured["name"] = name
            captured["params"] = dict(params)
            return f"hi {name} from {params['tenant']}"

        b = FunctionBinding(
            name="greeter_acme",
            function_ref="greeter",
            params={"tenant": "acme"},
        )
        p = FunctionToolProvider(bindings=[b])
        result = await p.call_tool("greeter_acme", {"name": "alice"})
        assert result == "hi alice from acme"
        assert captured == {"name": "alice", "params": {"tenant": "acme"}}

    @pytest.mark.asyncio
    async def test_llm_cannot_override_pinned_params(self) -> None:
        """LLM-supplied 'params' kwarg must not reach the function's params."""
        captured: dict[str, Any] = {}

        @register_function("recorder")
        async def _recorder(query: str, *, params: dict[str, Any]) -> str:
            captured["params"] = dict(params)
            return "ok"

        b = FunctionBinding(
            name="rec_pinned",
            function_ref="recorder",
            params={"kbId": "REAL"},
        )
        p = FunctionToolProvider(bindings=[b])

        # The LLM cannot reach the keyword-only `params` arg via positional
        # or keyword spreading because we always pass `params=...` explicitly.
        # However, an LLM could try to send a key called `params` in its
        # arguments dict. That would land in **arguments, then collide
        # with our explicit params= kwarg → TypeError → FunctionToolError.
        with pytest.raises(FunctionToolError, match="rec_pinned"):
            await p.call_tool(
                "rec_pinned",
                {"query": "x", "params": {"kbId": "FAKE"}},
            )

    @pytest.mark.asyncio
    async def test_unknown_binding_raises(self) -> None:
        p = FunctionToolProvider(bindings=[])
        with pytest.raises(FunctionToolError, match="Unknown function binding"):
            await p.call_tool("nope", {})

    @pytest.mark.asyncio
    async def test_unregistered_function_ref_raises(self) -> None:
        # Build the binding directly, bypassing parse_tool_bindings's
        # registry check, to exercise the provider's own guard.
        b = FunctionBinding(name="orphan", function_ref="ghost_fn")
        p = FunctionToolProvider(bindings=[b])
        with pytest.raises(FunctionToolError, match="ghost_fn.*not registered"):
            await p.call_tool("orphan", {})

    @pytest.mark.asyncio
    async def test_function_exception_wrapped_with_binding_name(self) -> None:
        @register_function("boom")
        async def _boom(*, params: dict[str, Any]) -> str:
            raise RuntimeError("upstream broke")

        b = FunctionBinding(name="boom_b", function_ref="boom")
        p = FunctionToolProvider(bindings=[b])
        with pytest.raises(FunctionToolError) as ei:
            await p.call_tool("boom_b", {})
        msg = str(ei.value)
        assert "boom_b" in msg
        assert "upstream broke" in msg

    def test_get_default_arguments_returns_pinned_params(self) -> None:
        b = FunctionBinding(
            name="x",
            function_ref="kb_retrieve",
            params={"kbId": "K", "projectId": "P"},
        )
        p = FunctionToolProvider(bindings=[b])
        assert p.get_default_arguments("x") == {"kbId": "K", "projectId": "P"}
        assert p.get_default_arguments("missing") == {}
