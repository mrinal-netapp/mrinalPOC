"""Unit tests for :func:`agent_record_to_sk_agent`'s tool-linkage handling.

Covers the per-server tool whitelist (``Agent.mcpServerConfig[server].
allowedTools``) flowing from config-service into MAF's
``SKAgentDefinition.allowed_tools_by_server``. The MAF tool builder uses
that field to narrow a linked MCP server to the subset of tools the user
selected in the UI; without this conversion every tool on every linked
server would leak through.

The accompanying ``build_toolset`` tests live in ``test_maf_tools.py``.
"""

from __future__ import annotations

from typing import Any

from agent_service_maf.config.remote_adapter import (
    _extract_allowed_tools_by_server,
    agent_record_to_sk_agent,
)


class TestExtractAllowedToolsByServer:
    """The shape coercion that ``agent_record_to_sk_agent`` delegates to."""

    def test_non_dict_config_returns_empty(self) -> None:
        assert _extract_allowed_tools_by_server(None, ["srv-1"]) == {}
        assert _extract_allowed_tools_by_server("not-a-dict", ["srv-1"]) == {}  # type: ignore[arg-type]
        assert _extract_allowed_tools_by_server([], ["srv-1"]) == {}  # type: ignore[arg-type]

    def test_server_not_in_linked_ids_is_dropped(self) -> None:
        # A stale override pointing at a server the agent has since unlinked
        # must NOT reach MAF -- otherwise the tools would be exposed despite
        # the link being gone.
        config = {
            "srv-stale": {"allowedTools": ["t1"]},
            "srv-active": {"allowedTools": ["t2"]},
        }
        assert _extract_allowed_tools_by_server(config, ["srv-active"]) == {
            "srv-active": ["t2"],
        }

    def test_missing_allowed_tools_field_is_treated_as_unrestricted(self) -> None:
        # No ``allowedTools`` key at all → no entry produced. The server
        # remains in "all tools" mode in build_toolset.
        config = {"srv-1": {"permissions": ["read"]}}
        assert _extract_allowed_tools_by_server(config, ["srv-1"]) == {}

    def test_empty_allowed_tools_list_is_dropped(self) -> None:
        # Empty list reads as "no per-tool restriction set yet" (matches the
        # build_toolset tolerance test). It must NOT be forwarded as an
        # empty whitelist (which would deny every tool on the server).
        config = {"srv-1": {"allowedTools": []}}
        assert _extract_allowed_tools_by_server(config, ["srv-1"]) == {}

    def test_non_list_allowed_tools_is_dropped(self) -> None:
        # Defensive: jsonb storage could surface a malformed value (string,
        # dict, etc.). The helper must not propagate it.
        config: dict[str, Any] = {"srv-1": {"allowedTools": "weather"}}
        assert _extract_allowed_tools_by_server(config, ["srv-1"]) == {}

    def test_non_string_entries_are_filtered(self) -> None:
        # ``allowedTools: ["weather", 7, None, ""]`` → only the well-formed
        # name survives. An entirely-bad list collapses to no whitelist.
        config: dict[str, Any] = {
            "srv-1": {"allowedTools": ["weather", 7, None, ""]},
            "srv-2": {"allowedTools": [None, 5]},
        }
        result = _extract_allowed_tools_by_server(config, ["srv-1", "srv-2"])
        assert result == {"srv-1": ["weather"]}

    def test_snake_case_field_accepted(self) -> None:
        # Defensive: any caller that emits snake_case (e.g. an internal
        # composer) is honored alongside the canonical camelCase shape.
        config = {"srv-1": {"allowed_tools": ["t1"]}}
        assert _extract_allowed_tools_by_server(config, ["srv-1"]) == {"srv-1": ["t1"]}

    def test_camel_case_wins_when_both_present(self) -> None:
        # Mirrors the rest of the adapter's precedence (camelCase is the
        # canonical wire shape). Picking only one avoids accidentally
        # double-counting a whitelist entry that appears in both fields.
        config = {
            "srv-1": {
                "allowedTools": ["camel-one"],
                "allowed_tools": ["snake-one"],
            },
        }
        assert _extract_allowed_tools_by_server(config, ["srv-1"]) == {
            "srv-1": ["camel-one"],
        }


