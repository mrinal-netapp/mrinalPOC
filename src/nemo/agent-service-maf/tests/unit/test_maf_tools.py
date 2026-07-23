"""Phase 2 tests for the Microsoft Agent Framework adapter's tool support.

Exercises the AF function-invocation loop end-to-end through a scripted fake
``LLMGateway`` (no live Bifrost): the gateway returns a tool call on the first
turn and a final text answer on the second, so the
:class:`~agent_service_maf.framework.maf.gateway_chat_client.BifrostChatClient`
function-invocation layer must execute the tool and loop. Asserts the tool runs
and that ``toolExecutions`` citations (including ``kbCitations`` for KB tools)
match the SK adapter's wire contract.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Iterator
from typing import Annotated, Any

import pytest
import structlog
from structlog.testing import capture_logs


@contextlib.contextmanager
def capture_debug_logs() -> Iterator[list[dict[str, Any]]]:
    """``capture_logs`` that also sees DEBUG events.

    ``interface_layer.api`` configures a ``make_filtering_bound_logger(INFO)``
    at import time, whose ``.debug()`` is a compiled no-op. ``capture_logs``
    swaps the *processor* chain but leaves ``wrapper_class`` in place, so DEBUG
    events (e.g. ``tool_call_started``) would be dropped before reaching the
    capture. Temporarily restore a non-filtering ``BoundLogger`` for the
    duration of the capture, then put the app's wrapper back.
    """
    old_wrapper = structlog.get_config()["wrapper_class"]
    structlog.configure(wrapper_class=structlog.BoundLogger)
    try:
        with capture_logs() as cap:
            yield cap
    finally:
        structlog.configure(wrapper_class=old_wrapper)


from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    OrchestrationConfig,
    SemanticKernelSection,
    SKAgentDefinition,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import ToolUnauthorizedError
from agent_service_maf.core.interfaces import AgentEvent, AgentRequest, EventType, TokenUsage
from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.framework.maf.tools import build_toolset
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse
from agent_service_maf.tools.functions import FunctionToolResult, get_function, register_function

# ---------------------------------------------------------------------------
# Test tool functions (registered via an autouse fixture, since a sibling test
# module's autouse fixture wipes the function registry between modules)
# ---------------------------------------------------------------------------


async def _maf_test_kb(
    query: Annotated[str, "the search query"],
    *,
    params: dict[str, Any],
) -> FunctionToolResult:
    """A KB-style tool returning citations + a server-injected kbId."""
    return FunctionToolResult(
        text=f"found docs for {query}",
        kb_citations=[
            {
                "source": "doc.pdf",
                "documentId": "d1",
                "knowledgeBaseId": params.get("kbId"),
                "score": 0.9,
            }
        ],
        tool_type="kb",
        tokens_used=5,
    )


async def _maf_test_echo(
    text: Annotated[str, "text to echo"],
    *,
    params: dict[str, Any],
) -> str:
    """A plain-string tool (no citations)."""
    return f"echo: {text}"


@pytest.fixture(autouse=True)
def _register_test_functions() -> None:
    """Ensure the test tools are registered, idempotently.

    Other test modules wipe the global function registry via their own autouse
    fixtures, so registering at import time is not durable. This guarantees the
    functions exist for every test in this module regardless of ordering.
    """
    for name, fn in (("maf_test_kb", _maf_test_kb), ("maf_test_echo", _maf_test_echo)):
        if get_function(name) is None:
            register_function(name)(fn)


# ---------------------------------------------------------------------------
# Scripted fakes
# ---------------------------------------------------------------------------


class _ToolCallingGateway:
    """Fake gateway: returns a tool call first, then a final answer.

    Each ``complete`` / ``stream_complete`` round advances the script so the AF
    function-invocation loop drives exactly one tool execution.
    """

    def __init__(self, *, tool_name: str, arguments: str, final: str = "The answer is 42") -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self._tool_name = tool_name
        self._arguments = arguments
        self._final = final
        self.calls = 0
        self.tools_seen: list[dict[str, Any]] | None = None

    def _usage(self) -> TokenUsage:
        return TokenUsage(
            prompt_tokens=10, completion_tokens=5, total_tokens=15, estimated_cost_usd=0.0
        )

    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMCompletionResponse:
        self.calls += 1
        if self.calls == 1:
            self.tools_seen = tools
            return LLMCompletionResponse(
                content="",
                tool_calls=[
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": self._tool_name, "arguments": self._arguments},
                    }
                ],
                usage=self._usage(),
                model=model or "azure/gpt-4.1-mini",
            )
        return LLMCompletionResponse(
            content=self._final,
            tool_calls=[],
            usage=self._usage(),
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
        self.calls += 1
        if self.calls == 1:
            self.tools_seen = tools
            yield {
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": self._tool_name, "arguments": self._arguments},
                    }
                ],
                "finish_reason": "tool_calls",
            }
            return
        for piece in (self._final[:4], self._final[4:]):
            if piece:
                yield {"content": piece, "tool_calls": None, "finish_reason": None}
        yield {
            "content": "",
            "tool_calls": None,
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15, "cost": 0.0},
        }


class _FakeToolSchema:
    def __init__(self, name: str, server: str, input_schema: dict[str, Any]) -> None:
        self.name = name
        self.server_name = server
        self.description = f"{name} tool"
        self.input_schema = input_schema
        self.output_schema = None


class _FakeToolResult:
    def __init__(self, content: Any) -> None:  # noqa: ANN401
        self.content = content
        self.is_error = False
        self.raw = None


class _ScriptedGuardrails:
    """Minimal guardrail pipeline exposing only ``check_tool``.

    When ``deny`` is set, ``check_tool`` raises :class:`ToolUnauthorizedError`
    (a ``GuardrailError`` subclass) so the adapter's ``_build_auth_hook`` wrapper
    resolves the call to ``False`` -- the same path the real ``ToolAuthorizer``
    guardrail takes on a BLOCK verdict.
    """

    def __init__(self, *, deny: bool) -> None:
        self._deny = deny
        self.checked: list[tuple[str, dict[str, Any]]] = []

    async def check_tool(
        self,
        *,
        tool_name: str,
        tool_params: dict[str, Any],
        agent_id: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        self.checked.append((tool_name, dict(tool_params)))
        if self._deny:
            raise ToolUnauthorizedError(f"tool '{tool_name}' blocked by policy")


class _FakeMcpRegistry:
    """Minimal MCP registry exposing the discovery + call surface tools.py uses."""

    def __init__(self) -> None:
        self._schema = _FakeToolSchema(
            name="weather",
            server="weather_server",
            input_schema={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        )
        self.calls: list[dict[str, Any]] = []
        # tools.py reads ``mcp_registry.tool_registry`` for discovery.
        self.tool_registry = self

    def get_tools_for_server(self, server_name: str) -> list[_FakeToolSchema]:
        return [self._schema] if server_name == "weather_server" else []

    def get_all_tools(self) -> list[_FakeToolSchema]:
        return [self._schema]

    def get_default_arguments(self, server_name: str) -> dict[str, Any]:
        return {"units": "metric"}

    async def call_tool(
        self, *, server_name: str, tool_name: str, arguments: dict[str, Any]
    ) -> _FakeToolResult:
        self.calls.append(
            {"server_name": server_name, "tool_name": tool_name, "arguments": arguments}
        )
        return _FakeToolResult({"temp": 20, "city": arguments.get("city")})


class _TwoServerMcpRegistry:
    """Fake registry exposing two servers so per-agent scoping can be asserted.

    ``weather_server`` owns ``weather``; ``secret_server`` owns ``secret``. The
    team-wide ``get_all_tools`` returns both, but ``get_tools_for_server`` keeps
    them attributed so ``build_toolset`` can prove an agent only ever receives
    tools from servers it is configured to use.
    """

    def __init__(self) -> None:
        self._weather = _FakeToolSchema(
            name="weather",
            server="weather_server",
            input_schema={"type": "object", "properties": {}, "required": []},
        )
        self._secret = _FakeToolSchema(
            name="secret",
            server="secret_server",
            input_schema={"type": "object", "properties": {}, "required": []},
        )
        self.calls: list[dict[str, Any]] = []
        self.tool_registry = self

    def get_tools_for_server(self, server_name: str) -> list[_FakeToolSchema]:
        if server_name == "weather_server":
            return [self._weather]
        if server_name == "secret_server":
            return [self._secret]
        return []

    def get_all_tools(self) -> list[_FakeToolSchema]:
        return [self._weather, self._secret]

    def get_default_arguments(self, server_name: str) -> dict[str, Any]:
        return {}

    async def call_tool(
        self, *, server_name: str, tool_name: str, arguments: dict[str, Any]
    ) -> _FakeToolResult:
        self.calls.append(
            {"server_name": server_name, "tool_name": tool_name, "arguments": arguments}
        )
        return _FakeToolResult({"ok": True})


# ---------------------------------------------------------------------------
# Config / context helpers
# ---------------------------------------------------------------------------


def _config_with_function_binding() -> AgentConfig:
    return AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[
                SKAgentDefinition(
                    name="alpha",
                    instructions="be helpful",
                    model="azure/gpt-4.1-mini",
                    tool_bindings=["kb"],
                )
            ],
            orchestration=OrchestrationConfig(type="single"),
        ),
        tool_bindings=[
            {
                "name": "kb",
                "type": "function",
                "function_ref": "maf_test_kb",
                "description": "Search the knowledge base",
                "params": {"kbId": "kb-123"},
            }
        ],
    )


def _config_with_mcp() -> AgentConfig:
    return AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[
                SKAgentDefinition(
                    name="alpha",
                    instructions="be helpful",
                    model="azure/gpt-4.1-mini",
                    mcp_servers=["weather_server"],
                )
            ],
            orchestration=OrchestrationConfig(type="single"),
        ),
    )


def _ctx(
    config: AgentConfig,
    gateway: Any,  # noqa: ANN401
    mcp_registry: Any | None = None,  # noqa: ANN401
) -> AgentExecutionContext:
    return AgentExecutionContext(
        config=config,
        gateway=gateway,  # type: ignore[arg-type]
        mcp_registry=mcp_registry,
    )


def _request(input_text: str = "What docs mention X?") -> AgentRequest:
    return AgentRequest(agent_id="alpha", input=input_text)


async def _collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_invoke_runs_function_tool_and_records_kb_citations() -> None:
    config = _config_with_function_binding()
    # Tool is registered under binding.name ("kb"), NOT function_ref ("maf_test_kb").
    gw = _ToolCallingGateway(tool_name="kb", arguments='{"query": "X"}')
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request(), ctx)

    # The model called the tool, then produced the final answer (two LLM rounds).
    assert response.output == "The answer is 42"
    assert gw.calls == 2

    # The LLM-visible tool name is binding.name, not function_ref.
    assert gw.tools_seen is not None
    assert gw.tools_seen[0]["function"]["name"] == "kb"

    # ToolExecution citation parity with the SK adapter.
    citations = response.citations
    assert citations is not None
    trace = citations.agent_trace
    assert trace is not None and len(trace) == 1
    tool_execs = trace[0].tool_executions
    assert len(tool_execs) == 1
    execution = tool_execs[0]
    assert execution.tool_name == "kb"
    assert execution.tool_type == "kb"
    assert execution.result_summary == "found docs for X"
    assert execution.arguments == {"query": "X"}
    assert execution.tokens_used == 5
    assert execution.duration_ms is not None

    # KB citations were unpacked from the FunctionToolResult, incl. the
    # server-injected (LLM-invisible) kbId from the binding's params.
    assert execution.kb_citations is not None
    assert len(execution.kb_citations) == 1
    citation = execution.kb_citations[0]
    assert citation.source == "doc.pdf"
    assert citation.knowledge_base_id == "kb-123"


@pytest.mark.asyncio
async def test_invoke_runs_mcp_tool() -> None:
    config = _config_with_mcp()
    gw = _ToolCallingGateway(tool_name="weather", arguments='{"city": "Paris"}')
    registry = _FakeMcpRegistry()
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw, mcp_registry=registry)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("weather in Paris?"), ctx)

    assert response.output == "The answer is 42"
    assert len(registry.calls) == 1
    call = registry.calls[0]
    assert call["tool_name"] == "weather"
    assert call["server_name"] == "weather_server"
    # LLM-supplied arg plus server-wins default_arguments merged in.
    assert call["arguments"] == {"city": "Paris", "units": "metric"}

    citations = response.citations
    assert citations is not None
    tool_execs = citations.agent_trace[0].tool_executions
    assert len(tool_execs) == 1
    assert tool_execs[0].tool_name == "weather"
    assert tool_execs[0].tool_type == "toolset"
    assert tool_execs[0].kb_citations is None


@pytest.mark.asyncio
async def test_stream_runs_function_tool_and_records_citations() -> None:
    config = _config_with_function_binding()
    gw = _ToolCallingGateway(tool_name="kb", arguments='{"query": "X"}')
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    assert events[0].event_type == EventType.STARTED
    assert events[-1].event_type == EventType.COMPLETED

    tokens = [e.data for e in events if e.event_type == EventType.TOKEN]
    assert "".join(tokens) == "The answer is 42"

    invoke_response = events[-1].metadata["invokeResponse"]
    assert invoke_response["output"] == "The answer is 42"
    tool_execs = invoke_response["citations"]["agentTrace"][0]["toolExecutions"]
    assert len(tool_execs) == 1
    assert tool_execs[0]["toolName"] == "kb"
    assert tool_execs[0]["toolType"] == "kb"
    assert tool_execs[0]["kbCitations"][0]["source"] == "doc.pdf"


@pytest.mark.asyncio
async def test_mcp_tool_auth_hook_denial_blocks_call() -> None:
    """A denying guardrail gates the MCP call: ``call_tool`` is never reached.

    Parity with SK: the guardrail ``check_tool`` runs before the MCP call and a
    BLOCK verdict prevents execution. MAF diverges only in *surfacing* -- the
    denial is fed back to the model as an ``ERROR: ... denied`` tool result
    (soft-fail) rather than aborting the turn, so the run still completes.
    """
    config = _config_with_mcp()
    gw = _ToolCallingGateway(tool_name="weather", arguments='{"city": "Paris"}')
    registry = _FakeMcpRegistry()
    guardrails = _ScriptedGuardrails(deny=True)
    adapter = AgentFrameworkAdapter(config)
    ctx = AgentExecutionContext(
        config=config,
        gateway=gw,  # type: ignore[arg-type]
        mcp_registry=registry,
        guardrails=guardrails,  # type: ignore[arg-type]
    )
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("weather in Paris?"), ctx)

    # Security guarantee: the blocked tool never hit the MCP server.
    assert registry.calls == []
    # The guardrail was consulted for the weather tool.
    assert guardrails.checked == [("weather", {"city": "Paris"})]
    # Soft-fail: the run still completes (model got the denial as a tool result).
    assert response.output == "The answer is 42"
    assert gw.calls == 2

    # The denial is recorded in the trace as the tool's (error) result.
    tool_execs = response.citations.agent_trace[0].tool_executions
    assert len(tool_execs) == 1
    assert tool_execs[0].tool_name == "weather"
    assert "denied by authorization policy" in tool_execs[0].result_summary


@pytest.mark.asyncio
async def test_mcp_tool_auth_hook_allows_call() -> None:
    """An allowing guardrail lets the MCP call proceed (hook returns True)."""
    config = _config_with_mcp()
    gw = _ToolCallingGateway(tool_name="weather", arguments='{"city": "Paris"}')
    registry = _FakeMcpRegistry()
    guardrails = _ScriptedGuardrails(deny=False)
    adapter = AgentFrameworkAdapter(config)
    ctx = AgentExecutionContext(
        config=config,
        gateway=gw,  # type: ignore[arg-type]
        mcp_registry=registry,
        guardrails=guardrails,  # type: ignore[arg-type]
    )
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request("weather in Paris?"), ctx)

    assert response.output == "The answer is 42"
    # The guardrail approved and the MCP call executed with server-wins defaults.
    assert guardrails.checked == [("weather", {"city": "Paris"})]
    assert len(registry.calls) == 1
    assert registry.calls[0]["arguments"] == {"city": "Paris", "units": "metric"}


def test_build_toolset_derives_schema_hiding_keyword_only_params() -> None:
    """Function-tool schema exposes LLM-visible params and hides ``params``."""
    from agent_service_maf.tools.binding import parse_tool_bindings
    from agent_service_maf.tools.function_provider import FunctionToolProvider

    bindings = parse_tool_bindings(
        [
            {
                "name": "kb",
                "type": "function",
                "function_ref": "maf_test_kb",
                "description": "Search the knowledge base",
                "params": {"kbId": "kb-123"},
            }
        ]
    )
    provider = FunctionToolProvider(bindings=bindings)  # type: ignore[arg-type]
    agent_def = SKAgentDefinition(name="alpha", instructions="x", tool_bindings=["kb"])

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=provider,
        tool_bindings=bindings,
        mcp_registry=None,
    )

    assert len(toolset.tools) == 1
    spec = toolset.tools[0].to_json_schema_spec()
    # Tool name comes from binding.name, not function_ref.
    assert spec["function"]["name"] == "kb"
    params_schema = spec["function"]["parameters"]
    # Only ``query`` is exposed; the keyword-only ``params`` is hidden.
    assert set(params_schema["properties"]) == {"query"}
    assert params_schema["required"] == ["query"]
    assert params_schema["properties"]["query"]["type"] == "string"
    assert params_schema["properties"]["query"]["description"] == "the search query"


def test_build_toolset_scopes_tools_to_agent_configured_servers() -> None:
    """An agent only receives MCP tools from servers configured to it.

    The agent is wired to ``weather_server`` and *also* names ``secret`` in its
    ``tools`` whitelist -- but ``secret`` lives on ``secret_server``, which is
    NOT in the agent's ``mcp_servers``. The named tool must be dropped rather
    than satisfied from another agent's server in the shared team registry.
    """
    registry = _TwoServerMcpRegistry()
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="x",
        mcp_servers=["weather_server"],
        tools=["secret"],
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=None,
        tool_bindings=None,
        mcp_registry=registry,
    )

    names = {t.name for t in toolset.tools}
    # Only the configured server's tool is exposed; the cross-server name is dropped.
    assert names == {"weather"}
    assert "secret" not in names


class _MultiToolMcpRegistry:
    """Fake registry where one server owns several tools.

    Used to assert ``allowed_tools_by_server`` narrows a single linked server
    to a subset of its tools (the UI's per-tool selection contract).
    ``weather_server`` exposes three tools (``weather``, ``forecast``,
    ``alerts``); ``unrestricted_server`` exposes one (``ping``) so we can
    cover the "no whitelist for this server" branch in the same test setup.
    """

    def __init__(self) -> None:
        self._weather = _FakeToolSchema(
            name="weather", server="weather_server", input_schema=_empty()
        )
        self._forecast = _FakeToolSchema(
            name="forecast", server="weather_server", input_schema=_empty()
        )
        self._alerts = _FakeToolSchema(
            name="alerts", server="weather_server", input_schema=_empty()
        )
        self._ping = _FakeToolSchema(
            name="ping", server="unrestricted_server", input_schema=_empty()
        )
        self.tool_registry = self

    def get_tools_for_server(self, server_name: str) -> list[_FakeToolSchema]:
        if server_name == "weather_server":
            return [self._weather, self._forecast, self._alerts]
        if server_name == "unrestricted_server":
            return [self._ping]
        return []

    def get_default_arguments(self, server_name: str) -> dict[str, Any]:
        return {}


def _empty() -> dict[str, Any]:
    return {"type": "object", "properties": {}, "required": []}


def test_build_toolset_per_server_whitelist_restricts_to_named_tools() -> None:
    """``allowed_tools_by_server`` narrows a server to a subset of its tools.

    The linked ``weather_server`` exposes three tools but the agent's
    ``allowedTools`` (config-service per-server override) only lists
    ``weather``/``forecast``. The third tool (``alerts``) must not appear in
    the agent's toolset. This is the regression test for the reported bug
    where per-tool selection silently fell back to "all tools on this server".
    """
    registry = _MultiToolMcpRegistry()
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="x",
        mcp_servers=["weather_server"],
        allowed_tools_by_server={"weather_server": ["weather", "forecast"]},
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=None,
        tool_bindings=None,
        mcp_registry=registry,
    )

    names = {t.name for t in toolset.tools}
    assert names == {"weather", "forecast"}
    assert "alerts" not in names


def test_build_toolset_unrestricted_server_keeps_all_tools_when_other_server_is_restricted() -> (
    None
):
    """Per-server whitelist is local to that server.

    Mixed shape: ``weather_server`` is narrowed to ``weather`` only, but
    ``unrestricted_server`` has no entry in ``allowed_tools_by_server`` and
    must keep its full tool set. Guards against the obvious-looking bug
    where any non-empty per-server whitelist accidentally restricts every
    linked server.
    """
    registry = _MultiToolMcpRegistry()
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="x",
        mcp_servers=["weather_server", "unrestricted_server"],
        allowed_tools_by_server={"weather_server": ["weather"]},
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=None,
        tool_bindings=None,
        mcp_registry=registry,
    )

    names = {t.name for t in toolset.tools}
    # ``weather_server`` narrowed to ``weather`` only.
    assert "weather" in names
    assert "forecast" not in names
    assert "alerts" not in names
    # ``unrestricted_server`` retains every tool.
    assert "ping" in names


def test_build_toolset_empty_allowed_tools_entry_is_treated_as_no_restriction() -> None:
    """An empty whitelist must NOT silently deny every tool on the server.

    The UI persists ``allowedTools: []`` to mean "no override set yet" (the
    user landed on the per-server config screen and saved without picking
    anything). Treating that as "deny all" would surprise the user with a
    suddenly tool-less agent. The remote adapter already drops empty lists
    before they reach ``allowed_tools_by_server``, and ``build_toolset``
    also tolerates them defensively -- this test pins the latter.
    """
    registry = _MultiToolMcpRegistry()
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="x",
        mcp_servers=["weather_server"],
        allowed_tools_by_server={"weather_server": []},
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=None,
        tool_bindings=None,
        mcp_registry=registry,
    )

    names = {t.name for t in toolset.tools}
    assert names == {"weather", "forecast", "alerts"}


def test_build_toolset_per_server_whitelist_also_gates_named_tools_path() -> None:
    """``agent_def.tools`` (named whitelist) honors ``allowed_tools_by_server``.

    Without this gate, populating ``tools`` from another source could
    re-introduce a tool the operator explicitly removed from a server's
    ``allowedTools``. The named path must therefore intersect with the
    per-server whitelist when one is present.
    """
    registry = _MultiToolMcpRegistry()
    agent_def = SKAgentDefinition(
        name="alpha",
        instructions="x",
        mcp_servers=["weather_server"],
        # Per-server whitelist denies ``alerts``; the named ``tools`` field
        # naively re-lists it. Per-server gate must win.
        allowed_tools_by_server={"weather_server": ["weather"]},
        tools=["alerts"],
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=None,
        tool_bindings=None,
        mcp_registry=registry,
    )

    names = {t.name for t in toolset.tools}
    assert "weather" in names
    assert "alerts" not in names


@pytest.mark.asyncio
async def test_mcp_tool_call_time_refuses_unconfigured_server() -> None:
    """Defense-in-depth: the per-tool closure refuses an unconfigured server.

    Even if a tool whose ``server_name`` is outside the agent's configured set
    somehow reached the toolset, invoking it must never hit the MCP server --
    the refusal is surfaced as a soft-fail error result and recorded in the
    trace (same pattern as an auth-hook denial).
    """
    from agent_service_maf.framework.maf.tools import _make_mcp_tool

    registry = _TwoServerMcpRegistry()
    history: list[dict[str, Any]] = []
    # Build a tool for ``secret`` (on ``secret_server``) but only allow ``weather_server``.
    mcp_tool = _make_mcp_tool(registry._secret, registry, history, None, {"weather_server"})

    result = await mcp_tool.invoke(arguments={}, skip_parsing=True)

    assert isinstance(result, str)
    assert "not configured for this agent" in result
    # The blocked tool never reached the MCP server.
    assert registry.calls == []
    # The refusal is recorded in the trace as the tool's (error) result.
    assert len(history) == 1
    assert history[0]["tool_name"] == "secret"
    assert "error" in history[0]
    assert "not configured for this agent" in history[0]["result"]


# ---------------------------------------------------------------------------
# Deduplication and naming (core dual-KB fix)
# ---------------------------------------------------------------------------


def test_build_toolset_dedup_by_binding_name_not_function_ref() -> None:
    """Two KB bindings sharing the same function_ref but different names must
    both appear as distinct tools in the toolset.

    Before the fix, ``build_toolset`` deduplicated on ``binding.function_ref``
    (always ``"kb_retrieve"`` for every KB), so only the first KB was ever
    registered.  After the fix it deduplicates on ``binding.name`` — unique per
    KB — so both tools survive.
    """
    from agent_service_maf.tools.binding import parse_tool_bindings
    from agent_service_maf.tools.function_provider import FunctionToolProvider

    bindings = parse_tool_bindings(
        [
            {
                "name": "kb-retrieval-insurance",
                "type": "function",
                "function_ref": "maf_test_kb",
                "description": "Search the insurance KB",
                "params": {"kbId": "kb-insurance"},
            },
            {
                "name": "kb-retrieval-gcnv",
                "type": "function",
                "function_ref": "maf_test_kb",  # same function_ref as above
                "description": "Search the GCNV KB",
                "params": {"kbId": "kb-gcnv"},
            },
        ]
    )
    provider = FunctionToolProvider(bindings=bindings)  # type: ignore[arg-type]
    agent_def = SKAgentDefinition(
        name="dual",
        instructions="x",
        tool_bindings=["kb-retrieval-insurance", "kb-retrieval-gcnv"],
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=provider,
        tool_bindings=bindings,
        mcp_registry=None,
    )

    names = {t.name for t in toolset.tools}
    assert len(toolset.tools) == 2, (
        f"expected 2 distinct KB tools, got {len(toolset.tools)}: {names!r}"
    )
    assert "kb-retrieval-insurance" in names
    assert "kb-retrieval-gcnv" in names


def test_build_toolset_tool_name_uses_binding_name() -> None:
    """The LLM-visible tool name in the JSON schema spec equals binding.name,
    not binding.function_ref.  This is what the LLM uses in its tool_calls."""
    from agent_service_maf.tools.binding import parse_tool_bindings
    from agent_service_maf.tools.function_provider import FunctionToolProvider

    bindings = parse_tool_bindings(
        [
            {
                "name": "kb-retrieval-gcnv",
                "type": "function",
                "function_ref": "maf_test_kb",
                "description": "Search the GCNV KB",
                "params": {"kbId": "kb-gcnv"},
            }
        ]
    )
    provider = FunctionToolProvider(bindings=bindings)  # type: ignore[arg-type]
    agent_def = SKAgentDefinition(
        name="alpha", instructions="x", tool_bindings=["kb-retrieval-gcnv"]
    )

    toolset = build_toolset(
        agent_def=agent_def,
        function_provider=provider,
        tool_bindings=bindings,
        mcp_registry=None,
    )

    assert len(toolset.tools) == 1
    spec = toolset.tools[0].to_json_schema_spec()
    # Must be binding.name — not function_ref — so the LLM calls the right tool.
    assert spec["function"]["name"] == "kb-retrieval-gcnv"
    assert spec["function"]["name"] != "maf_test_kb"


# ---------------------------------------------------------------------------
# Structured logging
# ---------------------------------------------------------------------------


def test_build_toolset_logs_agent_toolset_built() -> None:
    """``build_toolset`` emits an INFO-level ``Built agent toolset`` log that
    includes the agent name and the exposed tool names."""
    from structlog.testing import capture_logs

    from agent_service_maf.tools.binding import parse_tool_bindings
    from agent_service_maf.tools.function_provider import FunctionToolProvider

    bindings = parse_tool_bindings(
        [
            {
                "name": "kb-retrieval-insurance",
                "type": "function",
                "function_ref": "maf_test_kb",
                "params": {"kbId": "kb-ins"},
            },
            {
                "name": "kb-retrieval-gcnv",
                "type": "function",
                "function_ref": "maf_test_kb",
                "params": {"kbId": "kb-gcnv"},
            },
        ]
    )
    provider = FunctionToolProvider(bindings=bindings)  # type: ignore[arg-type]
    agent_def = SKAgentDefinition(
        name="log-test-agent",
        instructions="x",
        tool_bindings=["kb-retrieval-insurance", "kb-retrieval-gcnv"],
    )

    with capture_logs() as cap:
        build_toolset(
            agent_def=agent_def,
            function_provider=provider,
            tool_bindings=bindings,
            mcp_registry=None,
        )

    built_events = [e for e in cap if e.get("event") == "Built agent toolset"]
    assert len(built_events) == 1, f"expected exactly one 'Built agent toolset' log; got {cap!r}"
    ev = built_events[0]
    assert ev["log_level"] == "info"
    assert ev["agent_name"] == "log-test-agent"
    assert len(ev["exposed_tool_names"]) == 2
    assert "kb-retrieval-insurance" in ev["exposed_tool_names"]
    assert "kb-retrieval-gcnv" in ev["exposed_tool_names"]


@pytest.mark.asyncio
async def test_function_tool_call_logs_started_and_completed() -> None:
    """A function-tool invocation emits DEBUG ``tool_call_started`` (arg keys
    only, no values) and INFO ``tool_call_completed`` with outcome fields."""
    from agent_service_maf.framework.maf.tools import _make_function_tool
    from agent_service_maf.tools.binding import parse_tool_bindings
    from agent_service_maf.tools.function_provider import FunctionToolProvider

    bindings = parse_tool_bindings(
        [
            {
                "name": "kb-retrieval-test",
                "type": "function",
                "function_ref": "maf_test_kb",
                "params": {"kbId": "kb-test"},
            }
        ]
    )
    provider = FunctionToolProvider(bindings=bindings)  # type: ignore[arg-type]
    history: list[dict[str, Any]] = []
    fn_tool = _make_function_tool(bindings[0], provider, history)

    with capture_debug_logs() as cap:
        await fn_tool.invoke(arguments={"query": "test query"}, skip_parsing=True)

    started = [e for e in cap if e.get("event") == "tool_call_started"]
    completed = [e for e in cap if e.get("event") == "tool_call_completed"]

    # tool_call_started → DEBUG (high frequency, off by default in prod)
    assert len(started) == 1
    assert started[0]["log_level"] == "debug"
    assert started[0]["tool_name"] == "kb-retrieval-test"
    assert started[0]["tool_kind"] == "function"
    # Only arg *keys* logged, never values (PII safety).
    assert started[0]["arg_keys"] == ["query"]

    # tool_call_completed → INFO (always-on outcome + latency signal)
    assert len(completed) == 1
    assert completed[0]["log_level"] == "info"
    assert completed[0]["tool_name"] == "kb-retrieval-test"
    assert completed[0]["tool_kind"] == "function"
    assert completed[0]["ok"] is True
    assert completed[0]["error"] is None
    assert isinstance(completed[0]["duration_ms"], int)
    assert isinstance(completed[0]["result_chars"], int)


@pytest.mark.asyncio
async def test_mcp_tool_call_logs_started_and_completed() -> None:
    """An MCP tool invocation emits DEBUG ``tool_call_started`` (arg keys only)
    and INFO ``tool_call_completed`` with server name and outcome fields."""
    from agent_service_maf.framework.maf.tools import _make_mcp_tool

    registry = _FakeMcpRegistry()
    history: list[dict[str, Any]] = []
    mcp_tool = _make_mcp_tool(registry._schema, registry, history, None, None)

    with capture_debug_logs() as cap:
        await mcp_tool.invoke(arguments={"city": "Berlin"}, skip_parsing=True)

    started = [e for e in cap if e.get("event") == "tool_call_started"]
    completed = [e for e in cap if e.get("event") == "tool_call_completed"]

    # tool_call_started → DEBUG
    assert len(started) == 1
    assert started[0]["log_level"] == "debug"
    assert started[0]["tool_name"] == "weather"
    assert started[0]["tool_kind"] == "mcp"
    assert started[0]["server"] == "weather_server"
    assert started[0]["arg_keys"] == ["city"]

    # tool_call_completed → INFO
    assert len(completed) == 1
    assert completed[0]["log_level"] == "info"
    assert completed[0]["tool_name"] == "weather"
    assert completed[0]["tool_kind"] == "mcp"
    assert completed[0]["server"] == "weather_server"
    assert completed[0]["ok"] is True
    assert completed[0]["error"] is None
    assert isinstance(completed[0]["duration_ms"], int)
