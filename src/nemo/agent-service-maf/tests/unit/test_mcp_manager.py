"""Unit tests for MCPManager components.

Tests cover:
- MCPClientProtocol abstract base: raise NotImplementedError
- MCPConnectionManager: connect lifecycle with mock client
- MCPConnectionManager: disconnect_all
- MCPConnectionManager: connect_all with partial failures
- MCPDiscovery: discover_server registers tools in registry
- MCPToolInvoker: successful tool call
- MCPToolInvoker: argument validation via JSON Schema
- MCPToolInvoker: result size limit enforcement
- MCPToolInvoker: on_tool_call_start / on_tool_call_end hooks
- MCPToolInvoker: timeout handling
- MCPToolInvoker: McpError wrapping
- MCPHealthCheck: healthy ping
- MCPHealthCheck: failed ping
- MCPManager: async context manager
- MCPManager: lazy connect on call_tool
- MCPManager: raises MCPConnectionError when not connected and lazy_connect=False
- Secret redaction: _redact_value and _redact_dict
- Framework isolation: no framework imports in mcp module
"""

from __future__ import annotations

import asyncio
import contextlib
from contextlib import AsyncExitStack
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp import ClientSession, ClientSessionGroup, McpError
from mcp.types import INVALID_PARAMS as MCP_INVALID_PARAMS
from mcp.types import CallToolResult, ErrorData, TextContent, Tool

from agent_service_maf.config.validators import MCPSection
from agent_service_maf.core.exceptions import MCPConnectionError, MCPToolError
from agent_service_maf.mcp.config_loader import MCPServerConfig
from agent_service_maf.mcp.mcp_manager import (
    MCPClientProtocol,
    MCPConnectionManager,
    MCPDiscovery,
    MCPHealthCheck,
    MCPManager,
    MCPToolInvoker,
    _redact_dict,
    _redact_value,
)
from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolResult, ToolSchema
from agent_service_maf.mcp.transport_factory import TransportFactory

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def default_mcp_config(**overrides: Any) -> MCPSection:
    """Create an MCPSection with test-friendly defaults."""
    data: dict[str, Any] = {
        "connection_timeout_seconds": 10,
        "tool_call_timeout_seconds": 10,
        "lazy_connect": True,
        "discovery_on_connect": False,
        "max_tool_retries": 0,
        "retry_on_timeout": False,
        "max_concurrent_tool_calls": 5,
    }
    data.update(overrides)
    return MCPSection(**data)


def stdio_server_config(name: str = "test-server") -> MCPServerConfig:
    """Create a minimal stdio MCPServerConfig."""
    return MCPServerConfig(name=name, transport="stdio", command="npx")


def http_server_config(
    name: str,
    url: str = "http://bifrost.local/mcp",
    gateway_server_name: str | None = None,
) -> MCPServerConfig:
    """Create a streamable-http MCPServerConfig (Bifrost-multiplexed shape)."""
    return MCPServerConfig(
        name=name,
        transport="streamable-http",
        url=url,
        gateway_server_name=gateway_server_name,
    )


def make_tool_schema(
    name: str = "search",
    server_name: str = "web",
    input_schema: dict[str, Any] | None = None,
) -> ToolSchema:
    """Create a minimal ToolSchema."""
    return ToolSchema(
        name=name,
        description="Test tool",
        input_schema=input_schema or {"type": "object", "properties": {}},
        output_schema=None,
        server_name=server_name,
    )


def make_call_result(text: str = "result", is_error: bool = False) -> CallToolResult:
    """Create a CallToolResult with a single text block."""
    return CallToolResult(
        content=[TextContent(type="text", text=text)],
        isError=is_error,
    )


def make_mock_group(
    tools: dict[str, Any] | None = None,
    call_tool_result: CallToolResult | None = None,
    call_tool_side_effect: Exception | None = None,
) -> MagicMock:
    """Create a mock ClientSessionGroup."""
    group = MagicMock(spec=ClientSessionGroup)
    group.tools = tools or {}
    if call_tool_side_effect is not None:
        group.call_tool = AsyncMock(side_effect=call_tool_side_effect)
    else:
        group.call_tool = AsyncMock(return_value=call_tool_result or make_call_result())
    return group


# ---------------------------------------------------------------------------
# MCPClientProtocol — abstract base
# ---------------------------------------------------------------------------


class TestMCPClientProtocol:
    """Tests confirming MCPClientProtocol is an abstract base."""

    @pytest.mark.asyncio
    async def test_connect_raises_not_implemented(self) -> None:
        """MCPClientProtocol.connect() raises NotImplementedError."""
        protocol = MCPClientProtocol()
        with pytest.raises(NotImplementedError):
            await protocol.connect(MagicMock(), AsyncExitStack())

    @pytest.mark.asyncio
    async def test_list_tools_raises_not_implemented(self) -> None:
        """MCPClientProtocol.list_tools() raises NotImplementedError."""
        protocol = MCPClientProtocol()
        with pytest.raises(NotImplementedError):
            await protocol.list_tools(MagicMock())

    @pytest.mark.asyncio
    async def test_call_tool_raises_not_implemented(self) -> None:
        """MCPClientProtocol.call_tool() raises NotImplementedError."""
        protocol = MCPClientProtocol()
        with pytest.raises(NotImplementedError):
            await protocol.call_tool(MagicMock(), "tool", {})

    @pytest.mark.asyncio
    async def test_ping_raises_not_implemented(self) -> None:
        """MCPClientProtocol.ping() raises NotImplementedError."""
        protocol = MCPClientProtocol()
        with pytest.raises(NotImplementedError):
            await protocol.ping(MagicMock())


# ---------------------------------------------------------------------------
# MCPConnectionManager
# ---------------------------------------------------------------------------


