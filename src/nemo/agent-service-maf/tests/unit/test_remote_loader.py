"""Unit tests for :mod:`agent_service_maf.config.remote_loader`.

The migration suite (:file:`test_config_service_migration.py`) covers
the headline cases — basic agent fetch + cache, team 404, stale-while-
error, agent→team cascade. This file fills in the rest of the
:class:`RemoteConfigCache` surface so coverage tracks the documented
contract end-to-end:

- All four endpoint families have a happy-path + cache-hit + 404
  combination (agents, teams, MCP servers, knowledge bases).
- All four cache families have a single-entry and a bulk
  ``invalidate_*`` test. Cascade-to-teams is verified per family.
- ``list_*`` covers both the bare-array and ``{items:[]}`` /
  ``{data:[]}`` envelope shapes, plus the shape-error case.
- ``_fetch_json_or_none`` covers the four error paths: 404,
  ``HTTPError`` with-and-without stale-while-error, ``>=400`` status
  with-and-without stale-while-error, and non-JSON body.
- ``_shape_error`` truncates long bodies in the message.
- ``is_synchronously_empty`` returns ``False`` (locked).

All network traffic is mocked through ``httpx.MockTransport``; nothing
else is patched.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from agent_service_maf.config.remote_loader import RemoteConfigCache
from agent_service_maf.config.settings import settings as runtime_settings

VALID_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"


# ---------------------------------------------------------------------------
# Test helpers — mirror the migration test's lightweight scaffolding
# ---------------------------------------------------------------------------


class _FakeAuth:
    async def auth_headers(self) -> dict[str, str]:
        return {"Authorization": "Bearer fake"}


def _patch_async_client(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport) -> None:
    real = httpx.AsyncClient

    def make_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.pop("transport", None)
        return real(transport=transport, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", make_client)


def _cache(**overrides: Any) -> RemoteConfigCache:
    defaults: dict[str, Any] = {
        "auth": _FakeAuth(),
        "ttl": 60,
        "max_size": 10,
        "base_url": "http://config",
    }
    defaults.update(overrides)
    return RemoteConfigCache(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def stale_while_error_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin CONFIG_STALE_WHILE_ERROR to False for the duration of a test.

    The runtime default is True and other tests flip it; we lock it
    here so the stale-while-error branches that should NOT trigger
    really don't.
    """
    monkeypatch.setattr(runtime_settings, "CONFIG_STALE_WHILE_ERROR", False)


@pytest.fixture
def stale_while_error_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_settings, "CONFIG_STALE_WHILE_ERROR", True)


# ---------------------------------------------------------------------------
# get_agent: cache hit, 404, non-dict shape
# ---------------------------------------------------------------------------


class TestGetAgent:
    @pytest.mark.asyncio
    async def test_404_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(404)))
        cache = _cache()
        assert await cache.get_agent(VALID_PROJECT_ID, "ghost") is None

    @pytest.mark.asyncio
    async def test_non_dict_response_raises_shape_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The config-service contract says individual records are
        # objects. A JSON array sneaking through must surface as a
        # ValueError so the lazy registry can mark the bundle unhealthy.
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json=["wrong"])),
        )
        cache = _cache()
        with pytest.raises(ValueError, match="Unexpected response shape"):
            await cache.get_agent(VALID_PROJECT_ID, "a1")

    @pytest.mark.asyncio
    async def test_skip_cache_bypasses_read_and_write(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = {"n": 0}
        cached = {"id": "a1", "source": "cache"}
        fresh = {"id": "a1", "source": "fresh"}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=fresh)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        key = RemoteConfigCache._agent_key(VALID_PROJECT_ID, "a1")
        cache._agent_cache[key] = cached
        cache._lkg_agents[key] = cached

        out = await cache.get_agent(VALID_PROJECT_ID, "a1", skip_cache=True)

        assert out == fresh
        assert calls["n"] == 1
        # Existing cache entries are neither read nor overwritten.
        assert cache._agent_cache[key] == cached
        assert cache._lkg_agents[key] == cached


