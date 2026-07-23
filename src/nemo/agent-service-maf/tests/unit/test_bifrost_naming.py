"""Tests for Bifrost aggregated MCP tool-name helpers."""

from agent_service_maf.mcp.bifrost_naming import (
    bifrost_prefixed_tool_name,
    is_aggregated_bifrost_mcp_url,
    resolve_bifrost_dispatch_name,
    strip_bifrost_tool_prefix,
    tool_belongs_to_bifrost_client,
)


def test_prefixed_tool_name_uses_underscore_by_default() -> None:
    assert bifrost_prefixed_tool_name("projA_weather", "get_forecast") == (
        "projA_weather_get_forecast"
    )


def test_prefixed_tool_name_preserves_existing_underscore_prefix() -> None:
    assert bifrost_prefixed_tool_name("projA_weather", "projA_weather_list_datasets") == (
        "projA_weather_list_datasets"
    )


def test_prefixed_tool_name_preserves_legacy_hyphen_prefix() -> None:
    assert bifrost_prefixed_tool_name("projXY_weather", "projXY_weather-get_forecast") == (
        "projXY_weather-get_forecast"
    )


def test_strip_bifrost_tool_prefix_underscore() -> None:
    assert strip_bifrost_tool_prefix("projA_srv_list_datasets", "projA_srv") == ("list_datasets")


def test_strip_bifrost_tool_prefix_hyphen() -> None:
    assert strip_bifrost_tool_prefix("projXY_weather-get_forecast", "projXY_weather") == (
        "get_forecast"
    )


def test_tool_belongs_rejects_sibling_client() -> None:
    assert tool_belongs_to_bifrost_client("projA_other_tool", "projA_weather") is False


def test_analytics_datasets_mcp_list_datasets_round_trip() -> None:
    """Platform analytics MCP uses underscore Bifrost wire names."""
    gateway = "analytics_datasets_mcp"
    wire = bifrost_prefixed_tool_name(gateway, "list_datasets")
    assert wire == "analytics_datasets_mcp_list_datasets"
    assert strip_bifrost_tool_prefix(wire, gateway) == "list_datasets"


def test_resolve_dispatch_name_prefers_underscore_then_legacy_hyphen() -> None:
    tools = {"projA_weather_get_forecast": object()}
    assert resolve_bifrost_dispatch_name("projA_weather", "get_forecast", tools) == (
        "projA_weather_get_forecast"
    )
    legacy_tools = {"projA_weather-get_forecast": object()}
    assert resolve_bifrost_dispatch_name("projA_weather", "get_forecast", legacy_tools) == (
        "projA_weather-get_forecast"
    )


def test_is_aggregated_bifrost_mcp_url() -> None:
    assert is_aggregated_bifrost_mcp_url("http://bifrost:4001/mcp") is True
    assert is_aggregated_bifrost_mcp_url("http://direct-upstream.example/mcp") is True
    assert is_aggregated_bifrost_mcp_url("http://weather.example/sse") is False