class TestMCPConnectionManager:
    """Tests for MCPConnectionManager connection lifecycle."""

    def _make_manager(
        self,
        server_configs: list[MCPServerConfig] | None = None,
        **config_overrides: Any,
    ) -> MCPConnectionManager:
        cfg = default_mcp_config(**config_overrides)
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(return_value=MagicMock())
        return MCPConnectionManager(
            config=cfg,
            server_configs=server_configs or [],
            transport_factory=mock_transport,
        )

    def test_connected_servers_empty_initially(self) -> None:
        """connected_servers() returns empty list before any connections."""
        manager = self._make_manager()
        assert manager.connected_servers() == [], "no servers should be connected initially"

    def test_get_session_returns_none_for_unconnected(self) -> None:
        """get_session() returns None for a server that is not connected."""
        manager = self._make_manager()
        assert manager.get_session("web") is None, (
            "get_session must return None for unconnected server"
        )

    def test_get_group_returns_none_initially(self) -> None:
        """get_group() returns None before any connections."""
        manager = self._make_manager()
        assert manager.get_group() is None, (
            "get_group must return None before any connections are made"
        )

    @pytest.mark.asyncio
    async def test_connect_server_unknown_name_raises(self) -> None:
        """connect_server() raises MCPConnectionError for unknown server name."""
        manager = self._make_manager(server_configs=[])
        with pytest.raises(MCPConnectionError) as exc_info:
            await manager.connect_server("nonexistent-server")
        assert "nonexistent-server" in str(exc_info.value), (
            "MCPConnectionError must mention the unknown server name"
        )

    @pytest.mark.asyncio
    async def test_connect_all_skips_failed_servers(self) -> None:
        """connect_all() skips servers that fail to connect."""
        cfg = default_mcp_config()
        server_cfgs = [
            stdio_server_config("s1"),
            stdio_server_config("s2"),
        ]
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(return_value=MagicMock())

        manager = MCPConnectionManager(
            config=cfg,
            server_configs=server_cfgs,
            transport_factory=mock_transport,
        )

        # Patch _connect_one to fail for s1 but succeed for s2.
        call_count = {"n": 0}

        async def mock_connect_one(server_cfg: MCPServerConfig) -> None:
            call_count["n"] += 1
            if server_cfg.name == "s1":
                raise MCPConnectionError("s1 connection failed")
            manager._server_sessions[server_cfg.name] = MagicMock(spec=ClientSession)

        manager._connect_one = mock_connect_one  # type: ignore[method-assign]

        connected = await manager.connect_all()
        assert "s1" not in connected, "failed server s1 must not be in connected list"
        assert "s2" in connected, "successful server s2 must be in connected list"

    @pytest.mark.asyncio
    async def test_disconnect_all_clears_sessions(self) -> None:
        """disconnect_all() clears all session records and resets the group."""
        cfg = default_mcp_config()
        manager = MCPConnectionManager(
            config=cfg,
            server_configs=[],
        )
        # Manually add a session to simulate connected state.
        manager._server_sessions["web"] = MagicMock(spec=ClientSession)

        # Mock the exit stack.
        manager._exit_stack = AsyncMock()
        manager._exit_stack.aclose = AsyncMock()

        await manager.disconnect_all()
        assert manager.connected_servers() == [], (
            "all sessions must be cleared after disconnect_all"
        )
        assert manager.get_group() is None, "group must be None after disconnect_all"

    @pytest.mark.asyncio
    async def test_transport_contexts_enter_and_exit_in_owner_task(self) -> None:
        """Regression (100% CPU spin): MCP transport contexts must be entered
        AND exited in the single owner task — never the caller/SSE-finalizer —
        so anyio never raises "exit cancel scope in a different task".
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )
        tasks: dict[str, Any] = {}

        class _Recorder:
            async def __aenter__(self) -> _Recorder:
                tasks["enter"] = asyncio.current_task()
                return self

            async def __aexit__(self, *exc: object) -> bool:
                tasks["exit"] = asyncio.current_task()
                return False

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            await manager._exit_stack.enter_async_context(_Recorder())
            manager._server_sessions[server_cfg.name] = MagicMock(spec=ClientSession)

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]

        caller = asyncio.current_task()
        connected = await manager.connect_all()
        assert connected == ["s1"]
        assert tasks.get("enter") is not None
        assert tasks["enter"] is not caller, "context entered in caller task, not owner"
        assert tasks["enter"] is manager._owner_task, "context must be entered in the owner task"

        await manager.disconnect_all()
        assert tasks.get("exit") is tasks["enter"], (
            "context must be exited in the SAME task that entered it (no cross-task)"
        )

    @pytest.mark.asyncio
    async def test_owner_task_cancellation_tears_down_in_task(self) -> None:
        """Regression: cancelling the owner task (GC of an abandoned SSE
        bundle) must tear down transport contexts in-task, not raise the
        anyio cross-task RuntimeError.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )
        tasks: dict[str, Any] = {}

        class _Recorder:
            async def __aenter__(self) -> _Recorder:
                tasks["enter"] = asyncio.current_task()
                return self

            async def __aexit__(self, *exc: object) -> bool:
                tasks["exit"] = asyncio.current_task()
                return False

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            await manager._exit_stack.enter_async_context(_Recorder())

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()
        owner = manager._owner_task
        assert owner is not None

        owner.cancel()  # simulate GC-driven cancellation of an abandoned bundle
        with contextlib.suppress(asyncio.CancelledError):
            await owner
        assert tasks.get("exit") is tasks["enter"], (
            "teardown must run in the owner task even under cancellation"
        )

    @pytest.mark.asyncio
    async def test_owner_teardown_survives_recancel_during_close(self) -> None:
        """Finding: a cancellation surfacing *during* the exit-stack close must
        not leak transport contexts or skip the state reset. Every context is
        still exited IN-TASK and the manager state is reset afterwards (the close
        stays on the owner task — it is never shielded onto a separate one).
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )
        exits: dict[str, Any] = {}

        class _Recorder:
            def __init__(self, name: str, *, raise_cancel: bool = False) -> None:
                self._name = name
                self._raise_cancel = raise_cancel

            async def __aenter__(self) -> _Recorder:
                return self

            async def __aexit__(self, *exc: object) -> bool:
                exits[self._name] = asyncio.current_task()
                if self._raise_cancel:
                    raise asyncio.CancelledError  # re-cancel mid-close
                return False

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            # Enter A then B; aclose() exits B first (LIFO). B raises a
            # cancellation on its way out — A must still be exited.
            await manager._exit_stack.enter_async_context(_Recorder("A"))
            await manager._exit_stack.enter_async_context(_Recorder("B", raise_cancel=True))
            manager._server_sessions[server_cfg.name] = MagicMock(spec=ClientSession)

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()
        owner = manager._owner_task
        assert owner is not None

        await manager.disconnect_all()  # best-effort: swallows the owner cancel

        assert exits.get("A") is owner, "context A must still be exited after a re-cancel"
        assert exits.get("B") is owner, "cancel-raising context B is exited in the owner task"
        assert manager._server_sessions == {}, "state must be reset even under re-cancel"
        assert owner.done()

    @pytest.mark.asyncio
    async def test_disconnect_all_swallows_owner_task_error(self) -> None:
        """Finding: disconnect_all() must treat an owner task that ends with an
        unexpected (non-cancel) exception as best-effort teardown — log and
        continue clearing _owner_task, never re-raise into the shutdown /
        __aexit__ path.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )
        stop = asyncio.Event()

        async def failing_owner() -> None:
            await stop.wait()
            raise RuntimeError("owner blew up during teardown")

        manager._owner_task = asyncio.ensure_future(failing_owner())
        manager._stop_event = stop
        await asyncio.sleep(0)  # let the owner start and block on stop.wait()

        # Must return cleanly despite the owner task's RuntimeError.
        await manager.disconnect_all()
        assert manager._owner_task is None, "owner task must be cleared after disconnect"

    @pytest.mark.asyncio
    async def test_owner_idle_ttl_self_teardown(self) -> None:
        """With an idle TTL set (ephemeral/playground managers), the owner task
        self-tears-down after inactivity — belt-and-suspenders for an abandoned
        request that never signalled disconnect_all. Teardown stays in-task.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(),
            server_configs=[stdio_server_config("s1")],
            idle_ttl_seconds=0.05,
        )
        tasks: dict[str, Any] = {}

        class _Recorder:
            async def __aenter__(self) -> _Recorder:
                tasks["enter"] = asyncio.current_task()
                return self

            async def __aexit__(self, *exc: object) -> bool:
                tasks["exit"] = asyncio.current_task()
                return False

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            await manager._exit_stack.enter_async_context(_Recorder())

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()
        owner = manager._owner_task
        assert owner is not None and not owner.done()

        await asyncio.sleep(0.2)  # exceed the idle TTL with no activity
        assert owner.done(), "owner task must self-terminate after the idle TTL"
        assert tasks.get("exit") is tasks["enter"], "idle teardown must run in the owner task"

    @pytest.mark.asyncio
    async def test_owner_cancel_while_waiting_leaves_no_orphan_get_cmd(self) -> None:
        """Finding: cancelling the owner while it is blocked in asyncio.wait()
        must not orphan the in-flight cmd_queue.get() task.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            return None

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()  # owner now blocked on {get_cmd, stop_wait}
        owner = manager._owner_task
        assert owner is not None

        owner.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await owner
        await asyncio.sleep(0)  # let any scheduled cleanup run

        orphans = [
            t for t in asyncio.all_tasks() if t is not asyncio.current_task() and not t.done()
        ]
        assert orphans == [], f"owner teardown orphaned tasks: {orphans}"

    @pytest.mark.asyncio
    async def test_disconnect_all_reraises_caller_cancellation(self) -> None:
        """Finding: if the CALLER of disconnect_all() is cancelled (not the
        owner), it must re-raise rather than swallow — otherwise it returns early
        and clears _owner_task before the owner has finished its in-task teardown.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )
        release = asyncio.Event()
        in_teardown = asyncio.Event()

        class _SlowExit:
            async def __aenter__(self) -> _SlowExit:
                return self

            async def __aexit__(self, *exc: object) -> bool:
                in_teardown.set()
                await release.wait()  # hold the owner inside its in-task teardown
                return False

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            await manager._exit_stack.enter_async_context(_SlowExit())

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()
        owner = manager._owner_task
        assert owner is not None

        caller = asyncio.ensure_future(manager.disconnect_all())
        await in_teardown.wait()  # owner is now blocked in __aexit__ (mid-teardown)
        caller.cancel()  # cancel the CALLER, not the owner
        with contextlib.suppress(asyncio.CancelledError):
            await caller
        assert caller.cancelled(), "caller cancellation must propagate out of disconnect_all"
        assert manager._owner_task is owner, "owner task must NOT be cleared on caller cancel"

        release.set()  # let the owner finish its teardown in-task
        with contextlib.suppress(asyncio.CancelledError):
            await owner
        assert owner.done()

    @pytest.mark.asyncio
    async def test_drain_helper_swallows_futures_own_cancellation(self) -> None:
        """The teardown drain helper swallows the cancelled future's OWN
        CancelledError (owner not itself cancelled) so cleanup can continue.
        """

        async def runner() -> asyncio.CancelledError | None:
            fut = asyncio.ensure_future(asyncio.sleep(10))
            await asyncio.sleep(0)  # let it start
            fut.cancel()
            return await MCPConnectionManager._drain_cancelled_future(fut)

        assert await runner() is None

    @pytest.mark.asyncio
    async def test_drain_helper_preserves_owner_task_cancellation(self) -> None:
        """When the owner task ITSELF is under cancellation, the drain helper
        returns the CancelledError so the caller can re-raise it after teardown
        (finding: the old suppress(BaseException) consumed it silently).
        """
        captured: dict[str, Any] = {}

        async def runner() -> None:
            fut = asyncio.ensure_future(asyncio.sleep(10))
            asyncio.current_task().cancel()  # owner now under cancellation
            captured["result"] = await MCPConnectionManager._drain_cancelled_future(fut)
            fut.cancel()

        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.ensure_future(runner())
        assert isinstance(captured.get("result"), asyncio.CancelledError)

    @pytest.mark.asyncio
    async def test_drain_helper_does_not_swallow_base_exception(self) -> None:
        """Finding: the drain must catch only CancelledError, never a broad
        BaseException (so KeyboardInterrupt / SystemExit still propagate). Uses a
        custom BaseException subclass — KeyboardInterrupt/SystemExit get special
        event-loop handling that makes them unreliable to assert on directly.
        """

        class _FatalSignal(BaseException):
            pass

        async def boom() -> None:
            raise _FatalSignal("boom")

        fut = asyncio.ensure_future(boom())
        await asyncio.sleep(0)
        with pytest.raises(_FatalSignal):
            await MCPConnectionManager._drain_cancelled_future(fut)

    @pytest.mark.asyncio
    async def test_stop_fails_dequeued_and_queued_commands_no_hang(self) -> None:
        """Regression: when the owner stops with a just-dequeued command AND a
        still-queued command, both callers must fail fast (MCPConnectionError),
        never hang on ``await result``.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )

        async def fake_connect_one(server_cfg: MCPServerConfig) -> None:
            return None

        manager._connect_one = fake_connect_one  # type: ignore[method-assign]
        await manager.connect_all()  # owner now idle-waiting on {get_cmd, stop_wait}

        loop = asyncio.get_running_loop()
        q = manager._cmd_queue
        assert q is not None
        r1: asyncio.Future[list[str]] = loop.create_future()  # gets dequeued by get_cmd
        r2: asyncio.Future[list[str]] = loop.create_future()  # stays queued -> finally drain
        q.put_nowait(([stdio_server_config("a")], r1, False))
        q.put_nowait(([stdio_server_config("b")], r2, False))
        # Both a command and the stop are now pending in the SAME wait().
        assert manager._stop_event is not None
        manager._stop_event.set()

        await asyncio.sleep(0.05)  # let the owner wake, hit the stop branch, drain
        for fut in (r1, r2):
            assert fut.done(), "each pending command future must be resolved on stop"
            with pytest.raises(MCPConnectionError):
                fut.result()

    @pytest.mark.asyncio
    async def test_connect_server_propagates_connection_failure(self) -> None:
        """Regression: connect_server() must RAISE MCPConnectionError when the
        server fails to connect (contract of MCPManager.connect()), not swallow
        it like connect_all's skip-list.
        """
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )

        async def failing_connect_one(server_cfg: MCPServerConfig) -> None:
            raise MCPConnectionError("boom")

        manager._connect_one = failing_connect_one  # type: ignore[method-assign]
        with pytest.raises(MCPConnectionError, match="boom"):
            await manager.connect_server("s1")

    @pytest.mark.asyncio
    async def test_connect_all_still_skips_failed_servers(self) -> None:
        """connect_all() keeps its skip-and-continue contract (does not raise)."""
        manager = MCPConnectionManager(
            config=default_mcp_config(),
            server_configs=[stdio_server_config("s1"), stdio_server_config("s2")],
        )

        async def partial_connect_one(server_cfg: MCPServerConfig) -> None:
            if server_cfg.name == "s1":
                raise MCPConnectionError("s1 down")
            manager._server_sessions[server_cfg.name] = MagicMock(spec=ClientSession)

        manager._connect_one = partial_connect_one  # type: ignore[method-assign]
        connected = await manager.connect_all()
        assert connected == ["s2"]

    @pytest.mark.asyncio
    async def test_disconnect_then_connect_uses_fresh_owner_no_race(self) -> None:
        """Regression: disconnect_all keeps _owner_task until teardown completes,
        so a subsequent connect gets a fresh owner (no _exit_stack race)."""
        manager = MCPConnectionManager(
            config=default_mcp_config(), server_configs=[stdio_server_config("s1")]
        )

        async def ok_connect_one(server_cfg: MCPServerConfig) -> None:
            await manager._exit_stack.enter_async_context(AsyncExitStack())

        manager._connect_one = ok_connect_one  # type: ignore[method-assign]
        await manager.connect_all()
        first_owner = manager._owner_task
        await manager.disconnect_all()
        assert manager._owner_task is None, "owner cleared only after teardown"
        assert first_owner is not None and first_owner.done()
        # A fresh connect spins a brand-new owner (not the torn-down one).
        await manager.connect_all()
        assert manager._owner_task is not None and manager._owner_task is not first_owner

    # --- config getters ---------------------------------------------------

    def test_get_config_returns_match_or_none(self) -> None:
        """get_config() returns the matching config, or None for an unknown
        server / when no configs are loaded."""
        cfg = stdio_server_config("srv-a")
        manager = self._make_manager([cfg])
        assert manager.get_config("srv-a") is cfg
        assert manager.get_config("nope") is None
        assert self._make_manager([]).get_config("srv-a") is None

    def test_get_default_arguments_copy_or_empty(self) -> None:
        """get_default_arguments() returns a COPY of the server's defaults, and
        {} for unknown servers or servers without defaults."""
        with_defaults = MCPServerConfig(
            name="srv",
            transport="stdio",
            command="npx",
            default_arguments={"tenant": "acme"},
        )
        manager = self._make_manager([with_defaults, stdio_server_config("plain")])
        assert manager.get_default_arguments("srv") == {"tenant": "acme"}
        # mutating the returned dict must not corrupt the config
        manager.get_default_arguments("srv")["tenant"] = "mutated"
        assert manager.get_default_arguments("srv") == {"tenant": "acme"}
        assert manager.get_default_arguments("plain") == {}
        assert manager.get_default_arguments("unknown") == {}

    # --- _connect_one error mapping + service-token injection -------------

    def _mock_group(self, **kw: Any) -> MagicMock:
        group = MagicMock(spec=ClientSessionGroup)
        group.connect_to_server = AsyncMock(**kw)
        return group

    @pytest.mark.asyncio
    async def test_connect_one_timeout_maps_to_connection_error(self) -> None:
        """A connect TimeoutError is mapped to MCPConnectionError with a
        helpful 'timed out' message."""
        manager = self._make_manager([http_server_config("web")], connection_timeout_seconds=5)
        manager._ensure_group = AsyncMock(  # type: ignore[method-assign]
            return_value=self._mock_group(side_effect=TimeoutError)
        )
        with pytest.raises(MCPConnectionError, match="timed out"):
            await manager._connect_one(http_server_config("web"))

    @pytest.mark.asyncio
    async def test_connect_one_generic_error_maps_to_connection_error(self) -> None:
        """A generic transport/SDK error is wrapped as MCPConnectionError."""
        manager = self._make_manager([http_server_config("web")])
        manager._ensure_group = AsyncMock(  # type: ignore[method-assign]
            return_value=self._mock_group(side_effect=RuntimeError("boom"))
        )
        with pytest.raises(MCPConnectionError, match="Failed to connect"):
            await manager._connect_one(http_server_config("web"))

    @pytest.mark.asyncio
    async def test_connect_one_injects_service_token_authorization(self) -> None:
        """For HTTP transports with a configured service_token and no operator
        Authorization header, the connect-time headers get a Bearer token."""
        manager = self._make_manager([http_server_config("web")], service_token="svc-abc")
        manager._ensure_group = AsyncMock(  # type: ignore[method-assign]
            return_value=self._mock_group(return_value=MagicMock(spec=ClientSession))
        )
        await manager._connect_one(http_server_config("web"))
        built_cfg = manager._transport_factory.build.call_args.args[0]
        auth = [v for k, v in (built_cfg.headers or {}).items() if k.lower() == "authorization"]
        assert auth == ["Bearer svc-abc"]

    @pytest.mark.asyncio
    async def test_connect_one_preserves_operator_authorization(self) -> None:
        """An operator-supplied Authorization header is never overwritten, and
        the service token is not added as a duplicate auth header."""
        cfg = MCPServerConfig(
            name="web",
            transport="streamable-http",
            url="http://x/mcp",
            headers={"authorization": "Bearer operator"},
        )
        manager = self._make_manager([cfg], service_token="svc-abc")
        manager._ensure_group = AsyncMock(  # type: ignore[method-assign]
            return_value=self._mock_group(return_value=MagicMock(spec=ClientSession))
        )
        await manager._connect_one(cfg)
        built_cfg = manager._transport_factory.build.call_args.args[0]
        auth = [v for k, v in (built_cfg.headers or {}).items() if k.lower() == "authorization"]
        assert auth == ["Bearer operator"]

    @pytest.mark.asyncio
    async def test_owner_delivers_non_mcp_error_to_caller(self) -> None:
        """A non-MCPConnectionError raised inside the owner loop is delivered to
        the caller (via the BaseException guard) instead of hanging on await."""
        manager = self._make_manager([stdio_server_config("s1")])

        async def boom(server_cfg: MCPServerConfig) -> None:
            raise RuntimeError("unexpected")

        manager._connect_one = boom  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="unexpected"):
            await manager.connect_all()