class TestAgentRecordToSkAgentTooling:
    """End-to-end: an agent record with ``mcpServerConfig`` lands as a
    proper ``allowed_tools_by_server`` on the SK agent dict."""

    def test_per_server_whitelist_round_trips(self) -> None:
        record = {
            "name": "alpha",
            "instructions": "be helpful",
            "model": "azure/gpt-4.1-mini",
            "mcpServerIds": ["weather_server", "kb_server"],
            "mcpServerConfig": {
                "weather_server": {
                    "permissions": ["read"],
                    "allowedTools": ["weather", "forecast"],
                },
                # No ``allowedTools`` → server stays unrestricted in MAF.
                "kb_server": {"permissions": ["read"]},
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["mcp_servers"] == ["weather_server", "kb_server"]
        assert sk["allowed_tools_by_server"] == {
            "weather_server": ["weather", "forecast"],
        }

    def test_missing_mcp_server_config_yields_empty(self) -> None:
        # Older agent records may have no override block at all -- the field
        # must default to empty so build_toolset stays in "expose all tools
        # on linked servers" mode.
        record = {
            "name": "alpha",
            "mcpServerIds": ["weather_server"],
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["allowed_tools_by_server"] == {}

    def test_override_for_unlinked_server_is_dropped(self) -> None:
        # Symmetry with the helper test: stale overrides for an unlinked
        # server must not survive the round-trip into MAF.
        record = {
            "name": "alpha",
            "mcpServerIds": ["weather_server"],
            "mcpServerConfig": {
                "weather_server": {"allowedTools": ["weather"]},
                "ghost_server": {"allowedTools": ["leaked"]},
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["allowed_tools_by_server"] == {"weather_server": ["weather"]}


class TestAgentRecordToSkAgentStructuredOutput:
    """The ``structuredOutput`` card maps to ``response_format`` /
    ``output_schema`` (json_object) or appended instructions (text)."""

    def test_json_object_parses_schema_string(self) -> None:
        record = {
            "name": "alpha",
            "instructions": "be helpful",
            "structuredOutput": {
                "enabled": True,
                "responseFormat": "json_object",
                "outputSchema": '{"type": "object", "properties": {"x": {"type": "string"}}}',
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["response_format"] == "json_object"
        assert sk["output_schema"] == {
            "type": "object",
            "properties": {"x": {"type": "string"}},
        }

    def test_json_object_malformed_schema_is_skipped(self) -> None:
        record = {
            "name": "alpha",
            "structuredOutput": {
                "enabled": True,
                "responseFormat": "json_object",
                "outputSchema": "{not valid json",
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["response_format"] == "json_object"
        assert "output_schema" not in sk

    def test_text_appends_guidelines_to_instructions(self) -> None:
        record = {
            "name": "alpha",
            "instructions": "You are a helpful agent.",
            "structuredOutput": {
                "enabled": True,
                "responseFormat": "text",
                "outputSchema": "Respond in bullet points.",
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert sk["response_format"] == "text"
        assert "output_schema" not in sk
        assert sk["instructions"] == (
            "You are a helpful agent.\n\nOutput format guidelines:\nRespond in bullet points."
        )

    def test_text_guidelines_applied_after_member_override(self) -> None:
        # A member ``instructions`` override wins over the agent default, and
        # the guidelines are appended on top of the override (not the default).
        record = {
            "name": "alpha",
            "instructions": "default instructions",
            "structuredOutput": {
                "enabled": True,
                "responseFormat": "text",
                "outputSchema": "Be terse.",
            },
        }
        sk = agent_record_to_sk_agent(
            record, member_overrides={"instructions": "override instructions"}
        )
        assert sk["instructions"] == (
            "override instructions\n\nOutput format guidelines:\nBe terse."
        )

    def test_disabled_card_sets_nothing(self) -> None:
        record = {
            "name": "alpha",
            "instructions": "be helpful",
            "structuredOutput": {
                "enabled": False,
                "responseFormat": "json_object",
                "outputSchema": '{"type": "object"}',
            },
        }
        sk = agent_record_to_sk_agent(record)
        assert "response_format" not in sk
        assert "output_schema" not in sk
        assert sk["instructions"] == "be helpful"

    def test_absent_card_sets_nothing(self) -> None:
        record = {"name": "alpha", "instructions": "be helpful"}
        sk = agent_record_to_sk_agent(record)
        assert "response_format" not in sk
        assert "output_schema" not in sk
