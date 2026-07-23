"""Unit tests for :mod:`agent_service_maf.interface_layer.ws_handler`.

WebSocket route handlers live in :file:`routes.py`; this module is the
session-lifecycle implementation those routes delegate to. There is no
existing unit coverage for any of it, and integration tests only touch
the happy path.

We test the handler in isolation using a hand-rolled ``FakeWebSocket``
that emulates the FastAPI :class:`WebSocket` interface (``headers``,
``client``, ``scope``, ``state``, ``app``, ``receive_text``,
``send_json``, ``close``). No real ``TestClient``, no live ASGI — that
keeps the tests fast and lets us drive every error path deterministically:

- ``_get_client_ip`` precedence (X-Forwarded-For > client.host > "unknown")
- Per-IP connection-limit rejection
- Idle timeout → ERROR + 4008 close
- Invalid JSON → ERROR + continue
- Invalid InvokeRequest schema → ERROR + continue
- Missing teams registry / unknown project / unknown team / unhealthy bundle
- Happy path: STARTED → adapter events → COMPLETED
- Identity binding via ``websocket.state.claims["_identity"]``
- Adapter raise in ``_stream_agent_events`` → ERROR event
- ``WebSocketDisconnect`` cleanup
- Connection counter increment / decrement invariant
- ``reset_connection_tracking`` test helper
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi import WebSocketDisconnect

from agent_service_maf import interface_layer
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.identity import (
    IdentityContext,
    get_current_identity,
)
from agent_service_maf.core.interfaces import AgentEvent, EventType
from agent_service_maf.interface_layer.ws_handler import (
    _active_connections,
    _get_client_ip,
    _stream_agent_events,
    handle_websocket_session,
    reset_connection_tracking,
)

# ---------------------------------------------------------------------------
# FakeWebSocket — mimics enough of fastapi.WebSocket to drive the handler.
# ---------------------------------------------------------------------------


class _Sentinel:
    """Sentinel item used to encode WebSocketDisconnect in receive_queue."""


_DISCONNECT = _Sentinel()


class _NeverComplete(_Sentinel):
    """Sentinel: receive_text awaits forever, used to force idle timeout."""


_NEVER = _NeverComplete()


class FakeWebSocket:
    """Stand-in for :class:`fastapi.WebSocket`.

    ``receive_queue`` is a list of items consumed in order by
    ``receive_text()``. Item types:

    - ``str`` — returned as-is.
    - ``_DISCONNECT`` — raises :class:`WebSocketDisconnect`.
    - ``_NEVER`` — awaits indefinitely (use with ``asyncio.wait_for`` /
      ``idle_timeout_seconds=0.01`` to force the idle-timeout path).
    """

    def __init__(
        self,
        *,
        headers: dict[str, str] | None = None,
        query_params: dict[str, str] | None = None,
        client_host: str | None = "10.0.0.1",
        receive_queue: list[Any] | None = None,
        state: SimpleNamespace | None = None,
        app: Any = None,
    ) -> None:
        self.headers = headers or {}
        self.query_params = query_params or {}
        self.client = SimpleNamespace(host=client_host) if client_host is not None else None
        self.scope: dict[str, Any] = {}
        self.state = state if state is not None else SimpleNamespace()
        self.app = app
        self._receive_queue: list[Any] = list(receive_queue or [])
        self.sent: list[dict[str, Any]] = []
        self.close_code: int | None = None
        self.close_reason: str | None = None
        self.closed: bool = False

    async def receive_text(self) -> str:
        if not self._receive_queue:
            raise WebSocketDisconnect(code=1000)
        item = self._receive_queue.pop(0)
        if item is _DISCONNECT:
            raise WebSocketDisconnect(code=1000)
        if item is _NEVER:
            # Block forever — the test should wrap with wait_for and a
            # tiny timeout to drive the idle-timeout branch.
            await asyncio.Event().wait()
            raise AssertionError("unreachable")
        return item  # str

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.close_code = code
        self.close_reason = reason
        self.closed = True


# ---------------------------------------------------------------------------
# Test fixtures
# ---------------------------------------------------------------------------


VALID_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"


def _make_agent_event(event_type: EventType, data: str = "") -> AgentEvent:
    return AgentEvent(
        event_type=event_type,
        data=data,
        metadata={"agentId": "echo"},
        timestamp=datetime.now(tz=UTC),
    )


def _make_streaming_agent(events: list[AgentEvent] | Exception) -> MagicMock:
    """Build an agent whose ``stream()`` yields ``events`` or raises."""
    agent = MagicMock()

    async def _initialize(ctx: Any) -> None:
        return None

    async def _stream(req: Any, ctx: Any):
        if isinstance(events, Exception):
            raise events
        for ev in events:
            yield ev

    agent.initialize = _initialize
    agent.stream = _stream
    return agent


def _build_app_state(
    *,
    agent: MagicMock,
    healthy: bool = True,
    has_project: bool = True,
    bundle_present: bool = True,
    teams_attr_present: bool = True,
) -> SimpleNamespace:
    """Construct a SimpleNamespace standing in for ``app.state``.

    The handler reads ``app.state.teams`` (registry) and
    ``app.state.framework_registry`` (adapter factory).
    """
    bundle = MagicMock()
    bundle.healthy = healthy
    bundle.startup_error = "fixture said unhealthy" if not healthy else None
    bundle.team_id = "team-x"
    bundle.gateway = MagicMock()
    bundle.mcp_manager = MagicMock()
    bundle.guardrails = MagicMock()
    bundle.session_manager = MagicMock()

    # The handler calls bundle.config_loader.resolve(...) → AgentConfig.
    bundle.config_loader.resolve.return_value = AgentConfig()

    bundle.scoped_session_id.return_value = "scoped:team:abc"

    registry = MagicMock()
    registry.has_project.return_value = has_project
    registry.project_ids.return_value = [VALID_PROJECT_ID] if has_project else []
    registry.team_ids_for_project.return_value = ["team-x"]
    registry.get_in_project.return_value = bundle if bundle_present else None
    registry.default_for_project.return_value = bundle if bundle_present else None

    framework_registry = MagicMock()
    framework_registry.create.return_value = agent

    state = SimpleNamespace(framework_registry=framework_registry)
    if teams_attr_present:
        state.teams = registry
    else:
        state.teams = None

    return state


def _invoke_payload(
    *,
    input_text: str = "hello",
    session_id: str | None = None,
    context: dict | None = None,
) -> str:
    body: dict[str, Any] = {"input": input_text}
    if session_id is not None:
        body["session_id"] = session_id
    if context is not None:
        body["context"] = context
    return json.dumps(body)


@pytest.fixture(autouse=True)
def _clear_connection_tracking() -> None:
    """Each test starts with a clean per-IP counter."""
    reset_connection_tracking()
    yield
    reset_connection_tracking()


@pytest.fixture(autouse=True)
def _patch_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    """The handler calls three ``_override_applier`` helpers that read
    from a real :class:`AgentConfig`; the tests pass a default config
    so these need to be no-ops returning safe defaults."""
    monkeypatch.setattr(
        interface_layer.ws_handler,
        "config_overrides_to_request_dict",
        lambda overrides: None,
    )
    monkeypatch.setattr(
        interface_layer.ws_handler,
        "config_overrides_to_agent_request_dict",
        lambda overrides: {},
    )
    monkeypatch.setattr(
        interface_layer.ws_handler,
        "apply_per_agent_overrides",
        lambda cfg, overrides, *, is_team_invoke: cfg,
    )


# ---------------------------------------------------------------------------
# _get_client_ip
# ---------------------------------------------------------------------------


class TestGetClientIp:
    def test_prefers_x_forwarded_for_first_entry(self) -> None:
        ws = FakeWebSocket(headers={"x-forwarded-for": "203.0.113.5, 10.0.0.1"})
        assert _get_client_ip(ws) == "203.0.113.5"  # type: ignore[arg-type]

    def test_strips_whitespace_in_xff_value(self) -> None:
        ws = FakeWebSocket(headers={"x-forwarded-for": "  203.0.113.5  "})
        assert _get_client_ip(ws) == "203.0.113.5"  # type: ignore[arg-type]

    def test_falls_back_to_client_host(self) -> None:
        ws = FakeWebSocket(headers={}, client_host="192.168.1.42")
        assert _get_client_ip(ws) == "192.168.1.42"  # type: ignore[arg-type]

    def test_unknown_when_no_xff_and_no_client(self) -> None:
        ws = FakeWebSocket(headers={}, client_host=None)
        assert _get_client_ip(ws) == "unknown"  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Per-IP connection limit
# ---------------------------------------------------------------------------


class TestConnectionLimit:
    @pytest.mark.asyncio
    async def test_rejects_when_limit_exceeded_with_4029_close(self) -> None:
        # Seed the counter at the limit so the very next connection
        # from this IP is rejected before any further work.
        _active_connections["10.0.0.1"] = 5
        ws = FakeWebSocket()

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=SimpleNamespace(state=SimpleNamespace()),
            project_id=VALID_PROJECT_ID,
            max_connections_per_ip=5,
        )

        assert ws.closed is True
        assert ws.close_code == 4029
        # Counter not touched on rejection.
        assert _active_connections["10.0.0.1"] == 5

    @pytest.mark.asyncio
    async def test_counter_decrements_after_normal_disconnect(self) -> None:
        agent = _make_streaming_agent([_make_agent_event(EventType.TOKEN, "hi")])
        ws = FakeWebSocket(receive_queue=[_DISCONNECT])

        app = SimpleNamespace(state=_build_app_state(agent=agent))
        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        assert _active_connections["10.0.0.1"] == 0

    @pytest.mark.asyncio
    async def test_counter_decrements_after_exception_in_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Force an exception that escapes the inner try/except blocks
        # by hijacking InvokeRequest construction — the outer Exception
        # handler should still run finally and decrement.
        original = interface_layer.ws_handler._stream_agent_events

        async def boom(*a: Any, **k: Any) -> None:
            raise RuntimeError("stream blew up")

        monkeypatch.setattr(interface_layer.ws_handler, "_stream_agent_events", boom)

        agent = _make_streaming_agent([])
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=agent))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        # Even with the outer-loop exception path, finally must zero
        # the counter for this IP.
        assert _active_connections["10.0.0.1"] == 0
        # Restore for the rest of the test file.
        monkeypatch.setattr(interface_layer.ws_handler, "_stream_agent_events", original)


# ---------------------------------------------------------------------------
# Idle timeout
# ---------------------------------------------------------------------------


class TestIdleTimeout:
    @pytest.mark.asyncio
    async def test_idle_timeout_sends_error_and_closes_with_4008(self) -> None:
        # Receive blocks forever; the timeout fires almost immediately.
        ws = FakeWebSocket(receive_queue=[_NEVER])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock()))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
            idle_timeout_seconds=0,
        )

        assert ws.closed is True
        assert ws.close_code == 4008
        assert any(msg.get("metadata", {}).get("reason") == "idle_timeout" for msg in ws.sent)


# ---------------------------------------------------------------------------
# Malformed input handling
# ---------------------------------------------------------------------------


class TestMalformedInput:
    @pytest.mark.asyncio
    async def test_invalid_json_sends_error_and_continues(self) -> None:
        # Send a non-JSON string, then disconnect. The handler should
        # emit an ERROR event for the bad JSON, then exit cleanly via
        # the disconnect on the next iteration.
        ws = FakeWebSocket(receive_queue=["not json at all", _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock()))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1
        assert errors[0]["metadata"]["error_type"] == "json_decode_error"

    @pytest.mark.asyncio
    async def test_invalid_schema_sends_error_and_continues(self) -> None:
        # Valid JSON but missing the required ``input`` field — Pydantic
        # raises during ``InvokeRequest(**data)`` so the generic
        # Exception arm fires.
        ws = FakeWebSocket(receive_queue=['{"agent_id": "x"}', _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock()))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1
        # error_type should be a Python class name (ValidationError or similar)
        assert errors[0]["metadata"]["error_type"] not in {"json_decode_error", ""}


# ---------------------------------------------------------------------------
# Context-build failure modes
# ---------------------------------------------------------------------------


class TestContextBuildFailures:
    @pytest.mark.asyncio
    async def test_no_teams_registry_sends_error_continues(self) -> None:
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock(), teams_attr_present=False))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1
        assert errors[0]["metadata"]["error_type"] == "RuntimeError"

    @pytest.mark.asyncio
    async def test_unknown_project_sends_error(self) -> None:
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock(), has_project=False))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id="ghost-project",
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1

    @pytest.mark.asyncio
    async def test_unknown_team_sends_error(self) -> None:
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock(), bundle_present=False))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
            team_id="ghost-team",
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1

    @pytest.mark.asyncio
    async def test_unhealthy_bundle_sends_error(self) -> None:
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock(), healthy=False))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
            team_id="team-x",
        )

        errors = [m for m in ws.sent if m["event"] == EventType.ERROR.value]
        assert len(errors) == 1


# ---------------------------------------------------------------------------
# Happy path + identity binding
# ---------------------------------------------------------------------------


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_streams_started_event_completed_to_client(self) -> None:
        events = [
            _make_agent_event(EventType.TOKEN, "hello"),
            _make_agent_event(EventType.TOKEN, " world"),
        ]
        agent = _make_streaming_agent(events)

        ws = FakeWebSocket(receive_queue=[_invoke_payload(input_text="hello"), _DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=agent))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
            team_id="team-x",
        )

        kinds = [m["event"] for m in ws.sent]
        assert kinds == [
            EventType.STARTED.value,
            EventType.TOKEN.value,
            EventType.TOKEN.value,
            EventType.COMPLETED.value,
        ]

    @pytest.mark.asyncio
    async def test_uses_default_team_when_team_id_absent(self) -> None:
        # No team_id passed → handler calls default_for_project() instead
        # of get_in_project(). Verify by inspecting the mock.
        agent = _make_streaming_agent([])
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        state = _build_app_state(agent=agent)
        app = SimpleNamespace(state=state)

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        assert state.teams.default_for_project.called
        assert not state.teams.get_in_project.called


class TestIdentityBinding:
    @pytest.mark.asyncio
    async def test_binds_identity_from_websocket_state_claims(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id=VALID_PROJECT_ID,
            correlation_id="11111111-1111-4111-8111-111111111111",
        )
        ws = FakeWebSocket(
            receive_queue=[_invoke_payload(), _DISCONNECT],
            state=SimpleNamespace(claims={"_identity": identity}),
        )
        agent = _make_streaming_agent([_make_agent_event(EventType.TOKEN, "x")])
        app = SimpleNamespace(state=_build_app_state(agent=agent))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        # The handler must reset the identity in the finally block —
        # after the session ends, no identity should be bound.
        assert get_current_identity() is None

    @pytest.mark.asyncio
    async def test_no_identity_binding_when_claims_absent(self) -> None:
        # state.claims absent → no IdentityContext bound, no reset
        # needed. The handler must not crash trying to read .claims.
        ws = FakeWebSocket(receive_queue=[_invoke_payload(), _DISCONNECT])
        agent = _make_streaming_agent([])
        app = SimpleNamespace(state=_build_app_state(agent=agent))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        assert get_current_identity() is None


# ---------------------------------------------------------------------------
# Generic top-level error handling
# ---------------------------------------------------------------------------


class TestTopLevelErrorHandler:
    @pytest.mark.asyncio
    async def test_disconnect_during_receive_text_exits_cleanly(self) -> None:
        # The very first receive_text raises WebSocketDisconnect — the
        # session should exit without sending any error event.
        ws = FakeWebSocket(receive_queue=[_DISCONNECT])
        app = SimpleNamespace(state=_build_app_state(agent=MagicMock()))

        await handle_websocket_session(
            ws,  # type: ignore[arg-type]
            agent_id="echo",
            app=app,
            project_id=VALID_PROJECT_ID,
        )

        # No events sent — connection closed before anything happened.
        assert ws.sent == []


# ---------------------------------------------------------------------------
# _stream_agent_events — direct unit tests
# ---------------------------------------------------------------------------


class TestStreamAgentEvents:
    @pytest.mark.asyncio
    async def test_emits_started_events_completed_in_order(self) -> None:
        events = [
            _make_agent_event(EventType.TOKEN, "a"),
            _make_agent_event(EventType.TOKEN, "b"),
        ]
        agent = _make_streaming_agent(events)
        ws = FakeWebSocket()

        framework_registry = MagicMock()
        framework_registry.create.return_value = agent
        app = SimpleNamespace(state=SimpleNamespace(framework_registry=framework_registry))

        from agent_service_maf.core.context import AgentExecutionContext
        from agent_service_maf.core.interfaces import AgentRequest

        cfg = AgentConfig()
        ctx = AgentExecutionContext(config=cfg)
        req = AgentRequest(agent_id="echo", input="hi")

        await _stream_agent_events(ws, req, ctx, app)  # type: ignore[arg-type]

        kinds = [m["event"] for m in ws.sent]
        assert kinds == [
            EventType.STARTED.value,
            EventType.TOKEN.value,
            EventType.TOKEN.value,
            EventType.COMPLETED.value,
        ]

    @pytest.mark.asyncio
    async def test_adapter_failure_sends_error_event(self) -> None:
        agent = _make_streaming_agent(RuntimeError("adapter exploded"))
        ws = FakeWebSocket()

        framework_registry = MagicMock()
        framework_registry.create.return_value = agent
        app = SimpleNamespace(state=SimpleNamespace(framework_registry=framework_registry))

        from agent_service_maf.core.context import AgentExecutionContext
        from agent_service_maf.core.interfaces import AgentRequest

        ctx = AgentExecutionContext(config=AgentConfig())
        req = AgentRequest(agent_id="echo", input="hi")

        await _stream_agent_events(ws, req, ctx, app)  # type: ignore[arg-type]

        # STARTED was sent before the failure, then ERROR — no COMPLETED.
        kinds = [m["event"] for m in ws.sent]
        assert EventType.STARTED.value in kinds
        assert EventType.ERROR.value in kinds
        assert EventType.COMPLETED.value not in kinds
        err = next(m for m in ws.sent if m["event"] == EventType.ERROR.value)
        assert err["metadata"]["error_type"] == "RuntimeError"
        assert err["metadata"]["correlation_id"] == ctx.correlation_id

    @pytest.mark.asyncio
    async def test_websocket_disconnect_re_raises_for_session_cleanup(self) -> None:
        # The streaming helper must let WebSocketDisconnect bubble so
        # the session-level handler runs its disconnect path.
        async def _bad_initialize(ctx: Any) -> None:
            raise WebSocketDisconnect(code=1000)

        agent = MagicMock()
        agent.initialize = _bad_initialize

        async def _empty_stream(req: Any, ctx: Any):
            if False:
                yield  # pragma: no cover

        agent.stream = _empty_stream

        ws = FakeWebSocket()
        framework_registry = MagicMock()
        framework_registry.create.return_value = agent
        app = SimpleNamespace(state=SimpleNamespace(framework_registry=framework_registry))

        from agent_service_maf.core.context import AgentExecutionContext
        from agent_service_maf.core.interfaces import AgentRequest

        ctx = AgentExecutionContext(config=AgentConfig())
        req = AgentRequest(agent_id="echo", input="hi")

        with pytest.raises(WebSocketDisconnect):
            await _stream_agent_events(ws, req, ctx, app)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# reset_connection_tracking
# ---------------------------------------------------------------------------


class TestResetConnectionTracking:
    def test_clears_the_counter(self) -> None:
        _active_connections["1.2.3.4"] = 3
        _active_connections["5.6.7.8"] = 2
        reset_connection_tracking()
        assert dict(_active_connections) == {}