# ---------------------------------------------------------------------------
# MCPConnectionManager — shared Bifrost endpoint dedup (regression)
# ---------------------------------------------------------------------------


class _FakeSharedGroup:
    """Mimics ``mcp.ClientSessionGroup`` for one aggregated Bifrost endpoint.

    The real SDK keys tools by name and raises ``McpError("... already exist
    in group tools.")`` if a second ``connect_to_server`` re-registers the same
    names. Since all of a project's servers point at the SAME ``/mcp`` URL and
    return the SAME aggregated tool list, the 2nd+ physical connect always
    collides — this fake reproduces exactly that.
    """

    def __init__(self) -> None:
        self.tools: dict[str, Any] = {}
        self.connect_calls = 0
        self._aggregated = {
            "projX_a-t1": Tool(name="projX_a-t1", inputSchema={"type": "object"}),
            "projX_b-t2": Tool(name="projX_b-t2", inputSchema={"type": "object"}),
        }

    async def connect_to_server(self, _params: Any) -> Any:
        self.connect_calls += 1
        duplicate = self._aggregated.keys() & self.tools.keys()
        if duplicate:
            raise McpError(
                ErrorData(
                    code=MCP_INVALID_PARAMS,
                    message=f"{duplicate} already exist in group tools.",
                )
            )
        self.tools.update(self._aggregated)
        return MagicMock(spec=ClientSession)