# ---------------------------------------------------------------------------
# list_agents / list_teams — both shapes + cache-hit
# ---------------------------------------------------------------------------


class TestListEndpoints:
    @pytest.mark.asyncio
    async def test_list_agents_accepts_bare_array(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(
                lambda r: httpx.Response(200, json=[{"id": "a1"}, {"id": "a2"}, "not-a-dict"])
            ),
        )
        cache = _cache()
        out = await cache.list_agents(VALID_PROJECT_ID)
        # Non-dict entries are filtered out so the route layer gets a
        # uniform shape.
        assert [item["id"] for item in out] == ["a1", "a2"]

    @pytest.mark.asyncio
    async def test_list_teams_accepts_items_envelope(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json={"items": [{"id": "t1"}]})),
        )
        cache = _cache()
        out = await cache.list_teams(VALID_PROJECT_ID)
        assert [item["id"] for item in out] == ["t1"]

    @pytest.mark.asyncio
    async def test_list_teams_accepts_data_envelope(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # ``data`` is the alternate envelope key — same tolerance as items.
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json={"data": [{"id": "t1"}]})),
        )
        cache = _cache()
        out = await cache.list_teams(VALID_PROJECT_ID)
        assert [item["id"] for item in out] == ["t1"]

    @pytest.mark.asyncio
    async def test_list_agents_404_returns_empty_list(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Listings semantically exist even with no records.
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(404)))
        cache = _cache()
        assert await cache.list_agents(VALID_PROJECT_ID) == []

    @pytest.mark.asyncio
    async def test_list_teams_404_returns_empty_list(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Same semantics as list_agents — distinct code path.
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(404)))
        cache = _cache()
        assert await cache.list_teams(VALID_PROJECT_ID) == []

    @pytest.mark.asyncio
    async def test_envelope_with_non_list_items_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Dict envelope whose ``items``/``data`` is itself not a list —
        # rejected so a config-service contract drift doesn't silently
        # produce an empty listing.
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json={"items": "not a list"})),
        )
        cache = _cache()
        with pytest.raises(ValueError, match="array or"):
            await cache.list_agents(VALID_PROJECT_ID)

    @pytest.mark.asyncio
    async def test_list_agents_caches_within_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=[{"id": "a1"}])

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        first = await cache.list_agents(VALID_PROJECT_ID)
        second = await cache.list_agents(VALID_PROJECT_ID)
        assert first == second
        assert calls["n"] == 1, "Second list must hit the listing cache"

    @pytest.mark.asyncio
    async def test_list_teams_caches_within_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=[{"id": "t1"}])

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.list_teams(VALID_PROJECT_ID)
        await cache.list_teams(VALID_PROJECT_ID)
        assert calls["n"] == 1

    @pytest.mark.asyncio
    async def test_unrecognised_listing_shape_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Neither a bare list nor an envelope dict — explicit failure
        # is required so we never silently 200-empty.
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json="weird")),
        )
        cache = _cache()
        with pytest.raises(ValueError, match="array or"):
            await cache.list_agents(VALID_PROJECT_ID)


# ---------------------------------------------------------------------------
# get_team — covered briefly by migration tests; fill in the cache+shape paths
# ---------------------------------------------------------------------------


