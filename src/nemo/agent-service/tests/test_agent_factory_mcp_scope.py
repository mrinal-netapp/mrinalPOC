"""Tests for MCP tool scoping in agent_factory."""

from collections import OrderedDict
from types import SimpleNamespace

from src.agent_factory import _mcp_configs_for_agent
from src.mcp_scope import (
    apply_mcp_tool_policy as _apply_mcp_tool_policy,
    bare_bifrost_tool_name as _bare_bifrost_tool_name,
    scope_mcp_toolkit_to_server as _scope_mcp_toolkit_to_server,
)


def _toolkit(*names: str, as_dict: bool = False):
    if as_dict:
        return SimpleNamespace(
            functions=OrderedDict((n, SimpleNamespace(name=n)) for n in names)
        )
    return SimpleNamespace(functions=[SimpleNamespace(name=n) for n in names])


def test_scope_mcp_toolkit_keeps_only_matching_bifrost_prefix():
    toolkit = _toolkit(
        "projA_server1_tool_a",
        "projA_server2_tool_b",
        "projA_server1_tool_c",
    )
    kept = _scope_mcp_toolkit_to_server(toolkit, "projA_server1")
    assert kept == 2
    assert [f.name for f in toolkit.functions] == [
        "projA_server1_tool_a",
        "projA_server1_tool_c",
    ]


def test_scope_mcp_toolkit_filters_agno_ordered_dict():
    toolkit = _toolkit(
        "projA_server1_tool_a",
        "projA_server2_tool_b",
        "projA_server1_tool_c",
        as_dict=True,
    )
    kept = _scope_mcp_toolkit_to_server(toolkit, "projA_server1")
    assert kept == 2
    assert list(toolkit.functions.keys()) == [
        "projA_server1_tool_a",
        "projA_server1_tool_c",
    ]


def test_apply_mcp_tool_policy_honors_allowed_tools_bare_names():
    toolkit = _toolkit("projA_server1_tool_a", "projA_server1_tool_b")
    kept = _apply_mcp_tool_policy(
        toolkit,
        "projA_server1",
        {"allowedTools": ["tool_a"]},
    )
    assert kept == 1
    assert toolkit.functions[0].name == "projA_server1_tool_a"


def test_apply_mcp_tool_policy_honors_allowed_tools_on_ordered_dict():
    toolkit = _toolkit(
        "projA_server1_tool_a",
        "projA_server1_tool_b",
        as_dict=True,
    )
    kept = _apply_mcp_tool_policy(
        toolkit,
        "projA_server1",
        {"allowedTools": ["tool_a"]},
    )
    assert kept == 1
    assert list(toolkit.functions.keys()) == ["projA_server1_tool_a"]


def test_apply_mcp_tool_policy_honors_disallowed_tools():
    toolkit = _toolkit("projA_server1_tool_a", "projA_server1_tool_b")
    kept = _apply_mcp_tool_policy(
        toolkit,
        "projA_server1",
        {"disallowedTools": ["tool_b"]},
    )
    assert kept == 1
    assert toolkit.functions[0].name == "projA_server1_tool_a"


def test_bare_bifrost_tool_name_strips_client_prefix():
    assert _bare_bifrost_tool_name("projA_server1_tool_a", "projA_server1") == "tool_a"


def test_mcp_configs_for_agent_uses_only_configured_server_ids():
    config = {
        "mcpServerIds": ["srv-a"],
        "_resolvedMCPServers": {
            "srv-a": {"name": "A", "llmproxyGatewayServerName": "proj_srv_a"},
            "srv-b": {"name": "B", "llmproxyGatewayServerName": "proj_srv_b"},
        },
    }
    configs = _mcp_configs_for_agent(config)
    assert len(configs) == 1
    assert configs[0]["llmproxyGatewayServerName"] == "proj_srv_a"