class TestSharedEndpointDedup:
    """Servers sharing one Bifrost ``/mcp`` URL must connect once and alias."""

    def _manager_with_fake_group(
        self, server_cfgs: list[MCPServerConfig]
    ) -> tuple[MCPConnectionManager, _FakeSharedGroup]:
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(return_value=MagicMock())
        manager = MCPConnectionManager(
            config=default_mcp_config(),
            server_configs=server_cfgs,
            transport_factory=mock_transport,
        )
        fake_group = _FakeSharedGroup()
        manager._group = fake_group  # type: ignore[assignment]
        return manager, fake_group

    @pytest.mark.asyncio
    async def test_shared_url_connects_once_and_aliases(self) -> None:
        cfgs = [
            http_server_config("a", gateway_server_name="projX_a"),
            http_server_config("b", gateway_server_name="projX_b"),
        ]
        manager, fake_group = self._manager_with_fake_group(cfgs)

        connected = await manager.connect_all()

        # The bug previously dropped 'b' with "already exist in group tools";
        # now both are connected and only one physical connect happened.
        assert set(connected) == {"a", "b"}
        assert fake_group.connect_calls == 1
        assert manager.get_session("a") is manager.get_session("b")

    @pytest.mark.asyncio
    async def test_distinct_urls_each_connect(self) -> None:
        cfgs = [
            http_server_config("a", url="http://bifrost.local/mcp"),
            http_server_config("c", url="http://other.local/mcp"),
        ]
        # Distinct URLs => distinct endpoints => two real connects. Use a fake
        # group whose aggregated set never collides across distinct params.
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(side_effect=lambda cfg: cfg.url)
        manager = MCPConnectionManager(
            config=default_mcp_config(),
            server_configs=cfgs,
            transport_factory=mock_transport,
        )
        calls: list[Any] = []

        class _DistinctGroup:
            tools: dict[str, Any] = {}

            async def connect_to_server(self, params: Any) -> Any:
                calls.append(params)
                return MagicMock(spec=ClientSession)

        manager._group = _DistinctGroup()  # type: ignore[assignment]

        connected = await manager.connect_all()
        assert set(connected) == {"a", "c"}
        assert len(calls) == 2, "distinct endpoints must each open a connection"

    def test_endpoint_key_stdio_is_none(self) -> None:
        assert MCPConnectionManager._endpoint_key(stdio_server_config("s")) is None

    def test_endpoint_key_same_url_matches(self) -> None:
        k1 = MCPConnectionManager._endpoint_key(http_server_config("a"))
        k2 = MCPConnectionManager._endpoint_key(http_server_config("b"))
        assert k1 is not None and k1 == k2

    def test_endpoint_key_distinct_url_differs(self) -> None:
        k1 = MCPConnectionManager._endpoint_key(http_server_config("a", url="http://x/mcp"))
        k2 = MCPConnectionManager._endpoint_key(http_server_config("b", url="http://y/mcp"))
        assert k1 != k2


# ---------------------------------------------------------------------------
# MCPDiscovery
# ---------------------------------------------------------------------------


