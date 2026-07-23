"""Integration tests for §B+§C end-to-end identity flow through the FastAPI app.

Covers test plan items:
* I1  -- 200 round-trip with full gateway header set; identity reaches the agent.
* I3  -- two interleaved invokes see distinct identities via the agent capture.
* I10 -- missing X-User-ID -> 401 (middleware enforced).
* I12 -- raw Authorization never reaches the agent context.

These tests run the real auth middleware (``AGENT_INTERFACE__AUTH__SCHEME=gateway_identity``)
against a stub MockAgent that captures the bound IdentityContext, so any
break in the middleware-or-route plumbing fails the assertion.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Iterator
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.identity import get_current_identity
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.interface_layer.api import create_app
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX


class _IdentityCapturingAgent(BaseAgent):
    """Records the IdentityContext bound at adapter-invocation time."""

    captures: list[dict[str, Any]] = []
    invoke_event: threading.Event = threading.Event()
    release_event: threading.Event = threading.Event()
    # Concurrency test uses this lock to make the agent block inside
    # ``invoke`` until both peer requests have arrived.
    arrival_count_lock = threading.Lock()
    arrival_count = 0
    arrival_target = 0
    arrival_event = threading.Event()

    @classmethod
    def reset(cls) -> None:
        cls.captures = []
        cls.invoke_event = threading.Event()
        cls.release_event = threading.Event()
        cls.arrival_count = 0
        cls.arrival_target = 0
        cls.arrival_event = threading.Event()

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        ctx_identity = context.identity
        bound_identity = get_current_identity()
        type(self).captures.append(
            {
                "input": request.input,
                "context_identity": (
                    ctx_identity.model_dump(by_alias=True) if ctx_identity else None
                ),
                "context_user_token": (ctx_identity.user_token if ctx_identity else None),
                "ctx_user_id_via_identity": (ctx_identity.user_id if ctx_identity else None),
                "contextvar_user_id": (bound_identity.user_id if bound_identity else None),
                "contextvar_user_token": (bound_identity.user_token if bound_identity else None),
            }
        )
        # Wake any test waiting on this invoke and (optionally) block here
        # so a peer request can race in concurrently.
        type(self).invoke_event.set()
        # Arrival-barrier path -- the concurrency test uses this to make
        # sure every peer is mid-flight before any release happens.
        with type(self).arrival_count_lock:
            type(self).arrival_count += 1
            if type(self).arrival_target and type(self).arrival_count >= type(self).arrival_target:
                type(self).arrival_event.set()
        type(self).release_event.wait(timeout=5.0)
        return AgentResponse(
            agent_id=request.agent_id,
            output=f"ok:{request.input}",
            usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            metadata={"framework": "identity_capture"},
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data="ok")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(
            agent_id="identity_capture",
            framework="identity_capture",
            supports_streaming=False,
            supports_tools=False,
            supports_handoff=False,
        )


def _write_default_team(teams_dir: Any) -> None:
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": "identity_capture"},
            }
        )
    )


@pytest.fixture
def gateway_client(tmp_path: Any) -> Iterator[TestClient]:
    """TestClient with the gateway_identity auth scheme enabled.

    Plugs in the IdentityCapturingAgent so each request leaves a trace
    of what identity the route handler bound at invocation time.
    """
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    _IdentityCapturingAgent.reset()
    # Default to immediately releasing -- tests that want to interleave
    # requests can clear and set the events directly.
    _IdentityCapturingAgent.release_event.set()

    FrameworkRegistry.clear()
    FrameworkRegistry.register("identity_capture")(_IdentityCapturingAgent)

    teams_dir = tmp_path / "teams"
    _write_default_team(teams_dir)

    env = {
        "AGENT_AGENT__FRAMEWORK": "identity_capture",
        "AGENT_TEAMS_DIR": str(teams_dir),
        "AGENT_INTERFACE__AUTH__ENABLED": "true",
        "AGENT_INTERFACE__AUTH__SCHEME": "gateway_identity",
    }
    with (
        patch.dict("os.environ", env),
        patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader,
    ):
        MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
        app = create_app()
        with TestClient(app) as client:
            yield client
    FrameworkRegistry.clear()


# ---------------------------------------------------------------------------
# §I1 -- 200 round-trip with full gateway header set
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestGatewayIdentityE2E:
    def test_invoke_with_full_identity_headers_reaches_agent(
        self, gateway_client: TestClient
    ) -> None:
        response = gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test-agent/invoke",
            json={"input": "hello"},
            headers={
                "X-User-ID": "alice",
                "X-Project-ID": TEST_PROJECT_ID,
                "X-User-Email": "alice@example.com",
                "X-User-Name": "Alice Smith",
                "X-User-Token": "raw-user-jwt-secret",
                "X-Correlation-ID": "11111111-1111-4111-8111-111111111111",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["output"] == "ok:hello"

        assert len(_IdentityCapturingAgent.captures) == 1
        cap = _IdentityCapturingAgent.captures[0]

        # ContextVar and context.identity both reach the adapter.
        assert cap["contextvar_user_id"] == "alice"
        assert cap["ctx_user_id_via_identity"] == "alice"
        assert cap["context_identity"]["userId"] == "alice"
        assert cap["context_identity"]["projectId"] == TEST_PROJECT_ID
        assert cap["context_identity"]["userEmail"] == "alice@example.com"
        assert cap["context_identity"]["userName"] == "Alice Smith"
        assert cap["context_identity"]["correlationId"] == "11111111-1111-4111-8111-111111111111"
        # user_token reachable via typed access...
        assert cap["context_user_token"] == "raw-user-jwt-secret"
        assert cap["contextvar_user_token"] == "raw-user-jwt-secret"

    def test_user_token_never_in_serialized_identity(self, gateway_client: TestClient) -> None:
        """§I2 mirror at the integration layer."""
        gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "ping"},
            headers={
                "X-User-ID": "alice",
                "X-Project-ID": TEST_PROJECT_ID,
                "X-User-Token": "raw-user-jwt-secret",
            },
        )
        cap = _IdentityCapturingAgent.captures[0]
        # model_dump(by_alias=True) must omit user_token / userToken entirely.
        dumped = cap["context_identity"]
        assert dumped is not None
        assert "userToken" not in dumped
        assert "user_token" not in dumped
        assert "raw-user-jwt-secret" not in json.dumps(dumped)


# ---------------------------------------------------------------------------
# §I10 -- Missing X-User-ID -> 401 (middleware)
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestGatewayMissingIdentityHeader:
    def test_missing_x_user_id_returns_401(self, gateway_client: TestClient) -> None:
        response = gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            # X-User-ID intentionally absent.
            headers={"X-Project-ID": TEST_PROJECT_ID},
        )
        assert response.status_code == 401, response.text
        # No agent invocation should have occurred.
        assert len(_IdentityCapturingAgent.captures) == 0

    def test_empty_x_user_id_returns_401(self, gateway_client: TestClient) -> None:
        response = gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            headers={"X-User-ID": "   "},
        )
        assert response.status_code == 401, response.text
        assert len(_IdentityCapturingAgent.captures) == 0


# ---------------------------------------------------------------------------
# §C1 -- URL <-> header project parity enforced
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestProjectParityViaHTTP:
    def test_mismatched_project_id_returns_403(self, gateway_client: TestClient) -> None:
        response = gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            headers={
                "X-User-ID": "alice",
                # Deliberately a different project to trigger rule 1.
                "X-Project-ID": "00000000-0000-0000-0000-000000000099",
            },
        )
        assert response.status_code == 403, response.text
        assert len(_IdentityCapturingAgent.captures) == 0
        body = response.json()
        # FastAPI nests the dict-typed detail under "detail".
        assert body["detail"]["error"] == "Project access denied"

    def test_empty_project_id_header_inherits_from_url(self, gateway_client: TestClient) -> None:
        response = gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            headers={"X-User-ID": "alice"},  # no X-Project-ID
        )
        assert response.status_code == 200, response.text
        cap = _IdentityCapturingAgent.captures[0]
        assert cap["context_identity"]["projectId"] == TEST_PROJECT_ID


# ---------------------------------------------------------------------------
# §I12 -- Raw Authorization stripped after middleware
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestAuthorizationStripping:
    def test_authorization_bearer_does_not_replace_user_token_on_explicit_header(
        self, gateway_client: TestClient
    ) -> None:
        """X-User-Token wins when both are present."""
        gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            headers={
                "X-User-ID": "alice",
                "X-Project-ID": TEST_PROJECT_ID,
                "Authorization": "Bearer should-be-ignored",
                "X-User-Token": "wins",
            },
        )
        cap = _IdentityCapturingAgent.captures[0]
        assert cap["context_user_token"] == "wins"

    def test_authorization_bearer_used_when_x_user_token_absent(
        self, gateway_client: TestClient
    ) -> None:
        """§B1 fallback: Authorization extracted as user JWT only when X-User-Token is empty."""
        gateway_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/test/invoke",
            json={"input": "hello"},
            headers={
                "X-User-ID": "alice",
                "X-Project-ID": TEST_PROJECT_ID,
                "Authorization": "Bearer fallback-user-jwt",
            },
        )
        cap = _IdentityCapturingAgent.captures[0]
        assert cap["context_user_token"] == "fallback-user-jwt"


# ---------------------------------------------------------------------------
# §I3 -- Concurrent invokes see isolated identities
# ---------------------------------------------------------------------------


@pytest.fixture
async def gateway_async_app(tmp_path: Any) -> AsyncIterator[Any]:
    """Same env as gateway_client, but exposes the raw ASGI app so the
    concurrent test can drive it with two interleaved httpx.AsyncClient
    requests on the same event loop.
    """
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    _IdentityCapturingAgent.reset()
    FrameworkRegistry.clear()
    FrameworkRegistry.register("identity_capture")(_IdentityCapturingAgent)

    teams_dir = tmp_path / "teams"
    _write_default_team(teams_dir)

    env = {
        "AGENT_AGENT__FRAMEWORK": "identity_capture",
        "AGENT_TEAMS_DIR": str(teams_dir),
        "AGENT_INTERFACE__AUTH__ENABLED": "true",
        "AGENT_INTERFACE__AUTH__SCHEME": "gateway_identity",
    }
    with (
        patch.dict("os.environ", env),
        patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader,
    ):
        MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
        app = create_app()
        # Drive lifespan manually so MCP / TaskManager are wired up.
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as _:
            pass  # warm-up not needed; create_app sets defaults
        # Run lifespan via TestClient context to start/stop background services.
        with TestClient(app):
            yield app
    FrameworkRegistry.clear()


@pytest.mark.integration
@pytest.mark.asyncio
class TestConcurrentIdentityIsolation:
    async def test_two_concurrent_requests_see_distinct_identities(
        self, gateway_async_app: Any
    ) -> None:
        """Fire two POST /invoke calls concurrently with different identities;
        block in the agent until BOTH are mid-flight; verify each got its
        own identity (no cross-task / cross-thread leakage).

        Routes run in their own FastAPI worker threads, so we use a
        thread-safe arrival barrier in the capturing agent to ensure
        both requests are simultaneously inside ``invoke`` before
        releasing -- otherwise a serial request would trivially pass.
        """
        # Configure the agent to hold both requests until they've both arrived.
        _IdentityCapturingAgent.reset()
        _IdentityCapturingAgent.arrival_target = 2

        transport = httpx.ASGITransport(app=gateway_async_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            url = f"{TEST_PROJECT_PREFIX}/agents/test/invoke"

            async def fire(user_id: str) -> httpx.Response:
                return await client.post(
                    url,
                    json={"input": f"from-{user_id}"},
                    headers={
                        "X-User-ID": user_id,
                        "X-Project-ID": TEST_PROJECT_ID,
                        "X-User-Token": f"jwt-for-{user_id}",
                    },
                )

            # Release the agents once both have arrived. Schedule a
            # watchdog that flips ``release_event`` as soon as the
            # arrival barrier fires.
            async def release_when_both_in_flight() -> None:
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    _IdentityCapturingAgent.arrival_event.wait,
                    5.0,
                )
                _IdentityCapturingAgent.release_event.set()

            releaser = asyncio.create_task(release_when_both_in_flight())
            r_alice, r_bob = await asyncio.gather(fire("alice"), fire("bob"))
            await releaser

        assert r_alice.status_code == 200, r_alice.text
        assert r_bob.status_code == 200, r_bob.text
        # Both invokes were genuinely concurrent.
        assert _IdentityCapturingAgent.arrival_event.is_set(), (
            "concurrent invocations never overlapped; isolation test is invalid"
        )

        by_user = {c["contextvar_user_id"]: c for c in _IdentityCapturingAgent.captures}
        assert set(by_user) == {"alice", "bob"}
        # Strict isolation: each request saw its own identity, no peer leakage.
        assert by_user["alice"]["context_user_token"] == "jwt-for-alice"
        assert by_user["bob"]["context_user_token"] == "jwt-for-bob"
        assert by_user["alice"]["context_identity"]["userId"] == "alice"
        assert by_user["bob"]["context_identity"]["userId"] == "bob"
