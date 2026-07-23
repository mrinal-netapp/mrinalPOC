"""Unit test — `ProjectVKResolver` per-project Bifrost VK fetching.

Pins the contract that mirrors the legacy
``agent-service/llmproxy_gateway_settings::llmproxy_gateway_api_key_for_model``
flow: fetch ``gatewayApiKey`` from config-service per project, cache
with TTL, fail loudly on miss (no env fallback for per-project chat
completions).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from agent_service_maf.gateway.project_vk_resolver import (
    MissingProjectVirtualKeyError,
    ProjectVKResolver,
)

# ---------------------------------------------------------------------------
# Fixture: a mocked httpx client returning a configurable response
# ---------------------------------------------------------------------------


class _StubHttpClient:
    """Tiny stub of httpx.AsyncClient with a settable `next_response`."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str]]] = []
        # Per-call queue of responses (FIFO). If empty, raises.
        self._queue: list[httpx.Response] = []

    def enqueue_json(self, body: dict[str, Any], status_code: int = 200, *, url: str = "") -> None:
        req = httpx.Request("GET", url or "http://test/dummy")
        self._queue.append(httpx.Response(status_code, json=body, request=req))

    def enqueue_status(self, status_code: int, *, url: str = "", text: str = "") -> None:
        req = httpx.Request("GET", url or "http://test/dummy")
        self._queue.append(httpx.Response(status_code, text=text or "(no body)", request=req))

    def enqueue_error(self, exc: Exception) -> None:
        self._queue.append(exc)  # type: ignore[arg-type]

    async def get(self, url: str, headers: dict[str, str] | None = None) -> httpx.Response:
        self.calls.append((url, headers or {}))
        if not self._queue:
            raise RuntimeError("StubHttpClient: no queued response")
        item = self._queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def http() -> _StubHttpClient:
    return _StubHttpClient()


@pytest.fixture
def resolver(http: _StubHttpClient) -> ProjectVKResolver:
    return ProjectVKResolver(
        config_service_url="http://config.test",
        http_client=http,  # type: ignore[arg-type]
        ttl_seconds=60,
    )


# ---------------------------------------------------------------------------
# (1) Happy path
# ---------------------------------------------------------------------------