class TestMCPDiscovery:
    """Tests for MCPDiscovery tool discovery."""

    def _make_mcp_tool(self, name: str, description: str = "A tool") -> Tool:
        """Create an mcp.types.Tool for testing."""
        return Tool(
            name=name,
            description=description,
            inputSchema={"type": "object", "properties": {}},
        )

    @pytest.mark.asyncio
    async def test_discover_server_registers_tools_in_registry(self) -> None:
        """discover_server() registers all tools from the group in the registry."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        tool1 = self._make_mcp_tool("search")
        tool2 = self._make_mcp_tool("fetch")

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {
            "web.search": tool1,
            "web.fetch": tool2,
        }

        schemas = await discovery.discover_server("web", mock_group)
        assert len(schemas) == 2, "discover_server must return 2 schemas"
        assert registry.tool_count == 2, "registry must have 2 tools after discovery"

    @pytest.mark.asyncio
    async def test_discover_server_sets_server_name(self) -> None:
        """discover_server() tags all tools with the given server_name."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {"db.query": self._make_mcp_tool("query")}

        schemas = await discovery.discover_server("db", mock_group)
        assert schemas[0].server_name == "db", (
            "discovered tool must be tagged with server_name 'db'"
        )

    @pytest.mark.asyncio
    async def test_discover_server_empty_tools(self) -> None:
        """discover_server() returns empty list when group has no tools."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {}

        schemas = await discovery.discover_server("empty-server", mock_group)
        assert schemas == [], "empty group must yield empty schema list"
        assert registry.tool_count == 0, (
            "registry must remain empty after discovering from empty group"
        )

    @pytest.mark.asyncio
    async def test_discover_all_calls_discover_server_per_server(self) -> None:
        """discover_all() discovers from each server in the list."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {
            "s1.tool_a": self._make_mcp_tool("tool_a"),
        }

        results = await discovery.discover_all(["s1", "s2"], mock_group)
        assert "s1" in results, "discover_all result must include 's1'"
        assert "s2" in results, "discover_all result must include 's2'"

    @pytest.mark.asyncio
    async def test_discover_server_stores_description(self) -> None:
        """discover_server() stores tool description from mcp.types.Tool."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        tool = self._make_mcp_tool("search", description="Search the web thoroughly")
        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {"web.search": tool}

        schemas = await discovery.discover_server("web", mock_group)
        assert schemas[0].description == "Search the web thoroughly", (
            "tool description must be preserved during discovery"
        )

    @pytest.mark.asyncio
    async def test_discover_server_bifrost_prefix_filters_and_strips(self) -> None:
        """When ``gateway_server_name`` is set, the discovery treats the group
        as a Bifrost-multiplexed aggregate: it keeps only tools whose name
        starts with ``<gateway_server_name>-`` and strips that prefix when
        registering them, so the LLM sees clean tool names. Tools from other
        Bifrost clients sharing the same aggregated session are dropped — the
        agent only sees the tools attached to ITS server."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        weather_a = self._make_mcp_tool("projXY_weather-get_forecast", description="forecast")
        weather_b = self._make_mcp_tool("projXY_weather-search_locations", description="search")
        github_a = self._make_mcp_tool("projXY_github-list_pull_requests", description="prs")
        unrelated = self._make_mcp_tool("not_prefixed_at_all", description="x")

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {t.name: t for t in (weather_a, weather_b, github_a, unrelated)}

        schemas = await discovery.discover_server(
            "weather", mock_group, gateway_server_name="projXY_weather"
        )

        # Only weather's two tools survive the prefix filter.
        names = sorted(s.name for s in schemas)
        assert names == ["get_forecast", "search_locations"], (
            f"prefix filter must keep only projXY_weather-* tools and strip "
            f"the prefix; got {names!r}"
        )
        # Tagged under the friendly server name (what the agent referenced).
        assert all(s.server_name == "weather" for s in schemas)
        # github tool from the same aggregated session does NOT leak in.
        for s in schemas:
            assert "github" not in s.name and "github" not in (s.description or "")

    @pytest.mark.asyncio
    async def test_discover_server_bifrost_prefix_skips_unmatched_session(
        self,
    ) -> None:
        """No matching prefixes → empty schema list, no registry entries.

        Catches the case where ``gateway_server_name`` is wrong / stale or
        Bifrost hasn't registered the upstream yet; we'd rather see an
        empty tool surface than silently expose another server's tools."""
        registry = ToolRegistry()
        discovery = MCPDiscovery(registry)

        mock_group = MagicMock(spec=ClientSessionGroup)
        mock_group.tools = {
            "projXY_github-list_issues": self._make_mcp_tool("projXY_github-list_issues"),
        }
        schemas = await discovery.discover_server(
            "weather", mock_group, gateway_server_name="projXY_weather"
        )
        assert schemas == []
        assert registry.tool_count == 0


# ---------------------------------------------------------------------------
# MCPToolInvoker
# ---------------------------------------------------------------------------


