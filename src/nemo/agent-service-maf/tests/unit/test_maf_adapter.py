"""Phase 1 tests for the Microsoft Agent Framework adapter (single-agent path).

Exercises :class:`AgentFrameworkAdapter` end-to-end through a fake ``LLMGateway``
(no live Bifrost): builds a real AF agent via :class:`MafAgentBuilder`, runs the
agent's text/usage path through :class:`BifrostChatClient`, and asserts the wire
contract (output, usage, citations, SSE event ordering) matches what the SK adapter
produces for the same input.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest

from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    OrchestrationConfig,
    SemanticKernelSection,
    SKAgentDefinition,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.core.interfaces import AgentEvent, AgentRequest, EventType, TokenUsage
from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse


class _FakeGateway:
    """Mimics the slice of LLMGateway that BifrostChatClient depends on."""

    def __init__(self, content: str = "Hello from Bifrost") -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self.content = content
        self.last_messages: list[dict[str, Any]] | None = None
        self.last_model: str | None = None

    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMCompletionResponse:
        self.last_messages = messages
        self.last_model = model
        return LLMCompletionResponse(
            content=self.content,
            tool_calls=[],
            usage=TokenUsage(
                prompt_tokens=11,
                completion_tokens=7,
                total_tokens=18,
                estimated_cost_usd=0.0009,
            ),
            model=model or "azure/gpt-4.1-mini",
        )

    async def stream_complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        self.last_messages = messages
        self.last_model = model
        for piece in ("Hello", " from", " Bifrost"):
            yield {"content": piece, "tool_calls": None, "finish_reason": None}
        yield {
            "content": "",
            "tool_calls": None,
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "cost": 0.0009,
            },
        }


def _config(
    *,
    orchestration_type: str = "single",
    agents: list[SKAgentDefinition] | None = None,
    response_format: str | None = None,
) -> AgentConfig:
    if agents is None:
        agents = [
            SKAgentDefinition(
                name="alpha",
                instructions="be helpful",
                model="azure/gpt-4.1-mini",
                response_format=response_format,
            )
        ]
    return AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=agents,
            orchestration=OrchestrationConfig(type=orchestration_type),
        ),
    )


def _ctx(config: AgentConfig, gateway: _FakeGateway) -> AgentExecutionContext:
    return AgentExecutionContext(config=config, gateway=gateway)  # type: ignore[arg-type]


def _request(input_text: str = "Hi") -> AgentRequest:
    return AgentRequest(agent_id="alpha", input=input_text)


async def _collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


@pytest.mark.asyncio
async def test_invoke_single_returns_output_usage_and_citations() -> None:
    config = _config()
    gw = _FakeGateway()
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("Hi"), ctx)

    assert response.output == "Hello from Bifrost"
    assert response.usage is not None
    assert response.usage.total_tokens == 18
    assert response.metadata["orchestration_type"] == "single"
    assert response.metadata["model"] == "azure/gpt-4.1-mini"

    citations = response.citations
    assert citations is not None
    assert citations.responding_agent is not None
    assert citations.responding_agent.name == "alpha"
    assert citations.responding_agent.model == "gpt-4.1-mini"
    assert citations.responding_agent.framework == "maf"
    assert citations.performance is not None
    assert citations.performance.llm_call_count == 1

    # The agent's instructions reach the gateway as a leading system message.
    assert gw.last_messages is not None
    assert gw.last_messages[0] == {"role": "system", "content": "be helpful"}
    assert gw.last_messages[-1] == {"role": "user", "content": "Hi"}


@pytest.mark.asyncio
async def test_invoke_single_uses_model_display_name_in_citations() -> None:
    agents = [
        SKAgentDefinition(
            name="alpha",
            instructions="be helpful",
            model="azure/gpt-4.1-mini",
            model_display_name="GPT-4.1 Mini (Production)",
        )
    ]
    config = _config(agents=agents)
    gw = _FakeGateway()
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("Hi"), ctx)

    assert response.citations is not None
    assert response.citations.responding_agent is not None
    assert response.citations.responding_agent.model == "GPT-4.1 Mini (Production)"


@pytest.mark.asyncio
async def test_stream_single_event_ordering_and_invoke_response() -> None:
    config = _config()
    gw = _FakeGateway()
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request("Hi"), ctx))

    assert events[0].event_type == EventType.STARTED
    assert events[0].metadata["framework"] == "maf"
    assert events[-1].event_type == EventType.COMPLETED

    tokens = [e.data for e in events if e.event_type == EventType.TOKEN]
    assert "".join(tokens) == "Hello from Bifrost"

    invoke_response = events[-1].metadata["invokeResponse"]
    assert invoke_response["output"] == "Hello from Bifrost"
    assert invoke_response["usage"]["totalTokens"] == 18
    assert invoke_response["citations"]["respondingAgent"]["framework"] == "maf"

    # metadata must be populated on the streaming path (same keys as sync)
    assert invoke_response["metadata"]["orchestration_type"] == "single"
    assert invoke_response["metadata"]["agent_names"] == ["alpha"]
    assert invoke_response["metadata"]["model"] == "azure/gpt-4.1-mini"


@pytest.mark.asyncio
async def test_unknown_orchestration_raises() -> None:
    # Every named topology (sequential / concurrent / handoff / triage /
    # group_chat / magentic / graph) is supported; only unknown types raise.
    config = _config(
        orchestration_type="warp_drive",
        agents=[
            SKAgentDefinition(name="alpha", instructions="a"),
            SKAgentDefinition(name="beta", instructions="b"),
        ],
    )
    gw = _FakeGateway()
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    with pytest.raises(AgentInvocationError, match="Unknown orchestration type"):
        await adapter.invoke(_request("Hi"), ctx)


@pytest.mark.asyncio
async def test_initialize_requires_gateway() -> None:
    config = _config()
    adapter = AgentFrameworkAdapter(config)
    ctx = AgentExecutionContext(config=config)  # gateway is None

    with pytest.raises(AgentInvocationError, match="LLMGateway is required"):
        await adapter.initialize(ctx)


@pytest.mark.asyncio
async def test_invoke_parses_output_schema_when_expect_json() -> None:
    config = _config(response_format="json_object")
    gw = _FakeGateway(content='{"answer": 42}')
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("Hi"), ctx)

    assert response.output == '{"answer": 42}'
    assert response.parsed_output == {"answer": 42}


# ---------------------------------------------------------------------------
# Per-agent MCP scoping: x-bf-mcp-include-tools value computation.
#
# The project VK carries EVERY project MCP client in its mcp_configs (so the
# tool is reachable at all). Per-agent isolation therefore depends entirely on
# the per-request include header. These tests lock in the contract -- most
# importantly that an agent with NO configured MCP server yields an explicit
# deny-all ("") rather than None (which would omit the header and let Bifrost
# expand the full project VK scope into that agent).
# ---------------------------------------------------------------------------


def _agent_stub(
    mcp_servers: list[str] | None,
    allowed_tools_by_server: dict[str, list[str]] | None = None,
) -> Any:
    """Minimal stand-in exposing only the attrs the include-builder reads."""
    return SimpleNamespace(
        agent_def=SimpleNamespace(
            mcp_servers=list(mcp_servers or []),
            allowed_tools_by_server=allowed_tools_by_server or {},
        )
    )


def test_bifrost_include_value_none_only_without_project_id() -> None:
    # No project id -> header is not applicable and must NOT be sent.
    agents = [_agent_stub(["weather"])]
    assert AgentFrameworkAdapter._build_bifrost_mcp_include_value(agents, None) is None


def test_bifrost_include_value_deny_all_when_agent_has_no_mcp_servers() -> None:
    # project_id present but the agent links no MCP server: MUST be the empty
    # string (Bifrost "deny all"), never None. This is the fix for the
    # cross-agent leak -- an unconfigured agent must not inherit the VK's
    # full mcp_configs.
    agents = [_agent_stub([])]
    assert AgentFrameworkAdapter._build_bifrost_mcp_include_value(agents, "proj1") == ""


def test_bifrost_include_value_wildcard_for_unrestricted_server() -> None:
    agents = [_agent_stub(["weather"])]
    value = AgentFrameworkAdapter._build_bifrost_mcp_include_value(agents, "proj1")
    assert value == "proj1_weather-*"


def test_bifrost_include_value_scopes_to_allowed_tools() -> None:
    agents = [_agent_stub(["weather"], {"weather": ["get_forecast", "get_alerts"]})]
    value = AgentFrameworkAdapter._build_bifrost_mcp_include_value(agents, "proj1")
    assert value == "proj1_weather-get_forecast,proj1_weather-get_alerts"


def test_bifrost_include_value_unions_across_agents_with_dedup() -> None:
    agents = [
        _agent_stub(["weather"], {"weather": ["get_forecast"]}),
        _agent_stub(["weather", "search"], {"weather": ["get_forecast"]}),
    ]
    value = AgentFrameworkAdapter._build_bifrost_mcp_include_value(agents, "proj1")
    # get_forecast appears once (dedup); the unrestricted "search" is a wildcard.
    assert value == "proj1_weather-get_forecast,proj1_search-*"