async def test_returns_gateway_api_key_from_models_route(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_json(
        {
            "id": "gpt-4o-mini",
            "gatewayApiKey": "vk-project-A-bearer-1234",
            "gatewayModelId": "openai/gpt-4o-mini",
        }
    )

    vk = await resolver.get_for_project("proj-A", "gpt-4o-mini")

    assert vk == "vk-project-A-bearer-1234"
    assert http.calls == [("http://config.test/api/v1/projects/proj-A/models/gpt-4o-mini", {})]


async def test_accepts_snake_case_wire_field(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    """The legacy wire format uses camelCase but the helper falls back
    to snake_case for forward-compat. Pin both."""
    http.enqueue_json({"id": "x", "gateway_api_key": "vk-snake"})
    vk = await resolver.get_for_project("p", "x")
    assert vk == "vk-snake"


async def test_strips_trailing_slash_on_config_service_url(
    http: _StubHttpClient,
) -> None:
    r = ProjectVKResolver(
        config_service_url="http://config.test/",
        http_client=http,  # type: ignore[arg-type]
    )
    http.enqueue_json({"gatewayApiKey": "vk-x"})
    await r.get_for_project("p", "m")
    # URL must NOT have a double slash.
    assert http.calls[0][0] == "http://config.test/api/v1/projects/p/models/m"


# ---------------------------------------------------------------------------
# (2) Cache hit
# ---------------------------------------------------------------------------


async def test_second_call_hits_cache(http: _StubHttpClient, resolver: ProjectVKResolver) -> None:
    """A second call for the same project_id returns the cached VK
    without a second HTTP request. Locks the per-project (NOT
    per-model) caching contract."""
    http.enqueue_json({"gatewayApiKey": "vk-cached"})
    first = await resolver.get_for_project("proj-cached", "model-1")
    # Different model_id hint — same project. Must hit cache.
    second = await resolver.get_for_project("proj-cached", "model-2")
    assert first == second == "vk-cached"
    assert len(http.calls) == 1, "Second lookup must hit the cache"


# ---------------------------------------------------------------------------
# (3) Invalidate
# ---------------------------------------------------------------------------


async def test_invalidate_clears_one_project(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_json({"gatewayApiKey": "vk-1"})
    await resolver.get_for_project("p1", "m")
    # Invalidate, expect a re-fetch on next call.
    resolver.invalidate("p1")
    http.enqueue_json({"gatewayApiKey": "vk-2-rotated"})
    vk = await resolver.get_for_project("p1", "m")
    assert vk == "vk-2-rotated"
    assert len(http.calls) == 2


async def test_invalidate_unknown_project_is_no_op(
    resolver: ProjectVKResolver,
) -> None:
    # Must not raise even if no entry is cached.
    resolver.invalidate("never-cached")


async def test_invalidate_all_clears_every_entry(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_json({"gatewayApiKey": "vk-A"})
    http.enqueue_json({"gatewayApiKey": "vk-B"})
    await resolver.get_for_project("a", "m")
    await resolver.get_for_project("b", "m")
    resolver.invalidate_all()
    # Both projects must re-fetch.
    http.enqueue_json({"gatewayApiKey": "vk-A-new"})
    http.enqueue_json({"gatewayApiKey": "vk-B-new"})
    assert await resolver.get_for_project("a", "m") == "vk-A-new"
    assert await resolver.get_for_project("b", "m") == "vk-B-new"


# ---------------------------------------------------------------------------
# (4) Failure modes — never fall back to env var
# ---------------------------------------------------------------------------


async def test_404_raises_missing_vk_error(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_status(404, text='{"error": "model not found"}')
    with pytest.raises(MissingProjectVirtualKeyError, match="not found in project"):
        await resolver.get_for_project("p", "no-such-model")


async def test_5xx_raises_missing_vk_error(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_status(503, text="service unavailable")
    with pytest.raises(MissingProjectVirtualKeyError, match="503"):
        await resolver.get_for_project("p", "m")


async def test_network_error_raises_missing_vk_error(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_error(httpx.ConnectError("ECONNREFUSED"))
    with pytest.raises(MissingProjectVirtualKeyError, match="unreachable"):
        await resolver.get_for_project("p", "m")


async def test_200_without_gateway_api_key_raises(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    """200 response but no `gatewayApiKey` field — config-service is
    healthy but the project's VK Secret is missing. This is the most
    operationally-important error path; the message must guide
    operators to ProjectInitWorkflow."""
    http.enqueue_json({"id": "gpt-4o", "gatewayApiKey": ""})
    with pytest.raises(MissingProjectVirtualKeyError, match="ProjectInitWorkflow"):
        await resolver.get_for_project("p", "gpt-4o")


async def test_200_with_non_string_gateway_api_key_raises(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    """Defensive: a malformed response with `gatewayApiKey: null`
    or `gatewayApiKey: 12345` must not crash silently."""
    http.enqueue_json({"gatewayApiKey": None})
    with pytest.raises(MissingProjectVirtualKeyError):
        await resolver.get_for_project("p", "m")

    http.enqueue_json({"gatewayApiKey": 12345})
    with pytest.raises(MissingProjectVirtualKeyError):
        await resolver.get_for_project("p2", "m")


async def test_empty_project_id_raises(resolver: ProjectVKResolver) -> None:
    with pytest.raises(MissingProjectVirtualKeyError, match="project_id is required"):
        await resolver.get_for_project("", "m")


async def test_empty_model_id_hint_raises(resolver: ProjectVKResolver) -> None:
    """Without a model_id we can't look up /models/:id. The error
    guides the operator to set `gateway.default_model` on the team
    config."""
    with pytest.raises(MissingProjectVirtualKeyError, match="gateway.default_model"):
        await resolver.get_for_project("p", "")


# ---------------------------------------------------------------------------
# (5) Service-account auth headers merged in
# ---------------------------------------------------------------------------


class _StubServiceAuth:
    def __init__(self, headers: dict[str, str]) -> None:
        self._headers = headers
        self.call_count = 0

    async def auth_headers(self) -> dict[str, str]:
        self.call_count += 1
        return dict(self._headers)


async def test_service_auth_headers_are_sent(http: _StubHttpClient) -> None:
    auth = _StubServiceAuth({"Authorization": "Bearer svc-token-abc"})
    r = ProjectVKResolver(
        config_service_url="http://config.test",
        http_client=http,  # type: ignore[arg-type]
        service_auth=auth,
    )
    http.enqueue_json({"gatewayApiKey": "vk"})
    await r.get_for_project("p", "m")
    assert http.calls[0][1] == {"Authorization": "Bearer svc-token-abc"}
    assert auth.call_count == 1


async def test_service_auth_failure_does_not_block_call(
    http: _StubHttpClient,
) -> None:
    """If the service-account client itself fails to mint a token,
    the resolver proceeds with no auth headers and lets the eventual
    config-service response decide. Avoids one transient Keycloak
    blip taking down VK resolution cluster-wide."""
    failing_auth = AsyncMock()
    failing_auth.auth_headers = AsyncMock(side_effect=RuntimeError("kc down"))
    r = ProjectVKResolver(
        config_service_url="http://config.test",
        http_client=http,  # type: ignore[arg-type]
        service_auth=failing_auth,
    )
    http.enqueue_json({"gatewayApiKey": "vk"})
    vk = await r.get_for_project("p", "m")
    assert vk == "vk"
    assert http.calls[0][1] == {}


# ---------------------------------------------------------------------------
# (6) Status snapshot
# ---------------------------------------------------------------------------


async def test_status_snapshot_reflects_cache_state(
    http: _StubHttpClient, resolver: ProjectVKResolver
) -> None:
    http.enqueue_json({"gatewayApiKey": "vk-A"})
    http.enqueue_json({"gatewayApiKey": "vk-B"})
    await resolver.get_for_project("a", "m")
    await resolver.get_for_project("b", "m")
    snap = resolver.status_snapshot()
    assert snap["size"] == 2
    assert snap["max_size"] == 200
    assert snap["ttl_seconds"] == 60