class TestGetTeam:
    @pytest.mark.asyncio
    async def test_caches_team_within_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"id": "t1", "members": []})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_team(VALID_PROJECT_ID, "t1")
        await cache.get_team(VALID_PROJECT_ID, "t1")
        assert calls["n"] == 1

    @pytest.mark.asyncio
    async def test_non_dict_response_raises_shape_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json=[1, 2])),
        )
        cache = _cache()
        with pytest.raises(ValueError, match="Unexpected response shape"):
            await cache.get_team(VALID_PROJECT_ID, "t1")

    @pytest.mark.asyncio
    async def test_skip_cache_bypasses_read_and_write(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = {"n": 0}
        cached = {"id": "t1", "members": [{"id": "stale"}]}
        fresh = {"id": "t1", "members": []}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json=fresh)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        key = RemoteConfigCache._team_key(VALID_PROJECT_ID, "t1")
        cache._team_cache[key] = cached
        cache._lkg_teams[key] = cached

        out = await cache.get_team(VALID_PROJECT_ID, "t1", skip_cache=True)

        assert out == fresh
        assert calls["n"] == 1
        assert cache._team_cache[key] == cached
        assert cache._lkg_teams[key] == cached


# ---------------------------------------------------------------------------
# get_mcp_server — entirely uncovered before this file
# ---------------------------------------------------------------------------


class TestGetMcpServer:
    @pytest.mark.asyncio
    async def test_known_server_returns_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(
                lambda r: httpx.Response(
                    200,
                    json={"id": "s1", "name": "demo", "transport": "sse"},
                )
            ),
        )
        cache = _cache()
        got = await cache.get_mcp_server(VALID_PROJECT_ID, "s1")
        assert got is not None and got["id"] == "s1"

    @pytest.mark.asyncio
    async def test_caches_within_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"id": "s1"})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_mcp_server(VALID_PROJECT_ID, "s1")
        await cache.get_mcp_server(VALID_PROJECT_ID, "s1")
        assert calls["n"] == 1

    @pytest.mark.asyncio
    async def test_404_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(404)))
        cache = _cache()
        assert await cache.get_mcp_server(VALID_PROJECT_ID, "ghost") is None

    @pytest.mark.asyncio
    async def test_non_dict_response_raises_shape_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json="oops")),
        )
        cache = _cache()
        with pytest.raises(ValueError):
            await cache.get_mcp_server(VALID_PROJECT_ID, "s1")


# ---------------------------------------------------------------------------
# get_knowledge_base — entirely uncovered before this file
# ---------------------------------------------------------------------------


class TestGetKnowledgeBase:
    @pytest.mark.asyncio
    async def test_known_kb_returns_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "kb1", "name": "Docs"})),
        )
        cache = _cache()
        got = await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")
        assert got is not None and got["id"] == "kb1"

    @pytest.mark.asyncio
    async def test_caches_within_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"id": "kb1"})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")
        await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")
        assert calls["n"] == 1

    @pytest.mark.asyncio
    async def test_404_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(404)))
        cache = _cache()
        assert await cache.get_knowledge_base(VALID_PROJECT_ID, "ghost") is None

    @pytest.mark.asyncio
    async def test_non_dict_response_raises_shape_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json=42)),
        )
        cache = _cache()
        with pytest.raises(ValueError):
            await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")


# ---------------------------------------------------------------------------
# Invalidation — single + bulk + cascade for all four families
# ---------------------------------------------------------------------------


