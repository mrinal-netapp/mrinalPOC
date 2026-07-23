"""Unit tests for guardrail base classes and context/result dataclasses.

Tests cover:
- GuardrailAction enum values
- GuardrailResult creation (all fields, defaults)
- GuardrailContext creation (direct and via convenience constructors)
- GuardrailContext.for_input / for_output / for_tool constructors
- ABC instantiation prevention for InputGuardrail, OutputGuardrail, ToolGuardrail
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    OutputGuardrail,
    ToolGuardrail,
)

# ---------------------------------------------------------------------------
# GuardrailAction
# ---------------------------------------------------------------------------


class TestGuardrailAction:
    """Tests for the GuardrailAction StrEnum."""

    def test_allow_value(self) -> None:
        """ALLOW must carry the canonical string 'allow'."""
        assert GuardrailAction.ALLOW == "allow", (
            "GuardrailAction.ALLOW string value must be 'allow'"
        )

    def test_block_value(self) -> None:
        """BLOCK must carry the canonical string 'block'."""
        assert GuardrailAction.BLOCK == "block", (
            "GuardrailAction.BLOCK string value must be 'block'"
        )

    def test_modify_value(self) -> None:
        """MODIFY must carry the canonical string 'modify'."""
        assert GuardrailAction.MODIFY == "modify", (
            "GuardrailAction.MODIFY string value must be 'modify'"
        )

    def test_warn_value(self) -> None:
        """WARN must carry the canonical string 'warn'."""
        assert GuardrailAction.WARN == "warn", "GuardrailAction.WARN string value must be 'warn'"

    def test_all_members_present(self) -> None:
        """All four expected actions must exist on the enum."""
        members = {a.name for a in GuardrailAction}
        assert members == {"ALLOW", "BLOCK", "MODIFY", "WARN"}, (
            f"Expected exactly 4 GuardrailAction members, got: {members}"
        )

    def test_str_enum_is_str(self) -> None:
        """StrEnum members must be usable as plain strings."""
        assert isinstance(GuardrailAction.ALLOW, str), (
            "GuardrailAction members must be str instances"
        )


# ---------------------------------------------------------------------------
# GuardrailResult
# ---------------------------------------------------------------------------


class TestGuardrailResult:
    """Tests for the GuardrailResult dataclass."""

    def test_minimal_creation_allow(self) -> None:
        """Minimal ALLOW result requires only action and guardrail_name."""
        result = GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name="test_guard",
        )
        assert result.action == GuardrailAction.ALLOW, "action must be ALLOW as supplied"
        assert result.guardrail_name == "test_guard", "guardrail_name must be preserved"
        assert result.message == "", "message must default to empty string"
        assert result.modified_content is None, "modified_content must default to None"
        assert result.details is None, "details must default to None"

    def test_block_result_with_message(self) -> None:
        """BLOCK result must preserve message and guardrail_name."""
        result = GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name="input_validator",
            message="Input too long.",
        )
        assert result.action == GuardrailAction.BLOCK, "action must be BLOCK"
        assert result.message == "Input too long.", "message must be stored verbatim"

    def test_modify_result_with_modified_content(self) -> None:
        """MODIFY result must store the modified_content string."""
        result = GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name="pii_masker",
            message="Masked 1 email.",
            modified_content="Contact [EMAIL_REDACTED]",
        )
        assert result.modified_content == "Contact [EMAIL_REDACTED]", (
            "modified_content must be stored"
        )

    def test_result_with_details(self) -> None:
        """details dict must be stored and retrievable."""
        details: dict[str, Any] = {"length": 50001, "max_length": 50000}
        result = GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name="output_length",
            details=details,
        )
        assert result.details == details, "details dict must be stored verbatim"

    def test_warn_result(self) -> None:
        """WARN result must be constructable with only required fields."""
        result = GuardrailResult(
            action=GuardrailAction.WARN,
            guardrail_name="schema_validator",
            message="Missing optional field.",
        )
        assert result.action == GuardrailAction.WARN, "action must be WARN"


# ---------------------------------------------------------------------------
# GuardrailContext — direct construction
# ---------------------------------------------------------------------------


class TestGuardrailContextDirect:
    """Tests for direct GuardrailContext construction."""

    def test_all_fields_stored(self) -> None:
        """All supplied fields must be stored unchanged."""
        extra: dict[str, Any] = {"custom_key": "custom_value"}
        ctx = GuardrailContext(
            content="Hello world",
            agent_id="my-agent",
            correlation_id="corr-abc",
            guardrail_type="input",
            extra=extra,
        )
        assert ctx.content == "Hello world", "content must be stored"
        assert ctx.agent_id == "my-agent", "agent_id must be stored"
        assert ctx.correlation_id == "corr-abc", "correlation_id must be stored"
        assert ctx.guardrail_type == "input", "guardrail_type must be stored"
        assert ctx.extra == extra, "extra must be stored"

    def test_extra_defaults_to_empty_dict(self) -> None:
        """extra must default to {} when not supplied."""
        ctx = GuardrailContext(
            content="test",
            agent_id="a",
            correlation_id="c",
            guardrail_type="output",
        )
        assert ctx.extra == {}, "extra must default to empty dict"


# ---------------------------------------------------------------------------
# GuardrailContext.for_input
# ---------------------------------------------------------------------------


class TestGuardrailContextForInput:
    """Tests for GuardrailContext.for_input convenience constructor."""

    def test_guardrail_type_is_input(self) -> None:
        """for_input must set guardrail_type to 'input'."""
        ctx = GuardrailContext.for_input("hello", "agent-1", "corr-1")
        assert ctx.guardrail_type == "input", (
            "guardrail_type must be 'input' for for_input contexts"
        )

    def test_content_and_ids_stored(self) -> None:
        """for_input must store content, agent_id, correlation_id."""
        ctx = GuardrailContext.for_input("user prompt", "a1", "c1")
        assert ctx.content == "user prompt", "content must be stored"
        assert ctx.agent_id == "a1", "agent_id must be stored"
        assert ctx.correlation_id == "c1", "correlation_id must be stored"

    def test_extra_defaults_to_empty_dict(self) -> None:
        """for_input extra must default to {}."""
        ctx = GuardrailContext.for_input("text", "agent", "corr")
        assert ctx.extra == {}, "extra must default to empty dict when not provided"

    def test_extra_is_passed_through(self) -> None:
        """for_input extra must be stored when provided."""
        ctx = GuardrailContext.for_input("text", "agent", "corr", extra={"key": "val"})
        assert ctx.extra.get("key") == "val", "extra values must be stored"

    def test_none_extra_becomes_empty_dict(self) -> None:
        """Passing extra=None to for_input must produce empty dict."""
        ctx = GuardrailContext.for_input("text", "agent", "corr", extra=None)
        assert ctx.extra == {}, "None extra must coerce to empty dict"


# ---------------------------------------------------------------------------
# GuardrailContext.for_output
# ---------------------------------------------------------------------------


class TestGuardrailContextForOutput:
    """Tests for GuardrailContext.for_output convenience constructor."""

    def test_guardrail_type_is_output(self) -> None:
        """for_output must set guardrail_type to 'output'."""
        ctx = GuardrailContext.for_output("response", "agent", "corr")
        assert ctx.guardrail_type == "output", (
            "guardrail_type must be 'output' for for_output contexts"
        )

    def test_original_input_stored_in_extra(self) -> None:
        """original_input must be accessible via extra['original_input']."""
        ctx = GuardrailContext.for_output(
            "agent response", "agent-1", "c1", original_input="user asked"
        )
        assert ctx.extra.get("original_input") == "user asked", (
            "original_input must be stored in extra['original_input']"
        )

    def test_default_original_input_empty_string(self) -> None:
        """When original_input is omitted, extra['original_input'] must be ''."""
        ctx = GuardrailContext.for_output("response", "agent", "corr")
        assert ctx.extra.get("original_input") == "", (
            "original_input must default to empty string in extra"
        )

    def test_extra_merged_with_original_input(self) -> None:
        """Additional extra keys must coexist with original_input."""
        ctx = GuardrailContext.for_output(
            "response",
            "agent",
            "corr",
            original_input="q",
            extra={"custom": 42},
        )
        assert ctx.extra.get("original_input") == "q", (
            "original_input must be present in merged extra"
        )
        assert ctx.extra.get("custom") == 42, "additional extra keys must survive merge"


# ---------------------------------------------------------------------------
# GuardrailContext.for_tool
# ---------------------------------------------------------------------------


class TestGuardrailContextForTool:
    """Tests for GuardrailContext.for_tool convenience constructor."""

    def test_guardrail_type_is_tool(self) -> None:
        """for_tool must set guardrail_type to 'tool'."""
        ctx = GuardrailContext.for_tool("search", {}, "agent", "corr")
        assert ctx.guardrail_type == "tool", "guardrail_type must be 'tool' for for_tool contexts"

    def test_tool_name_stored_in_extra(self) -> None:
        """tool_name must be accessible via extra['tool_name']."""
        ctx = GuardrailContext.for_tool("read_file", {"path": "/tmp/x"}, "agent", "corr")
        assert ctx.extra.get("tool_name") == "read_file", (
            "tool_name must be stored in extra['tool_name']"
        )

    def test_tool_params_stored_in_extra(self) -> None:
        """tool_params dict must be accessible via extra['tool_params']."""
        params = {"path": "/tmp/x", "limit": 100}
        ctx = GuardrailContext.for_tool("read_file", params, "agent", "corr")
        assert ctx.extra.get("tool_params") == params, (
            "tool_params must be stored in extra['tool_params']"
        )

    def test_content_is_json_serialised_params(self) -> None:
        """content must be the JSON serialisation of tool_params."""
        params = {"key": "value"}
        ctx = GuardrailContext.for_tool("tool", params, "agent", "corr")
        expected = json.dumps(params, ensure_ascii=False, default=str)
        assert ctx.content == expected, "content must be JSON-serialised tool_params"

    def test_extra_additional_keys_preserved(self) -> None:
        """Additional extra keys beyond tool_name/tool_params must be kept."""
        ctx = GuardrailContext.for_tool("tool", {}, "agent", "corr", extra={"custom": "data"})
        assert ctx.extra.get("custom") == "data", "extra custom keys must survive for_tool merge"

    def test_empty_params_produces_empty_json_object(self) -> None:
        """Empty tool_params dict must produce '{}' as content."""
        ctx = GuardrailContext.for_tool("noop", {}, "agent", "corr")
        assert ctx.content == "{}", "empty tool_params must produce '{}' as JSON content"


# ---------------------------------------------------------------------------
# ABC enforcement
# ---------------------------------------------------------------------------


class TestAbstractBaseClasses:
    """Tests that guardrail ABCs cannot be instantiated directly."""

    def test_input_guardrail_cannot_be_instantiated(self) -> None:
        """Directly instantiating InputGuardrail must raise TypeError."""
        with pytest.raises(TypeError, match="abstract"):
            InputGuardrail()  # type: ignore[abstract]

    def test_output_guardrail_cannot_be_instantiated(self) -> None:
        """Directly instantiating OutputGuardrail must raise TypeError."""
        with pytest.raises(TypeError, match="abstract"):
            OutputGuardrail()  # type: ignore[abstract]

    def test_tool_guardrail_cannot_be_instantiated(self) -> None:
        """Directly instantiating ToolGuardrail must raise TypeError."""
        with pytest.raises(TypeError, match="abstract"):
            ToolGuardrail()  # type: ignore[abstract]

    def test_input_guardrail_subclass_without_name_cannot_instantiate(self) -> None:
        """Subclass missing name property must not be instantiable."""

        class Incomplete(InputGuardrail):
            async def check(self, ctx: GuardrailContext) -> GuardrailResult:
                return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name="x")

        with pytest.raises(TypeError):
            Incomplete()  # type: ignore[abstract]

    def test_input_guardrail_subclass_without_check_cannot_instantiate(self) -> None:
        """Subclass missing check method must not be instantiable."""

        class Incomplete(InputGuardrail):
            @property
            def name(self) -> str:
                return "incomplete"

        with pytest.raises(TypeError):
            Incomplete()  # type: ignore[abstract]

    def test_concrete_input_guardrail_is_instantiable(self) -> None:
        """A fully concrete InputGuardrail subclass must be instantiable."""

        class ConcreteInput(InputGuardrail):
            @property
            def name(self) -> str:
                return "concrete_input"

            async def check(self, ctx: GuardrailContext) -> GuardrailResult:
                return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        instance = ConcreteInput()
        assert instance.name == "concrete_input", (
            "Concrete subclass must be instantiable and report correct name"
        )

    def test_concrete_output_guardrail_is_instantiable(self) -> None:
        """A fully concrete OutputGuardrail subclass must be instantiable."""

        class ConcreteOutput(OutputGuardrail):
            @property
            def name(self) -> str:
                return "concrete_output"

            async def check(self, ctx: GuardrailContext) -> GuardrailResult:
                return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        instance = ConcreteOutput()
        assert instance.name == "concrete_output", (
            "Concrete OutputGuardrail subclass must be instantiable"
        )

    def test_concrete_tool_guardrail_is_instantiable(self) -> None:
        """A fully concrete ToolGuardrail subclass must be instantiable."""

        class ConcreteTool(ToolGuardrail):
            @property
            def name(self) -> str:
                return "concrete_tool"

            async def check(self, ctx: GuardrailContext) -> GuardrailResult:
                return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        instance = ConcreteTool()
        assert instance.name == "concrete_tool", (
            "Concrete ToolGuardrail subclass must be instantiable"
        )