class TestMCPToolInvoker:
    """Tests for MCPToolInvoker.call_tool()."""

    def _make_invoker(
        self,
        registry: ToolRegistry | None = None,
        on_tool_call_start: Any = None,
        on_tool_call_end: Any = None,
        **config_overrides: Any,
    ) -> MCPToolInvoker:
        cfg = default_mcp_config(**config_overrides)
        return MCPToolInvoker(
            config=cfg,
            tool_registry=registry or ToolRegistry(),
            on_tool_call_start=on_tool_call_start,
            on_tool_call_end=on_tool_call_end,
        )

    @pytest.mark.asyncio
    async def test_successful_tool_call_returns_tool_result(self) -> None:
        """Successful call_tool() returns a ToolResult with expected content."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=make_call_result("Hello World"))

        result = await invoker.call_tool("web", "search", {}, group)
        assert isinstance(result, ToolResult), "must return a ToolResult"
        assert result.content == "Hello World", (
            "ToolResult.content must equal the text from the CallToolResult"
        )

    @pytest.mark.asyncio
    async def test_call_tool_reprefixes_dispatch_when_bifrost_multiplexed(
        self,
    ) -> None:
        """When ``gateway_server_name`` is set, the invoker must re-prefix the
        bare tool name with ``<gateway_server_name>-`` before dispatching to
        the group. Bifrost's aggregated `/mcp` only knows the full prefixed
        name; an un-prefixed call would 404 at the group level."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=make_call_result("forecast: 21C"))

        result = await invoker.call_tool(
            "weather",
            "get_forecast",
            {"city": "Seattle"},
            group,
            gateway_server_name="projXY_weather",
        )
        assert result.content == "forecast: 21C"
        # The group.call_tool dispatch must have received the prefixed name.
        group.call_tool.assert_awaited_once()
        sent_name = group.call_tool.await_args.args[0]
        assert sent_name == "projXY_weather-get_forecast", (
            f"dispatch must re-prefix bare tool name; got {sent_name!r}"
        )

    @pytest.mark.asyncio
    async def test_call_tool_no_reprefix_when_gateway_name_absent(self) -> None:
        """File-source / direct-session servers (no ``gateway_server_name``)
        must dispatch the bare tool name unchanged — they aren't multiplexed
        behind Bifrost, so prefixing would mangle the call."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=make_call_result("ok"))

        await invoker.call_tool("web", "search", {}, group)
        sent_name = group.call_tool.await_args.args[0]
        assert sent_name == "search", (
            f"bare-mode dispatch must use the bare tool name; got {sent_name!r}"
        )

    @pytest.mark.asyncio
    async def test_successful_tool_call_is_error_false(self) -> None:
        """Successful call produces ToolResult with is_error=False."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=make_call_result(is_error=False))

        result = await invoker.call_tool("web", "search", {}, group)
        assert result.is_error is False, "is_error must be False for successful call"

    @pytest.mark.asyncio
    async def test_error_result_from_server_propagated(self) -> None:
        """ToolResult.is_error=True when MCP server reports error."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=make_call_result("error msg", is_error=True))

        result = await invoker.call_tool("web", "search", {}, group)
        assert result.is_error is True, "server-reported error must set ToolResult.is_error=True"

    @pytest.mark.asyncio
    async def test_raw_is_stored_in_tool_result(self) -> None:
        """ToolResult.raw holds the original CallToolResult."""
        raw = make_call_result("data")
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_result=raw)

        result = await invoker.call_tool("web", "search", {}, group)
        assert result.raw is raw, "ToolResult.raw must be the original CallToolResult"

    @pytest.mark.asyncio
    async def test_on_tool_call_start_hook_fired(self) -> None:
        """on_tool_call_start hook is called before the tool invocation."""
        start_calls: list[tuple[str, str, dict]] = []

        async def on_start(server: str, tool: str, args: dict) -> None:
            start_calls.append((server, tool, args))

        invoker = self._make_invoker(on_tool_call_start=on_start)
        group = make_mock_group()

        await invoker.call_tool("web", "search", {"q": "test"}, group)
        assert len(start_calls) == 1, "on_tool_call_start must be called once"
        assert start_calls[0] == ("web", "search", {"q": "test"}), (
            "hook must receive correct server, tool, and args"
        )

    @pytest.mark.asyncio
    async def test_on_tool_call_end_hook_fired(self) -> None:
        """on_tool_call_end hook is called after the tool invocation."""
        end_calls: list[tuple[str, str, ToolResult]] = []

        async def on_end(server: str, tool: str, result: ToolResult) -> None:
            end_calls.append((server, tool, result))

        invoker = self._make_invoker(on_tool_call_end=on_end)
        group = make_mock_group(call_tool_result=make_call_result("output"))

        result = await invoker.call_tool("web", "search", {}, group)
        assert len(end_calls) == 1, "on_tool_call_end must be called once"
        assert end_calls[0][0] == "web", "hook must receive server name"
        assert end_calls[0][1] == "search", "hook must receive tool name"
        assert end_calls[0][2] is result, "hook must receive the ToolResult"

    @pytest.mark.asyncio
    async def test_no_hooks_does_not_raise(self) -> None:
        """call_tool() with no hooks set does not raise any errors."""
        invoker = self._make_invoker()
        group = make_mock_group()
        result = await invoker.call_tool("web", "search", {}, group)
        assert result is not None, "call without hooks must still return a result"

    @pytest.mark.asyncio
    async def test_argument_validation_fails_for_bad_schema(self) -> None:
        """call_tool() raises MCPToolError when arguments fail JSON Schema validation."""
        registry = ToolRegistry()
        schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        registry.register(make_tool_schema(name="search", server_name="web", input_schema=schema))

        invoker = self._make_invoker(registry=registry)
        group = make_mock_group()

        # Provide an integer instead of required string
        with pytest.raises(MCPToolError) as exc_info:
            await invoker.call_tool("web", "search", {"query": 123}, group)
        assert "search" in str(exc_info.value) or "Invalid" in str(exc_info.value), (
            "MCPToolError must mention the tool name or 'Invalid'"
        )

    @pytest.mark.asyncio
    async def test_argument_validation_passes_for_valid_args(self) -> None:
        """call_tool() passes when arguments satisfy the JSON Schema."""
        registry = ToolRegistry()
        schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        registry.register(make_tool_schema(name="search", server_name="web", input_schema=schema))

        invoker = self._make_invoker(registry=registry)
        group = make_mock_group(call_tool_result=make_call_result("result"))

        result = await invoker.call_tool("web", "search", {"query": "hello"}, group)
        assert result.content == "result", "valid arguments must result in successful tool call"

    @pytest.mark.asyncio
    async def test_no_schema_skips_validation(self) -> None:
        """call_tool() skips validation when no tool schema is registered."""
        # Empty registry — no schema available.
        invoker = self._make_invoker(registry=ToolRegistry())
        group = make_mock_group(call_tool_result=make_call_result("ok"))

        # Should not raise even with no schema available.
        result = await invoker.call_tool("web", "search", {"any": "data"}, group)
        assert result is not None, (
            "call must succeed when no schema is registered (skip validation)"
        )

    @pytest.mark.asyncio
    async def test_result_size_limit_exceeded_raises(self) -> None:
        """call_tool() raises MCPToolError when result exceeds size limit."""
        invoker = self._make_invoker()
        # Generate a result that exceeds 10 MiB
        oversized_text = "x" * (10 * 1024 * 1024 + 1)
        group = make_mock_group(call_tool_result=make_call_result(oversized_text))

        with pytest.raises(MCPToolError) as exc_info:
            await invoker.call_tool("web", "search", {}, group)
        error_msg = str(exc_info.value)
        assert "bytes" in error_msg or "limit" in error_msg or "size" in error_msg, (
            "MCPToolError for oversized result must mention size/bytes/limit"
        )

    @pytest.mark.asyncio
    async def test_result_within_size_limit_succeeds(self) -> None:
        """call_tool() succeeds when result is within the size limit."""
        invoker = self._make_invoker()
        # 1 MiB — well within the 10 MiB limit
        normal_text = "x" * (1024 * 1024)
        group = make_mock_group(call_tool_result=make_call_result(normal_text))

        result = await invoker.call_tool("web", "search", {}, group)
        assert result is not None, "result within size limit must succeed"

    @pytest.mark.asyncio
    async def test_mcp_error_raises_mcp_tool_error(self) -> None:
        """McpError from the SDK is wrapped in MCPToolError."""
        from mcp import McpError
        from mcp.types import ErrorData

        invoker = self._make_invoker()
        error = McpError(error=ErrorData(code=500, message="Internal error"))
        group = make_mock_group(call_tool_side_effect=error)

        with pytest.raises(MCPToolError) as exc_info:
            await invoker.call_tool("web", "search", {}, group)
        assert exc_info.value.server_name == "web", "MCPToolError.server_name must be set to 'web'"
        assert exc_info.value.tool_name == "search", (
            "MCPToolError.tool_name must be set to 'search'"
        )

    @pytest.mark.asyncio
    async def test_key_error_raises_mcp_tool_error(self) -> None:
        """KeyError (tool not in group) is wrapped in MCPToolError."""
        invoker = self._make_invoker()
        group = make_mock_group(call_tool_side_effect=KeyError("search"))

        with pytest.raises(MCPToolError) as exc_info:
            await invoker.call_tool("web", "search", {}, group)
        assert "search" in str(exc_info.value) or "registered" in str(exc_info.value), (
            "MCPToolError for KeyError must mention the tool name or 'registered'"
        )

    @pytest.mark.asyncio
    async def test_timeout_raises_mcp_tool_error(self) -> None:
        """TimeoutError from asyncio.timeout is wrapped in MCPToolError."""
        invoker = self._make_invoker(tool_call_timeout_seconds=1)
        group = make_mock_group(call_tool_side_effect=TimeoutError())

        with pytest.raises(MCPToolError) as exc_info:
            await invoker.call_tool("web", "search", {}, group)
        error_msg = str(exc_info.value).lower()
        assert "timeout" in error_msg or "timed out" in error_msg, (
            "MCPToolError for timeout must mention timeout"
        )


# ---------------------------------------------------------------------------
# MCPToolInvoker — _extract_content
# ---------------------------------------------------------------------------


class TestMCPToolInvokerExtractContent:
    """Tests for the _extract_content static method."""

    def test_text_content_extracted(self) -> None:
        """TextContent blocks are extracted as plain strings."""
        raw = make_call_result("Hello from tool")
        content = MCPToolInvoker._extract_content(raw)
        assert content == "Hello from tool", "text content must be extracted as a plain string"

    def test_multiple_text_blocks_joined_with_newline(self) -> None:
        """Multiple text blocks are joined with newlines."""
        raw = CallToolResult(
            content=[
                TextContent(type="text", text="Line 1"),
                TextContent(type="text", text="Line 2"),
            ],
            isError=False,
        )
        content = MCPToolInvoker._extract_content(raw)
        assert content == "Line 1\nLine 2", "multiple text blocks must be joined with newlines"

    def test_structured_content_returned_when_present(self) -> None:
        """structuredContent takes priority when set."""
        structured = {"key": "value", "count": 42}
        raw = CallToolResult(
            content=[TextContent(type="text", text="ignored")],
            isError=False,
            structuredContent=structured,
        )
        content = MCPToolInvoker._extract_content(raw)
        assert content == structured, "structuredContent must be returned when available"

    def test_image_content_placeholder(self) -> None:
        """Image content blocks produce a placeholder string."""
        from mcp.types import ImageContent

        raw = CallToolResult(
            content=[ImageContent(type="image", mimeType="image/png", data="base64data")],
            isError=False,
        )
        content = MCPToolInvoker._extract_content(raw)
        assert "image" in str(content).lower() or "base64" in str(content).lower(), (
            "image block must produce a placeholder mentioning image or base64"
        )

    def test_unknown_block_type_falls_back_to_str(self) -> None:
        """Unknown block types fall back to str() via _extract_content directly."""
        # Build a minimal mock raw result bypassing Pydantic validation by
        # calling _extract_content with a synthetic object.
        mock_raw = MagicMock()
        mock_raw.structuredContent = None
        mock_block = MagicMock()
        mock_block.type = "unknown_type"
        mock_block.__str__ = lambda self: "unknown_content"
        mock_raw.content = [mock_block]
        content = MCPToolInvoker._extract_content(mock_raw)
        assert isinstance(content, str), "unknown block type must produce a string result"


# ---------------------------------------------------------------------------
# MCPHealthCheck
# ---------------------------------------------------------------------------


class TestMCPHealthCheck:
    """Tests for MCPHealthCheck.check()."""

    @pytest.mark.asyncio
    async def test_healthy_ping_returns_healthy_true(self) -> None:
        """Successful ping returns {'healthy': True, ...}."""
        cfg = default_mcp_config()
        health = MCPHealthCheck(config=cfg)

        mock_session = AsyncMock(spec=ClientSession)
        mock_session.send_ping = AsyncMock(return_value=None)

        result = await health.check("web", mock_session)
        assert result["healthy"] is True, "successful ping must return healthy=True"
        assert result["server"] == "web", "server name must be in result"
        assert "latency_ms" in result, "latency_ms must be in result"

    @pytest.mark.asyncio
    async def test_failed_ping_returns_healthy_false(self) -> None:
        """Failed ping returns {'healthy': False, 'error': ...}."""
        cfg = default_mcp_config()
        health = MCPHealthCheck(config=cfg)

        mock_session = AsyncMock(spec=ClientSession)
        mock_session.send_ping = AsyncMock(side_effect=Exception("connection lost"))

        result = await health.check("web", mock_session)
        assert result["healthy"] is False, "failed ping must return healthy=False"
        assert "error" in result, "error key must be present on failure"
        assert "connection lost" in result["error"], "error message must contain the exception text"

    @pytest.mark.asyncio
    async def test_latency_ms_is_non_negative(self) -> None:
        """latency_ms is always a non-negative float."""
        cfg = default_mcp_config()
        health = MCPHealthCheck(config=cfg)

        mock_session = AsyncMock(spec=ClientSession)
        mock_session.send_ping = AsyncMock(return_value=None)

        result = await health.check("web", mock_session)
        assert result["latency_ms"] >= 0.0, "latency_ms must be non-negative"

    @pytest.mark.asyncio
    async def test_latency_ms_present_on_failure(self) -> None:
        """latency_ms is present even when ping fails."""
        cfg = default_mcp_config()
        health = MCPHealthCheck(config=cfg)

        mock_session = AsyncMock(spec=ClientSession)
        mock_session.send_ping = AsyncMock(side_effect=RuntimeError("down"))

        result = await health.check("web", mock_session)
        assert "latency_ms" in result, "latency_ms must be in result even on failure"
        assert result["latency_ms"] >= 0.0, "latency_ms must be non-negative on failure"


# ---------------------------------------------------------------------------
# MCPManager — facade
# ---------------------------------------------------------------------------


class TestMCPManager:
    """Tests for the MCPManager facade."""

    def _make_manager(
        self,
        server_configs: list[MCPServerConfig] | None = None,
        lazy_connect: bool = True,
        discovery_on_connect: bool = False,
        **config_overrides: Any,
    ) -> MCPManager:
        cfg = default_mcp_config(
            lazy_connect=lazy_connect,
            discovery_on_connect=discovery_on_connect,
            **config_overrides,
        )
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(return_value=MagicMock())
        return MCPManager(
            config=cfg,
            transport_factory=mock_transport,
        )

    @pytest.mark.asyncio
    async def test_async_context_manager_returns_self(self) -> None:
        """MCPManager supports 'async with' and returns self on __aenter__."""
        manager = self._make_manager()
        async with manager as ctx:
            assert ctx is manager, "__aenter__ must return self"

    @pytest.mark.asyncio
    async def test_async_context_manager_calls_disconnect_on_exit(self) -> None:
        """MCPManager calls disconnect_all() on __aexit__."""
        manager = self._make_manager()
        disconnect_called = []

        async def patched_disconnect() -> None:
            disconnect_called.append(True)
            # Still perform the actual disconnect to avoid side effects.
            await manager._connection_manager.disconnect_all()

        manager.disconnect_all = patched_disconnect  # type: ignore[method-assign]

        async with manager:
            pass

        assert len(disconnect_called) == 1, (
            "disconnect_all must be called exactly once on context exit"
        )

    @pytest.mark.asyncio
    async def test_call_tool_raises_when_not_connected_and_no_lazy(self) -> None:
        """call_tool() raises MCPConnectionError when not connected and lazy_connect=False."""
        manager = self._make_manager(lazy_connect=False)

        with pytest.raises(MCPConnectionError) as exc_info:
            await manager.call_tool("web", "search", {})
        assert "web" in str(exc_info.value), "MCPConnectionError must mention the server name 'web'"

    @pytest.mark.asyncio
    async def test_list_tools_returns_empty_initially(self) -> None:
        """list_tools() returns empty list when no tools are registered."""
        manager = self._make_manager()
        tools = await manager.list_tools()
        assert tools == [], "no tools should be available before discovery"

    @pytest.mark.asyncio
    async def test_list_tools_filtered_by_server(self) -> None:
        """list_tools(server_name) returns only tools for that server."""
        manager = self._make_manager()
        registry = manager.tool_registry
        registry.register(make_tool_schema(name="search", server_name="web"))
        registry.register(make_tool_schema(name="query", server_name="db"))

        tools = await manager.list_tools(server_name="web")
        assert len(tools) == 1, "filtering by server must return exactly 1 tool"
        assert tools[0].server_name == "web", "returned tool must be from 'web'"

    @pytest.mark.asyncio
    async def test_list_tools_all_servers(self) -> None:
        """list_tools() without server_name returns all tools."""
        manager = self._make_manager()
        registry = manager.tool_registry
        registry.register(make_tool_schema(name="search", server_name="web"))
        registry.register(make_tool_schema(name="query", server_name="db"))

        tools = await manager.list_tools()
        assert len(tools) == 2, "list_tools with no filter must return all 2 tools"

    @pytest.mark.asyncio
    async def test_check_health_raises_when_not_connected(self) -> None:
        """check_health() raises MCPConnectionError for disconnected server."""
        manager = self._make_manager()

        with pytest.raises(MCPConnectionError) as exc_info:
            await manager.check_health("web")
        assert "web" in str(exc_info.value), (
            "MCPConnectionError for health check must mention the server name"
        )

    @pytest.mark.asyncio
    async def test_check_all_health_returns_empty_when_no_servers(self) -> None:
        """check_all_health() returns empty list when no servers are connected."""
        manager = self._make_manager()
        results = await manager.check_all_health()
        assert results == [], "no connected servers must yield empty health check list"

    @pytest.mark.asyncio
    async def test_connected_servers_initially_empty(self) -> None:
        """connected_servers() returns empty list before any connections."""
        manager = self._make_manager()
        assert manager.connected_servers() == [], "no servers should be connected initially"

    @pytest.mark.asyncio
    async def test_call_tool_lazy_connect_triggered(self) -> None:
        """call_tool() triggers lazy connect when server is not connected."""
        cfg = default_mcp_config(lazy_connect=True, discovery_on_connect=False)
        mock_transport = MagicMock(spec=TransportFactory)
        mock_transport.build = MagicMock(return_value=MagicMock())

        manager = MCPManager(config=cfg, transport_factory=mock_transport)

        connect_calls: list[str] = []

        async def mock_connect(server_name: str) -> None:
            connect_calls.append(server_name)
            # Simulate the connection by populating the session.
            manager._connection_manager._server_sessions[server_name] = MagicMock(
                spec=ClientSession
            )
            # Simulate a group being available.
            mock_group = make_mock_group(call_tool_result=make_call_result("lazy result"))
            manager._connection_manager._group = mock_group

        manager.connect = mock_connect  # type: ignore[method-assign]

        # call_tool should trigger lazy connect then succeed via the group.
        result = await manager.call_tool("web", "search", {})
        assert "web" in connect_calls, "lazy_connect must trigger connect('web')"
        assert result.content == "lazy result", (
            "call_tool must return the tool result after lazy connect"
        )

    @pytest.mark.asyncio
    async def test_disconnect_all_delegates_to_connection_manager(self) -> None:
        """disconnect_all() delegates to MCPConnectionManager.disconnect_all."""
        manager = self._make_manager()
        call_log: list[str] = []

        original = manager._connection_manager.disconnect_all

        async def patched() -> None:
            call_log.append("disconnected")
            # call original to avoid state inconsistency in other tests
            await original()

        manager._connection_manager.disconnect_all = patched  # type: ignore[method-assign]
        await manager.disconnect_all()
        assert call_log == ["disconnected"], (
            "disconnect_all must delegate to MCPConnectionManager.disconnect_all"
        )

    @pytest.mark.asyncio
    async def test_connect_all_runs_discovery_when_enabled(self) -> None:
        """With discovery_on_connect=True, connect_all() discovers tools for the
        servers that connected, threading gateway names through."""
        manager = self._make_manager(discovery_on_connect=True)
        cm = manager._connection_manager
        cm.connect_all = AsyncMock(return_value=["s1"])  # type: ignore[method-assign]
        cm.get_group = MagicMock(return_value=MagicMock(spec=ClientSessionGroup))
        cm.get_session = MagicMock(return_value=MagicMock(spec=ClientSession))
        cm.get_config = MagicMock(return_value=http_server_config("s1", gateway_server_name="gw1"))
        manager._discovery.discover_all = AsyncMock()  # type: ignore[method-assign]

        connected = await manager.connect_all()
        assert connected == ["s1"]
        manager._discovery.discover_all.assert_awaited_once()
        assert manager._discovery.discover_all.call_args.kwargs["gateway_server_names"] == {
            "s1": "gw1"
        }

    @pytest.mark.asyncio
    async def test_connect_all_skips_discovery_when_nothing_connected(self) -> None:
        """No discovery pass when connect_all() connects zero servers."""
        manager = self._make_manager(discovery_on_connect=True)
        manager._connection_manager.connect_all = AsyncMock(return_value=[])  # type: ignore[method-assign]
        manager._discovery.discover_all = AsyncMock()  # type: ignore[method-assign]
        assert await manager.connect_all() == []
        manager._discovery.discover_all.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_check_all_health_iterates_connected_servers(self) -> None:
        """check_all_health() returns one status per connected server."""
        manager = self._make_manager()
        cm = manager._connection_manager
        cm.connected_servers = MagicMock(return_value=["a", "b"])  # type: ignore[method-assign]

        async def fake_check(name: str) -> dict[str, Any]:
            return {"server": name, "healthy": True}

        manager.check_health = fake_check  # type: ignore[method-assign]
        results = await manager.check_all_health()
        assert results == [
            {"server": "a", "healthy": True},
            {"server": "b", "healthy": True},
        ]

    def test_get_default_arguments_delegates_to_connection_manager(self) -> None:
        """The facade delegates get_default_arguments() to the connection manager."""
        manager = self._make_manager()
        manager._connection_manager.get_default_arguments = MagicMock(  # type: ignore[method-assign]
            return_value={"tenant": "acme"}
        )
        assert manager.get_default_arguments("srv") == {"tenant": "acme"}
        manager._connection_manager.get_default_arguments.assert_called_once_with("srv")


# ---------------------------------------------------------------------------
# Secret redaction helpers
# ---------------------------------------------------------------------------


class TestSecretRedaction:
    """Tests for _redact_value and _redact_dict."""

    def test_redact_value_replaces_openai_key(self) -> None:
        """OpenAI-style sk- keys are redacted."""
        value = "using sk-abc123def456ghi789jkl as the api key"
        redacted = _redact_value(value)
        assert "sk-abc123def456ghi789jkl" not in redacted, "OpenAI-style sk- key must be redacted"
        assert "[REDACTED]" in redacted, "redacted text must contain [REDACTED]"

    def test_redact_value_replaces_bearer_token(self) -> None:
        """Bearer tokens are redacted from values."""
        value = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"
        redacted = _redact_value(value)
        assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in redacted, (
            "Bearer token must be redacted"
        )

    def test_redact_value_leaves_normal_text_alone(self) -> None:
        """Normal text without secrets is not modified."""
        value = "localhost:8080/sse"
        redacted = _redact_value(value)
        assert redacted == value, "non-secret text must not be modified"

    def test_redact_dict_redacts_sensitive_key_names(self) -> None:
        """dict with sensitive key names has values replaced with [REDACTED]."""
        d = {
            "Authorization": "Bearer some-token",
            "api_key": "my-secret-key",
            "normal": "normal-value",
        }
        redacted = _redact_dict(d)
        assert redacted["Authorization"] == "[REDACTED]", (
            "'Authorization' key value must be replaced with [REDACTED]"
        )
        assert redacted["api_key"] == "[REDACTED]", (
            "'api_key' key value must be replaced with [REDACTED]"
        )
        assert redacted["normal"] == "normal-value", "non-sensitive key must be left unchanged"

    def test_redact_dict_preserves_keys(self) -> None:
        """_redact_dict preserves dict keys, only modifying values."""
        d = {"authorization": "sk-secret12345678901234567890", "host": "example.com"}
        redacted = _redact_dict(d)
        assert set(redacted.keys()) == set(d.keys()), (
            "all original keys must be preserved in redacted dict"
        )

    def test_redact_dict_pattern_matches_in_values(self) -> None:
        """_redact_dict applies pattern matching to non-sensitive field values."""
        d = {"info": "Token sk-mytoken123456789012345678901234567890 found"}
        redacted = _redact_dict(d)
        assert "sk-mytoken" not in redacted["info"], (
            "secret pattern in a non-sensitive key must still be redacted in the value"
        )

    def test_redact_value_replaces_aws_access_key(self) -> None:
        """AWS-style AKIA keys are redacted."""
        value = "aws key AKIAIOSFODNN7EXAMPLE is the key"
        redacted = _redact_value(value)
        assert "AKIAIOSFODNN7EXAMPLE" not in redacted, "AWS AKIA key must be redacted"

    def test_redact_dict_password_key_redacted(self) -> None:
        """dict with 'password' key has value replaced."""
        d = {"password": "s3cr3t!"}
        redacted = _redact_dict(d)
        assert redacted["password"] == "[REDACTED]", (
            "'password' key value must be replaced with [REDACTED]"
        )

    def test_redact_dict_token_key_redacted(self) -> None:
        """dict with 'token' key has value replaced."""
        d = {"token": "some-access-token"}
        redacted = _redact_dict(d)
        assert redacted["token"] == "[REDACTED]", (
            "'token' key value must be replaced with [REDACTED]"
        )


# ---------------------------------------------------------------------------
# Framework isolation
# ---------------------------------------------------------------------------


class TestFrameworkIsolation:
    """Tests that mcp/ module imports no agent framework libraries."""

    def test_no_semantic_kernel_import_in_mcp_module(self) -> None:
        """mcp_manager module must not import semantic_kernel."""
        import agent_service_maf.mcp.mcp_manager as module

        module_file = module.__file__ or ""
        # The module is loaded — check that semantic_kernel is not in sys.modules
        # due to a direct import in this module.
        # We verify by inspecting the source for framework imports.
        if module_file:
            with open(module_file) as fh:
                source = fh.read()
            assert "import semantic_kernel" not in source, (
                "mcp_manager must not import semantic_kernel"
            )
            assert "import crewai" not in source, "mcp_manager must not import crewai"
            assert "import langgraph" not in source, "mcp_manager must not import langgraph"

    def test_no_framework_imports_in_tool_registry(self) -> None:
        """tool_registry module must not import any agent framework libraries."""
        import agent_service_maf.mcp.tool_registry as module

        module_file = module.__file__ or ""
        if module_file:
            with open(module_file) as fh:
                source = fh.read()
            for framework in ["semantic_kernel", "echo"]:
                assert f"import {framework}" not in source, (
                    f"tool_registry must not import {framework}"
                )

    def test_no_framework_imports_in_config_loader(self) -> None:
        """config_loader module must not import any agent framework libraries."""
        import agent_service_maf.mcp.config_loader as module

        module_file = module.__file__ or ""
        if module_file:
            with open(module_file) as fh:
                source = fh.read()
            for framework in ["semantic_kernel", "echo"]:
                assert f"import {framework}" not in source, (
                    f"config_loader must not import {framework}"
                )

    def test_no_framework_imports_in_transport_factory(self) -> None:
        """transport_factory module must not import any agent framework libraries."""
        import agent_service_maf.mcp.transport_factory as module

        module_file = module.__file__ or ""
        if module_file:
            with open(module_file) as fh:
                source = fh.read()
            for framework in ["semantic_kernel", "echo"]:
                assert f"import {framework}" not in source, (
                    f"transport_factory must not import {framework}"
                )