class TestInvalidation:
    @pytest.mark.asyncio
    async def test_invalidate_agent_bulk_clears_all_project_agents(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Seed two agents + the agents listing + a team in the same
        # project, then verify the bulk invalidation drops all of
        # them (and cascades into the team cache).
        def handler(req: httpx.Request) -> httpx.Response:
            path = req.url.path
            if path.endswith("/agents/a1"):
                return httpx.Response(200, json={"id": "a1"})
            if path.endswith("/agents/a2"):
                return httpx.Response(200, json={"id": "a2"})
            if path.endswith("/agents"):
                return httpx.Response(200, json=[{"id": "a1"}, {"id": "a2"}])
            if path.endswith("/agent-teams/t1"):
                return httpx.Response(200, json={"id": "t1", "members": []})
            return httpx.Response(404)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_agent(VALID_PROJECT_ID, "a1")
        await cache.get_agent(VALID_PROJECT_ID, "a2")
        await cache.list_agents(VALID_PROJECT_ID)
        await cache.get_team(VALID_PROJECT_ID, "t1")

        assert len(cache._agent_cache) == 2
        assert cache._listing_cache  # has the agents listing
        assert len(cache._team_cache) == 1

        # Bulk invalidate: no agent_id → drop every agent in this project,
        # the listing, and (via cascade) the team cache for this project.
        cache.invalidate_agent(VALID_PROJECT_ID)

        assert cache._agent_cache == {}
        assert cache._team_cache == {}
        # The listing for this project's agents must also be gone.
        assert (
            RemoteConfigCache._listing_key("agents", VALID_PROJECT_ID) not in cache._listing_cache
        )

    @pytest.mark.asyncio
    async def test_invalidate_team_single_and_bulk(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": req.url.path.rsplit("/", 1)[1]})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_team(VALID_PROJECT_ID, "t1")
        await cache.get_team(VALID_PROJECT_ID, "t2")
        await cache.list_teams(VALID_PROJECT_ID)
        assert len(cache._team_cache) == 2

        # Single-id form drops just that one.
        cache.invalidate_team(VALID_PROJECT_ID, "t1")
        team_keys = list(cache._team_cache)
        assert RemoteConfigCache._team_key(VALID_PROJECT_ID, "t1") not in team_keys
        assert RemoteConfigCache._team_key(VALID_PROJECT_ID, "t2") in team_keys

        # Bulk form drops the rest and the listing.
        cache.invalidate_team(VALID_PROJECT_ID)
        assert cache._team_cache == {}
        assert RemoteConfigCache._listing_key("teams", VALID_PROJECT_ID) not in cache._listing_cache

    @pytest.mark.asyncio
    async def test_invalidate_knowledge_base_cascades_to_teams(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Team bundles embed synthesized kb_retrieve bindings — any KB
        # change has to re-flow into the bundles, so KB invalidation
        # must cascade into the team cache for the same project.
        def handler(req: httpx.Request) -> httpx.Response:
            path = req.url.path
            if "/knowledgebases/kb1" in path:
                return httpx.Response(200, json={"id": "kb1"})
            if "/agent-teams/t1" in path:
                return httpx.Response(200, json={"id": "t1"})
            return httpx.Response(404)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")
        await cache.get_team(VALID_PROJECT_ID, "t1")
        assert cache._kb_cache and cache._team_cache

        # Single-id form: drop just kb1, but still cascade to teams.
        cache.invalidate_knowledge_base(VALID_PROJECT_ID, "kb1")
        assert RemoteConfigCache._kb_key(VALID_PROJECT_ID, "kb1") not in cache._kb_cache
        assert cache._team_cache == {}, "KB invalidation must cascade to teams"

    @pytest.mark.asyncio
    async def test_invalidate_knowledge_base_bulk(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": req.url.path.rsplit("/", 1)[1]})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_knowledge_base(VALID_PROJECT_ID, "kb1")
        await cache.get_knowledge_base(VALID_PROJECT_ID, "kb2")
        assert len(cache._kb_cache) == 2

        cache.invalidate_knowledge_base(VALID_PROJECT_ID)
        assert cache._kb_cache == {}

    @pytest.mark.asyncio
    async def test_invalidate_mcp_server_cascades_to_teams(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            path = req.url.path
            if "/mcp-servers/" in path:
                return httpx.Response(200, json={"id": "s1"})
            if "/agent-teams/" in path:
                return httpx.Response(200, json={"id": "t1"})
            return httpx.Response(404)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_mcp_server(VALID_PROJECT_ID, "s1")
        await cache.get_team(VALID_PROJECT_ID, "t1")

        cache.invalidate_mcp_server(VALID_PROJECT_ID, "s1")
        assert RemoteConfigCache._mcp_key(VALID_PROJECT_ID, "s1") not in cache._mcp_cache
        assert cache._team_cache == {}, "MCP invalidation must cascade to teams"

    @pytest.mark.asyncio
    async def test_invalidate_mcp_server_bulk(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": req.url.path.rsplit("/", 1)[1]})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_mcp_server(VALID_PROJECT_ID, "s1")
        await cache.get_mcp_server(VALID_PROJECT_ID, "s2")
        cache.invalidate_mcp_server(VALID_PROJECT_ID)
        assert cache._mcp_cache == {}


# ---------------------------------------------------------------------------
# _fetch_json_or_none — error paths
# ---------------------------------------------------------------------------


class TestFetchJsonOrNone:
    @pytest.mark.asyncio
    async def test_network_error_re_raises_without_stale_while_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
        stale_while_error_off: None,
    ) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("boom")

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        with pytest.raises(httpx.ConnectError):
            await cache.get_agent(VALID_PROJECT_ID, "a1")

    @pytest.mark.asyncio
    async def test_500_status_re_raises_without_stale_while_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
        stale_while_error_off: None,
    ) -> None:
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda r: httpx.Response(500)))
        cache = _cache()
        with pytest.raises(httpx.HTTPStatusError):
            await cache.get_agent(VALID_PROJECT_ID, "a1")

    @pytest.mark.asyncio
    async def test_500_status_serves_stale_when_lkg_present(
        self,
        monkeypatch: pytest.MonkeyPatch,
        stale_while_error_on: None,
    ) -> None:
        # Seed the LKG with a successful response, then flip to 500 and
        # confirm the LKG payload is served. This exercises the
        # ``resp.status_code >= 400 and lkg_key in lkg_store`` branch
        # which is distinct from the network-error branch covered by
        # the migration suite.
        seq: list[httpx.Response] = [
            httpx.Response(200, json={"id": "a1"}),
            httpx.Response(500),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            return seq.pop(0)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        first = await cache.get_agent(VALID_PROJECT_ID, "a1")
        # Force TTL expiry so the second call hits the network path.
        cache._agent_cache.clear()
        second = await cache.get_agent(VALID_PROJECT_ID, "a1")
        assert first == second
        assert cache.status_snapshot()["stale_serves"] >= 1

    @pytest.mark.asyncio
    async def test_skip_cache_disables_stale_while_error_fallback(
        self,
        monkeypatch: pytest.MonkeyPatch,
        stale_while_error_on: None,
    ) -> None:
        seq: list[object] = [
            httpx.Response(200, json={"id": "a1"}),
            httpx.ConnectError("boom"),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            item = seq.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        key = RemoteConfigCache._agent_key(VALID_PROJECT_ID, "a1")

        await cache.get_agent(VALID_PROJECT_ID, "a1")
        assert key in cache._lkg_agents  # prove stale fallback was available

        with pytest.raises(httpx.ConnectError):
            await cache.get_agent(VALID_PROJECT_ID, "a1", skip_cache=True)

    @pytest.mark.asyncio
    async def test_non_json_response_raises_shape_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The shape helper is the last line of _fetch_json_or_none —
        # exercise the ValueError-from-json path explicitly.
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, text="not json at all")),
        )
        cache = _cache()
        with pytest.raises(ValueError, match="Unexpected response shape"):
            await cache.get_agent(VALID_PROJECT_ID, "a1")


# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------


class TestIsSynchronouslyEmpty:
    def test_returns_false_unconditionally(self) -> None:
        # Locked behaviour — the remote source cannot know whether
        # config-service has data without a round trip, so the
        # synchronous probe always says "may not be empty".
        cache = _cache()
        assert cache.is_synchronously_empty() is False


class TestStatusSnapshot:
    @pytest.mark.asyncio
    async def test_snapshot_counts_caches_and_hit_rate(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # One agent fetch + one cache hit → 50% hit rate.
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": "a1"})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = _cache()
        await cache.get_agent(VALID_PROJECT_ID, "a1")
        await cache.get_agent(VALID_PROJECT_ID, "a1")

        snap = cache.status_snapshot()
        assert snap["agents"] == 1
        assert snap["hits"] == 1
        assert snap["misses"] == 1
        assert snap["hit_rate_pct"] == 50.0
        assert snap["ttl_seconds"] == 60
        assert snap["max_size"] == 10

    def test_snapshot_hit_rate_is_zero_when_no_traffic(self) -> None:
        snap = _cache().status_snapshot()
        assert snap["hits"] == 0
        assert snap["misses"] == 0
        assert snap["hit_rate_pct"] == 0.0


class TestShapeError:
    def test_long_body_is_truncated_to_200_chars(self) -> None:
        # The truncation branch matters because some config-service
        # responses (e.g. HTML error pages) can be megabytes — we don't
        # want the whole thing in the exception message.
        long_payload = "x" * 500
        err = RemoteConfigCache._shape_error(
            "http://config/agents/a1", long_payload, expected="object"
        )
        assert isinstance(err, ValueError)
        msg = str(err)
        assert "..." in msg
        # The whole 500-char body must not appear verbatim.
        assert long_payload not in msg

    def test_short_body_is_included_verbatim(self) -> None:
        err = RemoteConfigCache._shape_error("http://config/agents/a1", "tiny", expected="object")
        assert "'tiny'" in str(err)
        assert "..." not in str(err)


class TestKeyHelpers:
    """The cache key helpers are small but cross every code path that
    routes lookups; locking their format prevents an accidental rename
    from quietly turning every cache lookup into a miss."""

    def test_agent_key_format(self) -> None:
        assert RemoteConfigCache._agent_key("p1", "a1") == "agent:p1:a1"

    def test_team_key_format(self) -> None:
        assert RemoteConfigCache._team_key("p1", "t1") == "team:p1:t1"

    def test_mcp_key_format(self) -> None:
        assert RemoteConfigCache._mcp_key("p1", "s1") == "mcp:p1:s1"

    def test_kb_key_format(self) -> None:
        assert RemoteConfigCache._kb_key("p1", "kb1") == "kb:p1:kb1"

    def test_listing_key_format(self) -> None:
        assert RemoteConfigCache._listing_key("agents", "p1") == "agents:p1"


# ---------------------------------------------------------------------------
# Connection-pool reuse + aclose
# ---------------------------------------------------------------------------


class TestHttpClientPooling:
    """Regression tests for the long-lived ``httpx.AsyncClient``. The
    cache must NOT create a fresh client per fetch (which defeats
    connection pooling and burns ephemeral ports under load)."""

    @pytest.mark.asyncio
    async def test_constructor_creates_a_single_client(self) -> None:
        cache = _cache()
        client = cache._http_client
        assert isinstance(client, httpx.AsyncClient)

    @pytest.mark.asyncio
    async def test_multiple_fetches_reuse_the_same_client_instance(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "a"})),
        )
        cache = _cache()
        client_before = cache._http_client
        await cache.get_agent(VALID_PROJECT_ID, "a1")
        await cache.get_agent(VALID_PROJECT_ID, "a2")
        await cache.get_team(VALID_PROJECT_ID, "t1")
        # The constructor-built client must still be the one in use —
        # not replaced by a transient ``async with`` somewhere in the
        # fetch path.
        assert cache._http_client is client_before

    @pytest.mark.asyncio
    async def test_aclose_releases_the_client(self) -> None:
        cache = _cache()
        await cache.aclose()
        # httpx surfaces is_closed on its client; the cache must have
        # propagated the close.
        assert cache._http_client.is_closed is True

    @pytest.mark.asyncio
    async def test_aclose_is_idempotent(self) -> None:
        # Lifespan shutdown may be called more than once in some test
        # harnesses; aclose must not raise on a re-close.
        cache = _cache()
        await cache.aclose()
        await cache.aclose()  # second call must not raise
