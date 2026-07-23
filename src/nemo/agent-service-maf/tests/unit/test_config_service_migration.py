"""Unit tests for the config-service migration layer.

Coverage map (matches plan §7 — Testing):

1. ``ConfigLoader`` dict path — feed a dict via ``json_config_data=`` and
   confirm env merge still applies, secrets are rejected, locked fields
   blocked in request_overrides, ``reload_json`` / ``update_json_data``
   clear the secret-check cache so a fresh payload is re-verified.
2. ``RemoteConfigCache`` agent + team caches — TTL, 404 propagation,
   hit/miss counters, agent invalidation cascades to teams, stale-while-
   error fallback.
3. ``ServiceAccountClient`` — token caching, refresh leeway, error
   surfacing.
4. ``LazyTeamRegistry`` — single-flight semantics, scope branching,
   eviction.
5. Composition helpers — agent record → SK agent, team blob → MAF
   payload, synthetic single-agent team shape.
6. ``FileConfigLoader`` — listing + back-compat for inlined-agents team
   JSONs.

All tests rely only on stdlib + ``httpx.MockTransport``; no live network.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.file_loader import FileConfigLoader
from agent_service_maf.config.remote_adapter import (
    agent_record_to_sk_agent,
    knowledge_base_record_to_function_binding,
    mcp_server_record_to_inline_config,
    synthetic_single_agent_team,
    team_blob_to_maf_payload,
)
from agent_service_maf.config.remote_loader import RemoteConfigCache
from agent_service_maf.config.service_auth import ServiceAccountClient
from agent_service_maf.config.settings import Settings
from agent_service_maf.config.settings import settings as runtime_settings
from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.core.query_options import QueryOptions
from agent_service_maf.core.team_registry_lazy import LazyTeamRegistry

# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


VALID_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"


def _make_payload(*, project_id: str = VALID_PROJECT_ID) -> dict[str, Any]:
    """Minimal MAF-shaped payload that survives ``AgentConfig`` validation."""
    return {
        "project_id": project_id,
        "_team_id": "team-x",
        "_team_name": "Team X",
        "agent": {"framework": "maf", "model": "azure/gpt-5.4"},
        "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
        "memory": {"enabled": False},
        "guardrails": {"enabled": False},
        "semantic_kernel": {
            "agents": [
                {
                    "name": "analyst",
                    "instructions": "be helpful",
                    "tools": [],
                    "mcp_servers": [],
                }
            ],
            "orchestration": {"type": "single"},
        },
    }


@pytest.fixture(autouse=True)
def _clean_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip AGENT_* env vars so loader merges are deterministic."""
    import os

    for key in list(os.environ):
        if key.startswith("AGENT_"):
            monkeypatch.delenv(key, raising=False)


# ---------------------------------------------------------------------------
# 1) ConfigLoader dict path
# ---------------------------------------------------------------------------


class TestConfigLoaderDictPath:
    """``ConfigLoader(json_config_data=...)`` shares the file path's contract."""

    def test_dict_payload_resolves_to_agent_config(self) -> None:
        loader = ConfigLoader(json_config_data=_make_payload())
        cfg = loader.resolve()
        assert cfg.agent.framework == "maf"
        assert cfg.semantic_kernel.agents[0].name == "analyst"

    def test_dict_payload_runs_secret_check(self) -> None:
        bad = _make_payload()
        bad["gateway"]["api_key"] = "sk-leaked"
        loader = ConfigLoader(json_config_data=bad)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        assert "secret" in str(exc_info.value).lower()

    def test_dict_payload_empty_secret_allowed(self) -> None:
        # Empty-string secrets are the documented placeholder for "this
        # secret comes from env"; resolve() must accept them.
        ok = _make_payload()
        ok["gateway"]["api_key"] = ""
        cfg = ConfigLoader(json_config_data=ok).resolve()
        assert cfg.gateway.api_key == ""

    def test_dict_payload_locked_fields_in_request_overrides_rejected(self) -> None:
        loader = ConfigLoader(json_config_data=_make_payload())
        with pytest.raises(ConfigurationError):
            loader.resolve(request_overrides={"agent": {"framework": "echo"}})

    def test_env_merges_over_dict_tier(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.1")
        loader = ConfigLoader(json_config_data=_make_payload())
        cfg = loader.resolve()
        # JSON tier wins over env tier per the documented precedence —
        # JSON has no temperature so env shows through.
        assert cfg.agent.temperature == 0.1

    def test_update_json_data_refreshes_secret_check(self) -> None:
        loader = ConfigLoader(json_config_data=_make_payload())
        loader.resolve()
        # First resolve cached the parsed dict. Push a new payload that
        # contains a secret and confirm the next resolve catches it.
        bad = _make_payload()
        bad["gateway"]["api_key"] = "sk-now-leaked"
        loader.update_json_data(bad)
        with pytest.raises(ConfigurationError):
            loader.resolve()


# ---------------------------------------------------------------------------
# 2) RemoteConfigCache
# ---------------------------------------------------------------------------


class _FakeAuth:
    """Minimal ServiceAccountClient stand-in for tests."""

    async def auth_headers(self) -> dict[str, str]:
        return {"Authorization": "Bearer fake"}


def _patch_async_client(monkeypatch: pytest.MonkeyPatch, transport: httpx.MockTransport) -> None:
    """Route all ``httpx.AsyncClient`` instantiations through ``transport``.

    Captures the original constructor outside the lambda so the patch is
    not recursive (the lambda itself becomes ``httpx.AsyncClient`` after
    the setattr, so calling it again would recurse forever — capture
    once, call the original).
    """
    real_async_client = httpx.AsyncClient

    def make_client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        # Tests don't care about the constructor's transport arg; we
        # always force the mock transport.
        kwargs.pop("transport", None)
        return real_async_client(transport=transport, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", make_client)


class TestRemoteConfigCache:
    """End-to-end against ``httpx.MockTransport`` so the cache exercises a
    realistic HTTP path (auth header, timeout, JSON parse)."""

    @pytest.mark.asyncio
    async def test_get_agent_caches_and_counters_increment(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"id": "a1", "name": "analyst"})

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = RemoteConfigCache(
            auth=_FakeAuth(),  # type: ignore[arg-type]
            ttl=60,
            max_size=10,
            base_url="http://config",
        )
        a = await cache.get_agent(VALID_PROJECT_ID, "a1")
        b = await cache.get_agent(VALID_PROJECT_ID, "a1")
        assert a is not None and a["id"] == "a1"
        assert b is a, "Second fetch must hit the cache"
        assert calls["n"] == 1
        snap = cache.status_snapshot()
        assert snap["hits"] >= 1 and snap["misses"] == 1

    @pytest.mark.asyncio
    async def test_get_team_404_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_async_client(monkeypatch, httpx.MockTransport(lambda req: httpx.Response(404)))
        cache = RemoteConfigCache(
            auth=_FakeAuth(),  # type: ignore[arg-type]
            ttl=60,
            max_size=10,
            base_url="http://config",
        )
        assert await cache.get_team(VALID_PROJECT_ID, "missing") is None

    @pytest.mark.asyncio
    async def test_agent_invalidation_cascades_to_team_cache(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            if "/agents/" in req.url.path:
                return httpx.Response(200, json={"id": "a1"})
            if "/agent-teams/" in req.url.path:
                return httpx.Response(200, json={"id": "t1", "members": []})
            return httpx.Response(404)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = RemoteConfigCache(
            auth=_FakeAuth(),  # type: ignore[arg-type]
            ttl=60,
            max_size=10,
            base_url="http://config",
        )
        await cache.get_agent(VALID_PROJECT_ID, "a1")
        await cache.get_team(VALID_PROJECT_ID, "t1")
        # Sanity: both cached.
        assert RemoteConfigCache._agent_key(VALID_PROJECT_ID, "a1") in cache._agent_cache
        assert RemoteConfigCache._team_key(VALID_PROJECT_ID, "t1") in cache._team_cache
        # Cascade: invalidating the agent must drop the team too.
        cache.invalidate_agent(VALID_PROJECT_ID, "a1")
        assert RemoteConfigCache._agent_key(VALID_PROJECT_ID, "a1") not in cache._agent_cache
        assert RemoteConfigCache._team_key(VALID_PROJECT_ID, "t1") not in cache._team_cache

    @pytest.mark.asyncio
    async def test_stale_while_error_serves_last_known_good(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # First call succeeds, then transport raises a ConnectError. With
        # stale-while-error enabled the cache should serve the previously
        # fetched payload rather than re-raise.
        runtime_settings.CONFIG_STALE_WHILE_ERROR = True
        seq: list[httpx.Response | Exception] = [
            httpx.Response(200, json={"id": "a1"}),
            httpx.ConnectError("boom"),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            item = seq.pop(0)
            if isinstance(item, Exception):
                raise item
            return item

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        cache = RemoteConfigCache(
            auth=_FakeAuth(),  # type: ignore[arg-type]
            ttl=0,
            max_size=10,
            base_url="http://config",
        )
        first = await cache.get_agent(VALID_PROJECT_ID, "a1")
        # Force TTL expiry so the second call hits the network path.
        await asyncio.sleep(0)
        cache._agent_cache.clear()
        second = await cache.get_agent(VALID_PROJECT_ID, "a1")
        assert first == second == {"id": "a1"}
        assert cache.status_snapshot()["stale_serves"] >= 1


# ---------------------------------------------------------------------------
# 3) ServiceAccountClient
# ---------------------------------------------------------------------------


class TestServiceAccountClient:
    @pytest.mark.asyncio
    async def test_caches_token_until_refresh_leeway(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        def handler(req: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(
                200,
                json={"access_token": "abc", "expires_in": 300, "token_type": "Bearer"},
            )

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        client = ServiceAccountClient(
            issuer="https://kc/realms/r",
            client_id="cid",
            client_secret="secret",
            refresh_leeway_seconds=60,
        )
        h1 = await client.auth_headers()
        h2 = await client.auth_headers()
        assert h1 == h2 == {"Authorization": "Bearer abc"}
        assert calls["n"] == 1

    @pytest.mark.asyncio
    async def test_refresh_after_leeway(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Tiny expiry + zero leeway forces an immediate refresh on the
        # second call.
        seq = [
            httpx.Response(
                200, json={"access_token": "t1", "expires_in": 1, "token_type": "Bearer"}
            ),
            httpx.Response(
                200, json={"access_token": "t2", "expires_in": 60, "token_type": "Bearer"}
            ),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            return seq.pop(0)

        _patch_async_client(monkeypatch, httpx.MockTransport(handler))
        client = ServiceAccountClient(
            issuer="https://kc/realms/r",
            client_id="cid",
            client_secret="secret",
            refresh_leeway_seconds=0,
        )
        await client.auth_headers()
        # Force the cached token to expire immediately.
        client._expires_at = time.monotonic() - 1.0
        h = await client.auth_headers()
        assert h == {"Authorization": "Bearer t2"}

    @pytest.mark.asyncio
    async def test_non_2xx_surfaces_configuration_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_async_client(
            monkeypatch,
            httpx.MockTransport(lambda req: httpx.Response(401, json={"error": "invalid_client"})),
        )
        client = ServiceAccountClient(
            issuer="https://kc/realms/r",
            client_id="cid",
            client_secret="secret",
        )
        with pytest.raises(ConfigurationError):
            await client.auth_headers()


# ---------------------------------------------------------------------------
# 4) LazyTeamRegistry
# ---------------------------------------------------------------------------


class _StubSource:
    """In-memory ConfigSource for registry tests — no HTTP required."""

    def __init__(
        self,
        *,
        teams: dict[tuple[str, str], dict[str, Any]] | None = None,
        agents: dict[tuple[str, str], dict[str, Any]] | None = None,
        mcp_servers: dict[tuple[str, str], dict[str, Any]] | None = None,
        kbs: dict[tuple[str, str], dict[str, Any]] | None = None,
    ) -> None:
        self.teams = teams or {}
        self.agents = agents or {}
        self.mcp_servers = mcp_servers or {}
        self.kbs = kbs or {}
        self.team_calls = 0
        self.agent_calls = 0
        self.mcp_calls = 0
        self.kb_calls = 0

    async def get_team(
        self, pid: str, tid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.team_calls += 1
        return self.teams.get((pid, tid))

    async def get_agent(
        self, pid: str, aid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.agent_calls += 1
        return self.agents.get((pid, aid))

    async def get_mcp_server(
        self, pid: str, sid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.mcp_calls += 1
        return self.mcp_servers.get((pid, sid))

    async def get_knowledge_base(
        self, pid: str, kid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.kb_calls += 1
        return self.kbs.get((pid, kid))

    async def list_teams(self, pid: str) -> list[dict[str, Any]]:
        return [{"id": tid, "name": tid} for (p, tid) in self.teams if p == pid]

    async def list_agents(self, pid: str) -> list[dict[str, Any]]:
        return [{"id": aid, "name": aid} for (p, aid) in self.agents if p == pid]


class TestLazyTeamRegistry:
    @pytest.mark.asyncio
    async def test_get_or_load_team_single_flight(self) -> None:
        # Inlined-agents shape so no fan-out is needed.
        payload = _make_payload()
        source = _StubSource(teams={(VALID_PROJECT_ID, "team-x"): payload})
        reg = LazyTeamRegistry(source=source)

        results = await asyncio.gather(
            *(reg.get_or_load_team(VALID_PROJECT_ID, "team-x") for _ in range(10))
        )
        assert all(b is not None and b.healthy for b in results)
        # Source fetched exactly once even though 10 callers raced.
        assert source.team_calls == 1

    @pytest.mark.asyncio
    async def test_get_or_load_team_404_returns_none(self) -> None:
        source = _StubSource()
        reg = LazyTeamRegistry(source=source)
        assert await reg.get_or_load_team(VALID_PROJECT_ID, "missing") is None

    @pytest.mark.asyncio
    async def test_get_or_load_agent_wraps_in_synthetic_team(self) -> None:
        agent = {
            "id": "a1",
            "name": "analyst",
            "instructions": "be helpful",
            "model": "azure/gpt-5.4",
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memory": {"enabled": False},
            "project_id": VALID_PROJECT_ID,
        }
        source = _StubSource(agents={(VALID_PROJECT_ID, "a1"): agent})
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a1")
        assert bundle is not None
        assert bundle.healthy
        assert bundle.team_id == "_agent_a1_"
        assert bundle.config.semantic_kernel.orchestration.type == "single"
        assert bundle.config.semantic_kernel.agents[0].name == "analyst"

    @pytest.mark.asyncio
    async def test_get_or_load_agent_lifts_memory_context_onto_synthetic_team(
        self,
    ) -> None:
        """Regression: an agent's ``memoryContext`` must be propagated to the
        synthetic single-agent team blob. ``team_blob_to_maf_payload`` calls
        ``resolve_memory(team_blob)`` and — by design — does NOT merge in
        member-agent memory (team-level wins on real team invokes). For
        standalone agent invokes the synthetic team IS the agent, so without
        the lift the chain falls through to the 20-message framework default
        and the user's configured window is silently ignored. This is the
        exact bug that left `limit=20` in the trim logs for an agent whose
        config-service record had `message_window_limit=4`.
        """
        agent = {
            "id": "a-mem",
            "name": "memory_agent",
            "instructions": "remember",
            "model": "azure/gpt-5.4",
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memoryContext": {
                "enabled": True,
                "type": "window",
                "message_window_limit": 4,
            },
            "project_id": VALID_PROJECT_ID,
        }
        source = _StubSource(agents={(VALID_PROJECT_ID, "a-mem"): agent})
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-mem")
        assert bundle is not None and bundle.healthy
        # MemorySection is constructed with extra="allow" so the raw
        # memoryContext fields ride along on the config object alongside
        # the resolved max_history_length.
        memory = bundle.config.memory
        assert memory.enabled is True
        # message_window_limit → max_history_length on the resolved section.
        assert memory.max_history_length == 4

    @pytest.mark.asyncio
    async def test_get_or_load_agent_lifts_legacy_memory_fields_onto_synthetic_team(
        self,
    ) -> None:
        """Companion to the memoryContext lift: when an agent only carries
        the legacy ``memoryType`` / ``memoryConfig`` pair (no new
        memoryContext, e.g. pre-refactor data not yet rewritten on save),
        those must also propagate to the synthetic team blob so
        resolve_memory's tier-2 fallback can translate them into a working
        window. Without the lift, legacy-only agents would silently inherit
        the framework default."""
        agent = {
            "id": "a-mem-legacy",
            "name": "legacy_memory_agent",
            "instructions": "remember",
            "model": "azure/gpt-5.4",
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memoryType": "sliding_window",
            "memoryConfig": {"windowSize": 6},
            "project_id": VALID_PROJECT_ID,
        }
        source = _StubSource(agents={(VALID_PROJECT_ID, "a-mem-legacy"): agent})
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-mem-legacy")
        assert bundle is not None and bundle.healthy
        memory = bundle.config.memory
        assert memory.enabled is True
        assert memory.max_history_length == 6

    @pytest.mark.asyncio
    async def test_get_or_load_agent_resolves_knowledge_bases(self) -> None:
        """Regression: ``get_or_load_agent`` → ``build_team_bundle_from_agent``
        must resolve the agent's ``knowledgeBaseIds`` into ``kb_retrieve``
        FunctionBindings, the same way the team-blob path does. Previously
        the synthetic-single-agent builder silently dropped KBs (and MCP
        servers), so ``/projects/:pid/agents/:aid/invoke`` lost any
        tool surface attached at the agent level."""
        agent = {
            "id": "a-kb",
            "name": "data_assistant",
            "instructions": "use the kb",
            "model": "azure/gpt-5.4",
            "knowledgeBaseIds": ["kb-1"],
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memory": {"enabled": False},
            "project_id": VALID_PROJECT_ID,
        }
        kb = {
            "id": "kb-1",
            "projectId": VALID_PROJECT_ID,
            "name": "rfc-kb",
            "description": "fixture kb",
        }
        source = _StubSource(
            agents={(VALID_PROJECT_ID, "a-kb"): agent},
            kbs={(VALID_PROJECT_ID, "kb-1"): kb},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-kb")
        assert bundle is not None
        assert bundle.healthy
        assert bundle.team_id == "_agent_a-kb_"
        # Team-level tool_bindings carries the synthesised kb_retrieve binding.
        tool_bindings = getattr(bundle.config, "tool_bindings", None) or []
        kb_bindings = [
            b
            for b in tool_bindings
            if isinstance(b, dict) and b.get("function_ref") == "kb_retrieve"
        ]
        assert len(kb_bindings) == 1, (
            f"expected one kb_retrieve binding on synthetic single-agent "
            f"bundle, got {tool_bindings!r}"
        )
        assert kb_bindings[0]["params"]["kbId"] == "kb-1"
        assert kb_bindings[0]["params"]["projectId"] == VALID_PROJECT_ID
        # Agent's tool_bindings list references the synthesised binding by name.
        binding_name = kb_bindings[0]["name"]
        agent_def = bundle.config.semantic_kernel.agents[0]
        assert binding_name in (agent_def.tool_bindings or [])
        # KB resolver was actually called (proves get_or_load_agent now
        # plumbs the resolver through; the old code dropped it).
        assert source.kb_calls == 1

    @pytest.mark.asyncio
    async def test_get_or_load_agent_resolves_mcp_servers(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Companion regression to KB: ``mcpServerIds`` on a standalone
        agent must also reach the synthetic single-agent bundle. Same root
        cause as the KB drop — the synthetic path used to bypass the
        team-flow's resolver invocation entirely."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://test-gw:4001/v1")
        agent = {
            "id": "a-mcp",
            "name": "weather_pal",
            "instructions": "",
            "modelId": "azure/gpt-4.1-mini",
            "mcpServerIds": ["srv-1"],
            "project_id": VALID_PROJECT_ID,
        }
        mcp_rec = {
            "id": "srv-1",
            "projectId": VALID_PROJECT_ID,
            "name": "weather",
            "transport": "streamable-http",
            "url": "https://OLD_URL.example.com/mcp",
            "gatewayServerName": "projX_weather",
            "timeout": 30000,
        }
        source = _StubSource(
            agents={(VALID_PROJECT_ID, "a-mcp"): agent},
            mcp_servers={(VALID_PROJECT_ID, "srv-1"): mcp_rec},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-mcp")
        assert bundle is not None and bundle.healthy
        servers = getattr(bundle.config, "mcp_servers", None) or []
        names = [s.get("name") for s in servers if isinstance(s, dict)]
        assert "weather" in names
        # Agent's mcp_servers rewritten from id → name (matches the
        # team-path behaviour at test_mcp_server_ids_resolved_into_inline_configs).
        assert bundle.config.semantic_kernel.agents[0].mcp_servers == ["weather"]
        assert source.mcp_calls == 1

    @pytest.mark.asyncio
    async def test_get_or_load_agent_lifts_guardrails(self) -> None:
        """Regression: agent-level ``guardrails`` must be lifted onto the
        synthetic single-agent team so ``/projects/:pid/agents/:aid/invoke``
        keeps guardrail enforcement. Previously the synthetic builder dropped
        them (only team-level guardrails survived).

        ``fail_open`` (default ``False``) is the discriminator: the agent
        block sets it ``True``, and its ``input_guardrails`` list replaces
        the default rule set — both are impossible unless the block was
        lifted. (``pii_masker`` alone is not a valid signal: it is also in
        the default input pipeline.)"""
        agent = {
            "id": "a-guard",
            "name": "guarded_assistant",
            "instructions": "be safe",
            "model": "azure/gpt-5.4",
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memory": {"enabled": False},
            "project_id": VALID_PROJECT_ID,
            "guardrails": {
                "enabled": True,
                "fail_open": True,
                "input_guardrails": [{"name": "pii_masker"}],
            },
        }
        source = _StubSource(agents={(VALID_PROJECT_ID, "a-guard"): agent})
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-guard")
        assert bundle is not None and bundle.healthy
        assert bundle.team_id == "_agent_a-guard_"
        gr = bundle.config.guardrails
        assert gr.enabled is True
        # fail_open defaults to False; True proves the agent block was lifted.
        assert gr.fail_open is True, "agent guardrails block was not lifted"
        # The lifted list replaces the default rules (input_validator,
        # prompt_injection, pii_masker), leaving only what the agent declared.
        assert [r.name for r in gr.input_guardrails] == ["pii_masker"], (
            f"lifted input_guardrails did not replace defaults: "
            f"{[r.name for r in gr.input_guardrails]!r}"
        )

    @pytest.mark.asyncio
    async def test_get_or_load_agent_without_guardrails_uses_defaults(self) -> None:
        """Companion: an agent with no ``guardrails`` is not given a lifted
        block — the bundle falls back to the default guardrail section
        (``fail_open`` stays at its ``False`` default)."""
        agent = {
            "id": "a-noguard",
            "name": "plain_assistant",
            "instructions": "hello",
            "model": "azure/gpt-5.4",
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
            "memory": {"enabled": False},
            "project_id": VALID_PROJECT_ID,
        }
        source = _StubSource(agents={(VALID_PROJECT_ID, "a-noguard"): agent})
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_agent(VALID_PROJECT_ID, "a-noguard")
        assert bundle is not None and bundle.healthy
        gr = bundle.config.guardrails
        # No agent block lifted → default section, which leaves fail_open False.
        assert gr.fail_open is False

    @pytest.mark.asyncio
    async def test_mcp_server_ids_resolved_into_inline_configs(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """End-to-end: agent record carries mcpServerIds → loader resolves
        each id via the source's get_mcp_server, injects inline configs
        into ``mcp_servers[]``, and rewrites agent.mcp_servers from id
        → server name so SK's name-based lookup succeeds."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://test-gw:4001/v1")
        agent_rec = {
            "id": "ag-1",
            "name": "weather_pal",
            "instructions": "use the weather server",
            "modelId": "azure/gpt-4.1-mini",
            "mcpServerIds": ["srv-uuid-1"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "weather_team",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "ag-1"}],
            "orchestrationPolicy": "single",
        }
        mcp_rec = {
            "id": "srv-uuid-1",
            "projectId": VALID_PROJECT_ID,
            "name": "weather",
            "transport": "streamable-http",
            # url is intentionally a stale/upstream URL — must be ignored.
            "url": "https://OLD_DIRECT_URL.example.com/mcp",
            "gatewayServerName": "projX_weather",
            "timeout": 30000,
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={(VALID_PROJECT_ID, "ag-1"): agent_rec},
            mcp_servers={(VALID_PROJECT_ID, "srv-uuid-1"): mcp_rec},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        # mcp_servers[] inlined at team level. URL is the bare Bifrost
        # `/mcp` endpoint (derived from AGENT_GATEWAY__URL by stripping
        # the OpenAI-compat subpath). The record's own ``url`` is
        # ignored, and the per-server gatewayServerName is carried on
        # the standalone field for prefix-routing — not appended to URL.
        servers = getattr(bundle.config, "mcp_servers", None) or []
        names = [s.get("name") for s in servers if isinstance(s, dict)]
        assert "weather" in names
        weather_cfg = next(s for s in servers if isinstance(s, dict) and s.get("name") == "weather")
        assert weather_cfg["url"] == "http://test-gw:4001/mcp"
        assert weather_cfg["gateway_server_name"] == "projX_weather"
        assert "OLD_DIRECT_URL" not in weather_cfg["url"]
        # Agent's mcp_servers rewritten from id → name.
        agent_def = bundle.config.semantic_kernel.agents[0]
        assert agent_def.mcp_servers == ["weather"]
        # Resolver was actually called.
        assert source.mcp_calls == 1

    @pytest.mark.asyncio
    async def test_mcp_server_id_unresolved_drops_from_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When an MCP server id can't be resolved, agent.mcp_servers
        drops it (paired with a composition warning) so MAF doesn't
        attempt to look up a server it doesn't have a config for."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://test-gw:4001/v1")
        agent_rec = {
            "id": "ag-1",
            "name": "agent",
            "instructions": "",
            "mcpServerIds": ["does-not-exist"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "team",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "ag-1"}],
            "orchestrationPolicy": "single",
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={(VALID_PROJECT_ID, "ag-1"): agent_rec},
            # No mcp_servers entry — get_mcp_server returns None.
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        agent_def = bundle.config.semantic_kernel.agents[0]
        # Unresolved id was dropped, not silently kept.
        assert agent_def.mcp_servers == []

    @pytest.mark.asyncio
    async def test_mcp_server_without_gateway_name_dropped_from_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A record that has no ``gatewayServerName`` isn't registered
        with the Bifrost MCP proxy — the loader drops it from the
        agent's ``mcp_servers`` list (paired with a composition
        warning) so MAF doesn't try to use a server that the gateway
        can't route to."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://test-gw:4001/v1")
        agent_rec = {
            "id": "ag-1",
            "name": "agent",
            "instructions": "",
            "mcpServerIds": ["srv-1"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "team",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "ag-1"}],
            "orchestrationPolicy": "single",
        }
        # Record exists but no gatewayServerName — adapter drops it.
        unregistered = {
            "id": "srv-1",
            "name": "unregistered",
            "transport": "streamable-http",
            "url": "http://direct-upstream.example/mcp",
            # gatewayServerName intentionally absent
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={(VALID_PROJECT_ID, "ag-1"): agent_rec},
            mcp_servers={(VALID_PROJECT_ID, "srv-1"): unregistered},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        agent_def = bundle.config.semantic_kernel.agents[0]
        # Server with no gatewayServerName must NOT survive in the
        # agent's mcp_servers list.
        assert agent_def.mcp_servers == []
        # No inline mcp_servers entry either.
        servers = getattr(bundle.config, "mcp_servers", None) or []
        assert not any(s.get("name") == "unregistered" for s in servers if isinstance(s, dict))

    @pytest.mark.asyncio
    async def test_mcp_server_dedup_across_agents(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Two agents referencing the same MCP server id share one
        resolved entry; resolver is hit once per unique id."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://test-gw:4001/v1")
        agent_a = {
            "id": "a",
            "name": "a",
            "instructions": "",
            "mcpServerIds": ["s1"],
            "project_id": VALID_PROJECT_ID,
        }
        agent_b = {
            "id": "b",
            "name": "b",
            "instructions": "",
            "mcpServerIds": ["s1"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "t",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a"}, {"memberId": "b"}],
            "orchestrationPolicy": "concurrent",
        }
        mcp_rec = {
            "id": "s1",
            "name": "shared",
            "transport": "streamable-http",
            "gatewayServerName": "projX_shared",
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={
                (VALID_PROJECT_ID, "a"): agent_a,
                (VALID_PROJECT_ID, "b"): agent_b,
            },
            mcp_servers={(VALID_PROJECT_ID, "s1"): mcp_rec},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        # Resolver hit once even though two agents reference the same id.
        assert source.mcp_calls == 1
        # Only one inline config for "shared".
        servers = getattr(bundle.config, "mcp_servers", None) or []
        names = [s.get("name") for s in servers if isinstance(s, dict)]
        assert names.count("shared") == 1

    @pytest.mark.asyncio
    async def test_kb_ids_resolved_into_function_bindings(self) -> None:
        """End-to-end: agent record carries knowledgeBaseIds → loader
        fetches each KB, synthesises a kb_retrieve FunctionBinding,
        injects into ``tool_bindings[]`` on the team payload, and
        appends the binding's name onto the agent's tool_bindings."""
        agent_rec = {
            "id": "ag-1",
            "name": "rfc_pal",
            "instructions": "use the KB",
            "modelId": "azure/gpt-4.1-mini",
            "knowledgeBaseIds": ["kbvaydoa2b"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "kb_team",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "ag-1"}],
            "orchestrationPolicy": "single",
        }
        kb_rec = {
            "id": "kbvaydoa2b",
            "projectId": VALID_PROJECT_ID,
            "name": "maf-fixture-rfc-kb",
            "description": "RFC KB",
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={(VALID_PROJECT_ID, "ag-1"): agent_rec},
            kbs={(VALID_PROJECT_ID, "kbvaydoa2b"): kb_rec},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        assert source.kb_calls == 1

        # The synthesised FunctionBinding shows up on the bundle's
        # tool_bindings catalogue. ``tool_bindings`` is an extras field
        # on AgentConfig (extra="allow") so it's reachable via getattr.
        bindings = getattr(bundle.config, "tool_bindings", None) or []
        names = [b.get("name") if isinstance(b, dict) else b.name for b in bindings]
        assert "kb-retrieval-maf-fixture-rfc-kb" in names
        kb_binding = next(
            b
            for b in bindings
            if (b.get("name") if isinstance(b, dict) else b.name)
            == "kb-retrieval-maf-fixture-rfc-kb"
        )
        if isinstance(kb_binding, dict):
            assert kb_binding["function_ref"] == "kb_retrieve"
            assert kb_binding["params"]["kbId"] == "kbvaydoa2b"
            assert kb_binding["params"]["projectId"] == VALID_PROJECT_ID
        else:
            assert kb_binding.function_ref == "kb_retrieve"
            assert kb_binding.params["kbId"] == "kbvaydoa2b"
            assert kb_binding.params["projectId"] == VALID_PROJECT_ID

        # And the agent's tool_bindings list references it by name.
        agent_def = bundle.config.semantic_kernel.agents[0]
        assert "kb-retrieval-maf-fixture-rfc-kb" in agent_def.tool_bindings

    @pytest.mark.asyncio
    async def test_kb_id_unresolved_not_added_to_agent(self) -> None:
        """When a KB id can't be resolved, the agent's tool_bindings
        list doesn't get a phantom name (and no binding is created)."""
        agent_rec = {
            "id": "ag-1",
            "name": "agent",
            "instructions": "",
            "knowledgeBaseIds": ["does-not-exist"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "team",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "ag-1"}],
            "orchestrationPolicy": "single",
        }
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={(VALID_PROJECT_ID, "ag-1"): agent_rec},
            # No kb entry — get_knowledge_base returns None.
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        agent_def = bundle.config.semantic_kernel.agents[0]
        # No phantom binding name leaked into the agent.
        assert agent_def.tool_bindings == []
        # No synthesised binding either.
        assert not (getattr(bundle.config, "tool_bindings", None) or [])

    @pytest.mark.asyncio
    async def test_kb_dedup_across_agents(self) -> None:
        """Two agents referencing the same KB id share one binding;
        the resolver is hit once per unique id."""
        agent_a = {
            "id": "a",
            "name": "a",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "project_id": VALID_PROJECT_ID,
        }
        agent_b = {
            "id": "b",
            "name": "b",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "t",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a"}, {"memberId": "b"}],
            "orchestrationPolicy": "concurrent",
        }
        kb_rec = {"id": "k1", "name": "shared_kb"}
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={
                (VALID_PROJECT_ID, "a"): agent_a,
                (VALID_PROJECT_ID, "b"): agent_b,
            },
            kbs={(VALID_PROJECT_ID, "k1"): kb_rec},
        )
        reg = LazyTeamRegistry(source=source)
        bundle = await reg.get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        # Resolver hit once.
        assert source.kb_calls == 1
        # Single binding, two agents reference it.
        bindings = getattr(bundle.config, "tool_bindings", None) or []
        names = [b.get("name") if isinstance(b, dict) else b.name for b in bindings]
        assert names.count("kb-retrieval-shared_kb") == 1
        for a in bundle.config.semantic_kernel.agents:
            assert "kb-retrieval-shared_kb" in a.tool_bindings

    @pytest.mark.asyncio
    async def test_kb_dedup_collapses_when_agents_agree_on_rag_config(
        self,
    ) -> None:
        """Two agents with IDENTICAL ragConfig overrides still get a
        single shared binding — the signature dedup must not split
        identical configs into duplicate variants."""
        rag = {"k1": {"topK": 20, "similarityThreshold": 0.7, "searchMode": "hybrid"}}
        agent_a = {
            "id": "a",
            "name": "a",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "ragConfig": rag,
            "project_id": VALID_PROJECT_ID,
        }
        agent_b = {
            "id": "b",
            "name": "b",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "ragConfig": rag,
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "t",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a"}, {"memberId": "b"}],
            "orchestrationPolicy": "concurrent",
        }
        kb_rec = {"id": "k1", "name": "shared_kb"}
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={
                (VALID_PROJECT_ID, "a"): agent_a,
                (VALID_PROJECT_ID, "b"): agent_b,
            },
            kbs={(VALID_PROJECT_ID, "k1"): kb_rec},
        )
        bundle = await LazyTeamRegistry(source=source).get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        bindings = getattr(bundle.config, "tool_bindings", None) or []
        kb_bindings = [
            b for b in bindings if isinstance(b, dict) and b.get("function_ref") == "kb_retrieve"
        ]
        assert len(kb_bindings) == 1
        # Override values made it into the shared binding's params.
        assert kb_bindings[0]["params"]["topK"] == 20
        assert kb_bindings[0]["params"]["similarityThreshold"] == 0.7
        assert kb_bindings[0]["params"]["searchMode"] == "hybrid"

    @pytest.mark.asyncio
    async def test_kb_divergent_rag_config_emits_variant_bindings(self) -> None:
        """When two agents in a team disagree on ragConfig for the same
        KB, each gets its OWN binding (first agent keeps the bare kb
        name, second gets ``__r2``). Each agent's tool_bindings list
        references only its own variant so the LLM sees the params
        the operator configured for that agent."""
        agent_a = {
            "id": "a",
            "name": "a",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "ragConfig": {"k1": {"topK": 5, "searchMode": "semantic"}},
            "project_id": VALID_PROJECT_ID,
        }
        agent_b = {
            "id": "b",
            "name": "b",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "ragConfig": {"k1": {"topK": 50, "searchMode": "hybrid"}},
            "project_id": VALID_PROJECT_ID,
        }
        team_rec = {
            "_team_id": "t1",
            "name": "t",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a"}, {"memberId": "b"}],
            "orchestrationPolicy": "concurrent",
        }
        kb_rec = {"id": "k1", "name": "shared_kb"}
        source = _StubSource(
            teams={(VALID_PROJECT_ID, "t1"): team_rec},
            agents={
                (VALID_PROJECT_ID, "a"): agent_a,
                (VALID_PROJECT_ID, "b"): agent_b,
            },
            kbs={(VALID_PROJECT_ID, "k1"): kb_rec},
        )
        bundle = await LazyTeamRegistry(source=source).get_or_load_team(VALID_PROJECT_ID, "t1")
        assert bundle is not None and bundle.healthy
        # Resolver still hit only once per KB id (variants share the record).
        assert source.kb_calls == 1
        bindings = getattr(bundle.config, "tool_bindings", None) or []
        kb_bindings = [
            b for b in bindings if isinstance(b, dict) and b.get("function_ref") == "kb_retrieve"
        ]
        assert len(kb_bindings) == 2, kb_bindings
        names = [b["name"] for b in kb_bindings]
        assert names == ["kb-retrieval-shared_kb", "kb-retrieval-shared_kb__r2"], names
        # Agent A (first-seen) → bare name, topK=5.
        assert kb_bindings[0]["params"]["topK"] == 5
        assert kb_bindings[0]["params"]["searchMode"] == "semantic"
        # Agent B (variant) → __r2, topK=50.
        assert kb_bindings[1]["params"]["topK"] == 50
        assert kb_bindings[1]["params"]["searchMode"] == "hybrid"
        # Each agent's tool_bindings references ONLY its own variant.
        agents_by_name = {a.name: a for a in bundle.config.semantic_kernel.agents}
        assert "kb-retrieval-shared_kb" in (agents_by_name["a"].tool_bindings or [])
        assert "kb-retrieval-shared_kb__r2" not in (agents_by_name["a"].tool_bindings or [])
        assert "kb-retrieval-shared_kb__r2" in (agents_by_name["b"].tool_bindings or [])
        assert "kb-retrieval-shared_kb" not in (agents_by_name["b"].tool_bindings or [])

    @pytest.mark.asyncio
    async def test_kb_threshold_disabled_propagates_through_team_loader(
        self,
    ) -> None:
        """End-to-end check that ``similarityThresholdEnabled: False``
        on an agent's ragConfig drops the threshold from the synthesised
        binding so the upstream applies no minimum-score filter."""
        agent = {
            "id": "a",
            "name": "a",
            "instructions": "",
            "knowledgeBaseIds": ["k1"],
            "ragConfig": {
                "k1": {
                    "topK": 7,
                    "similarityThreshold": 0.9,
                    "similarityThresholdEnabled": False,
                }
            },
            "project_id": VALID_PROJECT_ID,
        }
        kb_rec = {"id": "k1", "name": "kb_one"}
        source = _StubSource(
            agents={(VALID_PROJECT_ID, "a"): agent},
            kbs={(VALID_PROJECT_ID, "k1"): kb_rec},
        )
        bundle = await LazyTeamRegistry(source=source).get_or_load_agent(VALID_PROJECT_ID, "a")
        assert bundle is not None and bundle.healthy
        bindings = getattr(bundle.config, "tool_bindings", None) or []
        kb_b = next(
            b for b in bindings if isinstance(b, dict) and b.get("function_ref") == "kb_retrieve"
        )
        assert kb_b["params"]["topK"] == 7
        assert "similarityThreshold" not in kb_b["params"]

    @pytest.mark.asyncio
    async def test_evict_team_drops_from_inner(self) -> None:
        source = _StubSource(teams={(VALID_PROJECT_ID, "team-x"): _make_payload()})
        reg = LazyTeamRegistry(source=source)
        await reg.get_or_load_team(VALID_PROJECT_ID, "team-x")
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is not None
        reg.evict_team(VALID_PROJECT_ID, "team-x")
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is None


# ---------------------------------------------------------------------------
# 4b) LazyTeamRegistry — staging=playground cache bypass (Task 005)
# ---------------------------------------------------------------------------


class _SkipCacheStubSource:
    """ConfigSource stub whose fetches accept ``skip_cache`` — simulates
    the remote config-service cache for the playground-bypass tests.

    Records every ``skip_cache`` value seen so a test can assert the flag
    threaded all the way from the registry into the source fetch.
    """

    def __init__(
        self,
        *,
        teams: dict[tuple[str, str], dict[str, Any]] | None = None,
        agents: dict[tuple[str, str], dict[str, Any]] | None = None,
        mcp_servers: dict[tuple[str, str], dict[str, Any]] | None = None,
        kbs: dict[tuple[str, str], dict[str, Any]] | None = None,
    ) -> None:
        self.teams = teams or {}
        self.agents = agents or {}
        self.mcp_servers = mcp_servers or {}
        self.kbs = kbs or {}
        self.team_calls = 0
        self.agent_calls = 0
        self.skip_cache_seen: list[tuple[str, bool]] = []

    async def get_team(
        self, pid: str, tid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.team_calls += 1
        self.skip_cache_seen.append(("team", skip_cache))
        return self.teams.get((pid, tid))

    async def get_agent(
        self, pid: str, aid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.agent_calls += 1
        self.skip_cache_seen.append(("agent", skip_cache))
        return self.agents.get((pid, aid))

    async def get_mcp_server(
        self, pid: str, sid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.skip_cache_seen.append(("mcp", skip_cache))
        return self.mcp_servers.get((pid, sid))

    async def get_knowledge_base(
        self, pid: str, kid: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        self.skip_cache_seen.append(("kb", skip_cache))
        return self.kbs.get((pid, kid))

    async def list_teams(self, pid: str) -> list[dict[str, Any]]:
        return [{"id": tid, "name": tid} for (p, tid) in self.teams if p == pid]

    async def list_agents(self, pid: str) -> list[dict[str, Any]]:
        return [{"id": aid, "name": aid} for (p, aid) in self.agents if p == pid]


def _agent_payload(agent_id: str = "a1") -> dict[str, Any]:
    """Minimal standalone-agent record that builds a healthy synthetic
    single-agent bundle."""
    return {
        "id": agent_id,
        "name": "analyst",
        "instructions": "be helpful",
        "model": "azure/gpt-5.4",
        "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
        "memory": {"enabled": False},
        "project_id": VALID_PROJECT_ID,
    }


class TestLazyTeamRegistryPlayground:
    """``staging='playground'`` must bypass both cache layers: no fast-path
    read of an existing bundle, ``skip_cache=True`` into source fetches,
    and **no** ``add()`` so the registry is never polluted (D1/D2/D3)."""

    @pytest.mark.asyncio
    async def test_team_playground_skips_add_and_threads_skip_cache(self) -> None:
        source = _SkipCacheStubSource(teams={(VALID_PROJECT_ID, "team-x"): _make_payload()})
        reg = LazyTeamRegistry(source=source)

        bundle = await reg.get_or_load_team(
            VALID_PROJECT_ID, "team-x", query_options=QueryOptions(staging="playground")
        )

        assert bundle is not None and bundle.healthy
        # D1 — request-scoped only: not written to the registry.
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is None
        assert reg.all_bundles() == []
        # D2 — skip_cache=True flowed into the source fetch.
        assert ("team", True) in source.skip_cache_seen

    @pytest.mark.asyncio
    async def test_team_playground_ignores_existing_bundle_and_leaves_it(self) -> None:
        source = _SkipCacheStubSource(teams={(VALID_PROJECT_ID, "team-x"): _make_payload()})
        reg = LazyTeamRegistry(source=source)

        # Warm a normal (cached + added) bundle first.
        warm = await reg.get_or_load_team(VALID_PROJECT_ID, "team-x")
        assert warm is not None
        assert source.team_calls == 1
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is not None
        bundle_count_before = len(reg.all_bundles())

        # D3 — playground must refetch + rebuild even though a healthy
        # bundle is already materialised.
        await reg.get_or_load_team(
            VALID_PROJECT_ID, "team-x", query_options=QueryOptions(staging="playground")
        )
        assert source.team_calls == 2
        # The default-path bundle is untouched (playground did not evict
        # or replace it) and registry membership is unchanged.
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is warm
        assert len(reg.all_bundles()) == bundle_count_before

    @pytest.mark.asyncio
    async def test_agent_playground_skips_add_and_threads_skip_cache(self) -> None:
        source = _SkipCacheStubSource(agents={(VALID_PROJECT_ID, "a1"): _agent_payload()})
        reg = LazyTeamRegistry(source=source)

        bundle = await reg.get_or_load_agent(
            VALID_PROJECT_ID, "a1", query_options=QueryOptions(staging="playground")
        )

        assert bundle is not None and bundle.healthy
        assert bundle.team_id == "_agent_a1_"
        # Not added to the registry.
        assert reg.get_in_project(VALID_PROJECT_ID, "_agent_a1_") is None
        assert reg.all_bundles() == []
        assert ("agent", True) in source.skip_cache_seen

    @pytest.mark.asyncio
    async def test_default_staging_still_caches_and_adds(self) -> None:
        # Control: a skip-cache-capable source with the default staging
        # value behaves exactly as today — cached, added, skip_cache=False.
        source = _SkipCacheStubSource(teams={(VALID_PROJECT_ID, "team-x"): _make_payload()})
        reg = LazyTeamRegistry(source=source)

        await reg.get_or_load_team(
            VALID_PROJECT_ID, "team-x", query_options=QueryOptions(staging="default")
        )

        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is not None
        assert source.skip_cache_seen == [("team", False)]

    @pytest.mark.asyncio
    async def test_playground_is_noop_in_file_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # D6 — playground bypass is remote-only; file mode ignores it.
        from agent_service_maf.config.settings import settings

        monkeypatch.setattr(settings, "CONFIG_SOURCE", "file")
        source = _StubSource(teams={(VALID_PROJECT_ID, "team-x"): _make_payload()})
        reg = LazyTeamRegistry(source=source)

        bundle = await reg.get_or_load_team(
            VALID_PROJECT_ID, "team-x", query_options=QueryOptions(staging="playground")
        )

        assert bundle is not None and bundle.healthy
        assert reg.get_in_project(VALID_PROJECT_ID, "team-x") is bundle


# ---------------------------------------------------------------------------
# 5) Composition helpers
# ---------------------------------------------------------------------------


class TestRemoteAdapter:
    def test_agent_record_to_sk_agent_handles_camelcase(self) -> None:
        rec = {
            "id": "a1",
            "name": "Alice",
            "modelId": "azure/gpt-5.4",
            "maxTokens": 1024,
            "mcpServerIds": ["s1", "s2"],
            "functionChoiceBehavior": "auto",
            "instructions": "do",
        }
        sk = agent_record_to_sk_agent(rec, None)
        assert sk["name"] == "Alice"
        assert sk["model"] == "azure/gpt-5.4"
        assert sk["max_tokens"] == 1024
        assert sk["mcp_servers"] == ["s1", "s2"]
        assert sk["function_choice_behavior"] == "auto"

    def test_agent_record_to_sk_agent_resolves_gateway_model_id_from_dict(self) -> None:
        """When config-service expands ``model`` into a resolved dict, the
        adapter must pick ``gatewayModelId`` (the Bifrost-routable form)
        rather than the raw catalog UUID or the bare provider name."""
        rec = {
            "id": "a1",
            "name": "Alice",
            "instructions": "do",
            "model": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "gatewayModelId": "azure/projXX_credYY_gpt-4",
                "providerModelId": "gpt-4",
            },
        }
        sk = agent_record_to_sk_agent(rec, None)
        assert sk["model"] == "azure/projXX_credYY_gpt-4"

    def test_agent_record_to_sk_agent_carries_model_display_name(self) -> None:
        rec = {
            "id": "a1",
            "name": "Alice",
            "instructions": "do",
            "model": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "name": "Production GPT-4",
                "displayName": "GPT-4 Production",
                "gatewayModelId": "azure/projXX_credYY_gpt-4",
            },
        }
        sk = agent_record_to_sk_agent(rec, None)
        assert sk["model_display_name"] == "GPT-4 Production"

    def test_agent_record_to_sk_agent_raises_when_gateway_model_id_missing(self) -> None:
        """A resolved model dict without ``gatewayModelId`` is a
        config-service bug (model not registered with Bifrost). The adapter
        must fail loudly with an operator-readable message instead of
        silently sending ``providerModelId`` or the UUID downstream."""
        rec = {
            "id": "a1",
            "name": "Alice",
            "instructions": "do",
            "model": {
                "id": "550e8400-e29b-41d4-a716-446655440000",
                "providerModelId": "gpt-4",
            },
        }
        with pytest.raises(ValueError, match="gatewayModelId"):
            agent_record_to_sk_agent(rec, None)

    def test_team_blob_to_maf_payload_splices_agents(self) -> None:
        blob = {
            "_team_id": "t1",
            "_team_name": "Team 1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}, {"memberId": "a2"}],
            "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
        }
        agents = [
            {"name": "a1", "instructions": ""},
            {"name": "a2", "instructions": ""},
        ]
        payload = team_blob_to_maf_payload(blob, agents)
        assert payload["project_id"] == VALID_PROJECT_ID
        assert payload["semantic_kernel"]["agents"] == agents
        assert payload["semantic_kernel"]["orchestration"]["type"] == "concurrent"
        assert payload["gateway"]["url"] == "http://gw"

    def test_team_blob_orchestration_policy_as_string(self) -> None:
        """Config-service serialises ``orchestrationPolicy`` as a string.
        The adapter must wrap it into ``{"type": <policy>}`` instead of
        falling back to the multi-agent ``concurrent`` heuristic."""
        for policy in ("triage", "handoff", "graph", "magentic", "group_chat"):
            blob = {
                "_team_id": "t1",
                "project_id": VALID_PROJECT_ID,
                "members": [{"memberId": "a1"}, {"memberId": "a2"}],
                "orchestrationPolicy": policy,
            }
            agents = [{"name": "a1"}, {"name": "a2"}]
            payload = team_blob_to_maf_payload(blob, agents)
            assert payload["semantic_kernel"]["orchestration"]["type"] == policy, (
                f"orchestrationPolicy={policy!r} should not collapse to concurrent"
            )

    def test_team_blob_orchestration_policy_as_dict_passes_through(self) -> None:
        """When ``orchestrationPolicy`` is already a MAF-shaped dict the
        adapter must not lose any of its fields."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}],
            "orchestrationPolicy": {
                "type": "graph",
                "edges": [{"source": "a1", "target": "a2", "condition": ""}],
            },
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}])
        orch = payload["semantic_kernel"]["orchestration"]
        assert orch["type"] == "graph"
        assert orch["edges"] == [{"source": "a1", "target": "a2", "condition": ""}]

    def test_team_blob_termination_strategy_keyword(self) -> None:
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}],
            "orchestrationPolicy": "group_chat",
            "terminationStrategy": {
                "type": "keyword",
                "keywords": ["CONSENSUS REACHED", "AGREED"],
            },
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}])
        ts = payload["semantic_kernel"]["orchestration"]["termination_strategy"]
        assert ts["type"] == "keyword"
        assert ts["keywords"] == ["CONSENSUS REACHED", "AGREED"]

    def test_team_blob_termination_strategy_aggregator_recurses(self) -> None:
        """Aggregator termination with nested keyword + maximum_iterations
        must reach MAF's ``sub_strategies`` list verbatim."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}],
            "orchestrationPolicy": "graph",
            "terminationStrategy": {
                "type": "aggregator",
                "condition": "any",
                "sub_strategies": [
                    {"type": "keyword", "keywords": ["APPROVED"]},
                    {"type": "maximum_iterations", "maximum_iterations": 6},
                ],
            },
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}])
        ts = payload["semantic_kernel"]["orchestration"]["termination_strategy"]
        assert ts["type"] == "aggregator"
        assert ts["condition"] == "any"
        assert len(ts["sub_strategies"]) == 2
        assert ts["sub_strategies"][0]["keywords"] == ["APPROVED"]
        assert ts["sub_strategies"][1]["maximum_iterations"] == 6

    def test_team_blob_manager_block_populates_orchestration(self) -> None:
        """Magentic-style ``manager`` block must drive the orchestration's
        manager_model / manager_temperature / max_rounds fields."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}, {"memberId": "a2"}],
            "orchestrationPolicy": "magentic",
            "manager": {
                "name": "magentic_manager",
                "modelId": "azure/gpt-5.4",
                "temperature": 0,
                "maxTokens": 2048,
                "systemPrompt": "...",
                "guardrails": {"maxIterations": 8, "timeoutSeconds": 600},
            },
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}, {"name": "a2"}])
        orch = payload["semantic_kernel"]["orchestration"]
        assert orch["type"] == "magentic"
        assert orch["manager_model"] == "azure/gpt-5.4"
        assert orch["magentic_manager_model"] == "azure/gpt-5.4"
        assert orch["manager_temperature"] == 0.0
        assert orch["magentic_manager_temperature"] == 0.0
        assert orch["max_rounds"] == 8
        # Triage-relevant fields — manager name + instructions + max_tokens.
        # MAF's _build_triage reads these to build a dedicated router agent.
        assert orch["manager_name"] == "magentic_manager"
        assert orch["manager_instructions"] == "..."
        assert orch["manager_max_tokens"] == 2048
        # The full manager block is still preserved on sk_section for
        # adapters that read it directly.
        assert payload["semantic_kernel"]["manager"]["systemPrompt"] == "..."

    def test_team_blob_triage_manager_block_prefers_gateway_model_id(self) -> None:
        """For a ``route``-policy team (→ triage), the manager block's resolved
        ``model.gatewayModelId`` wins over the raw ``modelId`` UUID so the
        router agent talks to Bifrost under the routable name."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}, {"memberId": "a2"}],
            "orchestrationPolicy": "route",
            "manager": {
                "name": "Router",
                "modelId": "4e79b2dc-9463-4b9f-87bf-ea7416a596e9",
                "model": {
                    "id": "4e79b2dc-9463-4b9f-87bf-ea7416a596e9",
                    "gatewayModelId": "azure/projx_gpt-5.4",
                },
                "systemPrompt": "Pick the best specialist.",
            },
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}, {"name": "a2"}])
        orch = payload["semantic_kernel"]["orchestration"]
        assert orch["type"] == "triage"  # route → triage via legacy map
        assert orch["manager_model"] == "azure/projx_gpt-5.4"
        assert orch["manager_name"] == "Router"
        assert orch["manager_instructions"] == "Pick the best specialist."

    def test_team_blob_handoffs_and_edges_passthrough(self) -> None:
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "triage"}, {"memberId": "billing"}],
            "orchestrationPolicy": "handoff",
            "handoffs": [{"source": "triage", "target": "billing", "description": "billing q"}],
            "edges": [{"source": "billing", "target": "triage", "condition": "escalate"}],
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "triage"}, {"name": "billing"}])
        orch = payload["semantic_kernel"]["orchestration"]
        assert orch["type"] == "handoff"
        assert orch["handoffs"][0]["source"] == "triage"
        assert orch["edges"][0]["condition"] == "escalate"

    def test_team_blob_handoff_synthesises_all_pairs_when_blob_empty(self) -> None:
        """When orchestrationPolicy=handoff but the blob doesn't carry
        handoffs[], the adapter synthesises all-pairs edges between
        resolved agents so the orchestrator has something to route
        with. Slated for removal once config-service exposes handoffs
        explicitly (see TODO in remote_adapter)."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [
                {"memberId": "triage"},
                {"memberId": "billing"},
                {"memberId": "technical"},
            ],
            "orchestrationPolicy": "handoff",
        }
        agents = [
            {"name": "triage"},
            {"name": "billing"},
            {"name": "technical"},
        ]
        payload = team_blob_to_maf_payload(blob, agents)
        orch = payload["semantic_kernel"]["orchestration"]
        assert orch["type"] == "handoff"
        # N * (N-1) = 6 edges for 3 agents
        assert len(orch["handoffs"]) == 6
        pairs = {(h["source"], h["target"]) for h in orch["handoffs"]}
        assert ("triage", "billing") in pairs
        assert ("billing", "triage") in pairs
        # No self-loops
        assert not any(h["source"] == h["target"] for h in orch["handoffs"])
        # Description carries the TODO marker for grep-ability
        assert "auto-generated" in orch["handoffs"][0]["description"]

    def test_team_blob_handoff_preserves_explicit_handoffs(self) -> None:
        """When the blob *does* carry handoffs[], the adapter must NOT
        replace them with the all-pairs synthesis."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "triage"}, {"memberId": "billing"}],
            "orchestrationPolicy": "handoff",
            "handoffs": [{"source": "triage", "target": "billing", "description": "money q"}],
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "triage"}, {"name": "billing"}])
        orch = payload["semantic_kernel"]["orchestration"]
        assert len(orch["handoffs"]) == 1
        assert orch["handoffs"][0]["description"] == "money q"

    def test_team_blob_handoff_synth_skipped_when_not_handoff(self) -> None:
        """All-pairs synthesis must only fire for type=handoff."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}, {"memberId": "a2"}],
            "orchestrationPolicy": "concurrent",
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}, {"name": "a2"}])
        assert not payload["semantic_kernel"]["orchestration"].get("handoffs")

    def test_team_blob_single_agent_still_defaults_to_single(self) -> None:
        """Solo team with no policy must remain ``single`` (regression check)."""
        blob = {
            "_team_id": "t1",
            "project_id": VALID_PROJECT_ID,
            "members": [{"memberId": "a1"}],
        }
        payload = team_blob_to_maf_payload(blob, [{"name": "a1"}])
        assert payload["semantic_kernel"]["orchestration"]["type"] == "single"

    def test_mcp_server_record_to_inline_config_composes_gateway_url(self) -> None:
        """Adapter composes the URL from ``mcp_base_url`` + record's
        ``gatewayServerName``. The record's own ``url`` field is
        intentionally ignored — config-service records do not carry
        deployment-specific URLs anymore."""
        record = {
            "id": "45a479eb-cfe9-4827-925c-7c93821f62f8",
            "projectId": VALID_PROJECT_ID,
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://OLD_DIRECT_URL.example.com/mcp",  # MUST be ignored
            "gatewayServerName": "projs19sngp2_weather",
            "timeout": 600000,
            "authType": "none",
        }
        out = mcp_server_record_to_inline_config(
            record, mcp_base_url="http://192.168.139.2:4001/mcp"
        )
        assert out is not None
        assert out["name"] == "weather"
        assert out["transport"] == "streamable-http"
        # URL is the bare Bifrost `/mcp` endpoint (no per-server suffix —
        # Bifrost serves a single aggregated proxy and routes by tool-name
        # prefix). The gatewayServerName lands on its own field so the
        # MCP manager can filter the aggregated tool list down.
        assert out["url"] == "http://192.168.139.2:4001/mcp"
        assert out["gateway_server_name"] == "projs19sngp2_weather"
        assert out["enabled"] is True
        # 600000 ms → 600 s
        assert out["timeout_seconds"] == 600

    def test_mcp_server_record_to_inline_config_dropped_without_gateway_name(
        self,
    ) -> None:
        """A record without ``gatewayServerName`` is not registered with
        the gateway and is dropped (returns None) — no fallback to the
        record's own URL."""
        record = {
            "id": "x",
            "name": "unregistered_server",
            "transport": "streamable-http",
            "url": "http://direct-upstream.example/mcp",
            # gatewayServerName intentionally absent
        }
        out = mcp_server_record_to_inline_config(
            record, mcp_base_url="http://192.168.139.2:4001/mcp"
        )
        assert out is None

    def test_mcp_server_record_to_inline_config_snake_case_alias(self) -> None:
        """``gateway_server_name`` snake-case is accepted as an alias."""
        record = {
            "id": "x",
            "name": "weather",
            "transport": "streamable-http",
            "gateway_server_name": "projX_weather",
        }
        out = mcp_server_record_to_inline_config(record, mcp_base_url="http://gw:4001/mcp")
        assert out is not None
        # URL is the bare /mcp endpoint; the snake-case alias still routes
        # into the standalone gateway_server_name field on the output.
        assert out["url"] == "http://gw:4001/mcp"
        assert out["gateway_server_name"] == "projX_weather"

    def test_mcp_server_record_to_inline_config_stdio(self) -> None:
        """stdio transport still carries command/args/env. URL is
        always composed when a gatewayServerName is present, regardless
        of transport — the adapter doesn't switch behaviour here.
        (stdio servers wouldn't normally have a gatewayServerName, but
        we cover the path for completeness.)"""
        record = {
            "id": "abc",
            "name": "local_tool",
            "transport": "stdio",
            "gatewayServerName": "projX_local_tool",
            "command": "/usr/bin/python3",
            "args": ["-u", "/srv/tool.py"],
            "env": {"FOO": "bar"},
        }
        out = mcp_server_record_to_inline_config(record, mcp_base_url="http://gw:4001/mcp")
        assert out is not None
        assert out["transport"] == "stdio"
        assert out["command"] == "/usr/bin/python3"
        assert out["args"] == ["-u", "/srv/tool.py"]
        assert out["env"] == {"FOO": "bar"}

    def test_mcp_server_record_to_inline_config_merges_headers(self) -> None:
        record = {
            "id": "h1",
            "name": "auth_server",
            "transport": "streamable-http",
            "gatewayServerName": "projX_auth_server",
            "staticHeaders": {"X-Tenant": "t1"},
            "extraHeaders": {"X-Trace": "abc"},
            "allowedTools": ["read_file"],
            "disallowedTools": ["delete_file"],
        }
        out = mcp_server_record_to_inline_config(record, mcp_base_url="http://gw:4001/mcp")
        assert out is not None
        assert out["headers"] == {"X-Tenant": "t1", "X-Trace": "abc"}
        assert out["allowed_tools"] == ["read_file"]
        assert out["disallowed_tools"] == ["delete_file"]

    def test_mcp_server_record_to_inline_config_drops_nameless(self) -> None:
        # No name → dropped, regardless of gatewayServerName presence.
        assert (
            mcp_server_record_to_inline_config(
                {"transport": "stdio", "gatewayServerName": "x"},
                mcp_base_url="http://gw:4001/mcp",
            )
            is None
        )
        assert mcp_server_record_to_inline_config({}, mcp_base_url="http://gw:4001/mcp") is None
        assert (
            mcp_server_record_to_inline_config(
                None,  # type: ignore[arg-type]
                mcp_base_url="http://gw:4001/mcp",
            )
            is None
        )

    def test_derive_mcp_base_url_swaps_v1_for_mcp(self) -> None:
        """Strip OpenAI-compat subpath → ``/mcp`` at the gateway root."""
        from agent_service_maf.config.remote_adapter import derive_mcp_base_url

        # Bare /v1 (legacy upstream shape).
        assert (
            derive_mcp_base_url("http://192.168.139.2:4001/v1") == "http://192.168.139.2:4001/mcp"
        )
        assert derive_mcp_base_url("http://bifrost:8080/v1/") == "http://bifrost:8080/mcp"
        # Bifrost's deployed shape — /litellm/v1 must be stripped fully
        # so MCP lands at the root, NOT at /litellm/mcp (which 405s).
        assert (
            derive_mcp_base_url("http://bifrost-proxy:4001/litellm/v1")
            == "http://bifrost-proxy:4001/mcp"
        )
        assert (
            derive_mcp_base_url("http://bifrost-proxy:4001/litellm/v1/")
            == "http://bifrost-proxy:4001/mcp"
        )
        # Non-standard suffix → append /mcp after stripping trailing /.
        assert derive_mcp_base_url("http://gateway") == "http://gateway/mcp"
        assert derive_mcp_base_url("http://gateway/") == "http://gateway/mcp"

    def test_agent_record_legacy_outcome_schema_is_ignored(self) -> None:
        """The structured-output card no longer consumes the deprecated
        top-level ``outcomeSchema`` field — it is not a schema source."""
        schema = {"type": "object", "properties": {"a": {"type": "string"}}}
        sk = agent_record_to_sk_agent(
            {"id": "a", "name": "a", "instructions": "", "outcomeSchema": schema},
            None,
        )
        assert "output_schema" not in sk
        assert "response_format" not in sk

    def test_agent_record_output_schema_from_structured_output(self) -> None:
        """``structuredOutput`` with ``responseFormat=json_object`` and a
        serialized ``outputSchema`` string is parsed into MAF's
        ``output_schema`` (and ``response_format`` is stamped)."""
        schema = {"type": "object", "properties": {"a": {"type": "string"}}}
        sk = agent_record_to_sk_agent(
            {
                "id": "a",
                "name": "a",
                "instructions": "",
                "structuredOutput": {
                    "enabled": True,
                    "responseFormat": "json_object",
                    "outputSchema": json.dumps(schema),
                },
            },
            None,
        )
        assert sk["response_format"] == "json_object"
        assert sk["output_schema"] == schema

    def test_agent_record_structured_output_ignores_legacy_outcome_schema(self) -> None:
        """When both the card and the deprecated ``outcomeSchema`` are
        present, only the card is consumed — ``outcomeSchema`` is dead."""
        deprecated = {"type": "object", "properties": {"a": {"type": "string"}}}
        new = {"type": "object", "properties": {"b": {"type": "integer"}}}
        sk = agent_record_to_sk_agent(
            {
                "id": "a",
                "name": "a",
                "instructions": "",
                "outcomeSchema": deprecated,
                "structuredOutput": {
                    "enabled": True,
                    "responseFormat": "json_object",
                    "outputSchema": json.dumps(new),
                },
            },
            None,
        )
        assert sk["output_schema"] == new
        assert sk["output_schema"] != deprecated

    def test_agent_record_structured_disabled_sets_nothing(self) -> None:
        """An explicitly disabled card installs no schema and no
        ``response_format`` — and the legacy ``outcomeSchema`` is not a
        fallback anymore."""
        deprecated = {"type": "object", "properties": {"x": {"type": "string"}}}
        new = {"type": "object", "properties": {"y": {"type": "integer"}}}
        sk = agent_record_to_sk_agent(
            {
                "id": "a",
                "name": "a",
                "instructions": "",
                "outcomeSchema": deprecated,
                "structuredOutput": {
                    "enabled": False,
                    "responseFormat": "json_object",
                    "outputSchema": json.dumps(new),
                },
            },
            None,
        )
        assert "output_schema" not in sk
        assert "response_format" not in sk

    def test_agent_record_no_schema_at_all_drops_field(self) -> None:
        """Neither shape present → ``output_schema`` is not on the
        sk_agent dict (MAF's default = None applies)."""
        sk = agent_record_to_sk_agent({"id": "a", "name": "a", "instructions": ""}, None)
        assert "output_schema" not in sk

    def test_agent_record_skip_post_tool_synthesis_defaults_false(self) -> None:
        """Config-service does not yet expose ``skipPostToolSynthesis``,
        so the adapter always stamps the False default explicitly."""
        sk = agent_record_to_sk_agent({"id": "a", "name": "a", "instructions": "i"}, None)
        assert sk["skip_post_tool_synthesis"] is False

    def test_agent_record_skip_post_tool_synthesis_picks_up_either_alias(self) -> None:
        """Once config-service grows the field (either casing), the
        adapter passes it through. snake_case + camelCase both accepted."""
        for key in ("skip_post_tool_synthesis", "skipPostToolSynthesis"):
            rec = {"id": "a", "name": "a", "instructions": "i", key: True}
            sk = agent_record_to_sk_agent(rec, None)
            assert sk["skip_post_tool_synthesis"] is True, (
                f"alias {key!r} should populate skip_post_tool_synthesis"
            )

    def test_kb_record_to_function_binding_minimal(self) -> None:
        """The live ``maf-fixture-rfc-kb`` record maps to a kb_retrieve
        FunctionBinding with kbId + projectId in params."""
        record = {
            "id": "kbvaydoa2b",
            "projectId": VALID_PROJECT_ID,
            "name": "maf-fixture-rfc-kb",
            "description": "Placeholder KB for MAF test fixtures.",
        }
        binding = knowledge_base_record_to_function_binding(record, project_id=VALID_PROJECT_ID)
        assert binding is not None
        assert binding["function_ref"] == "kb_retrieve"
        assert binding["type"] == "function"
        # Name is now prefixed with "kb-retrieval-"; the raw name had no kb- prefix
        # so the full slug is kb-retrieval-{raw_name}.
        assert binding["name"] == "kb-retrieval-maf-fixture-rfc-kb"
        assert binding["params"]["kbId"] == "kbvaydoa2b"
        assert binding["params"]["projectId"] == VALID_PROJECT_ID
        assert binding["params"]["topK"] == 5
        assert binding["params"]["similarityThreshold"] == 0.5
        assert "retrieval" in binding["tags"]
        assert "knowledge_base" in binding["tags"]

    def test_kb_record_to_function_binding_slugifies_unsafe_names(self) -> None:
        """KB names with spaces / special chars get sanitised so they
        satisfy FunctionBinding.name's regex."""
        record = {
            "id": "kb-1",
            "name": "RFC search KB / draft (v1)",
        }
        binding = knowledge_base_record_to_function_binding(record, project_id=VALID_PROJECT_ID)
        assert binding is not None
        import re

        assert re.match(r"^[a-zA-Z0-9_-]{1,64}$", binding["name"])

    def test_kb_record_to_function_binding_drops_idless(self) -> None:
        assert (
            knowledge_base_record_to_function_binding(
                {"name": "no-id"}, project_id=VALID_PROJECT_ID
            )
            is None
        )
        assert knowledge_base_record_to_function_binding({}, project_id=VALID_PROJECT_ID) is None
        assert (
            knowledge_base_record_to_function_binding(
                None,
                project_id=VALID_PROJECT_ID,  # type: ignore[arg-type]
            )
            is None
        )

    def test_kb_record_to_function_binding_applies_rag_overrides(self) -> None:
        """Per-agent ``ragConfig`` overrides flow into the binding's
        pinned params: ``topK`` / ``similarityThreshold`` / ``searchMode``.
        """
        record = {"id": "kb-1", "name": "rfc-kb"}
        binding = knowledge_base_record_to_function_binding(
            record,
            project_id=VALID_PROJECT_ID,
            rag_overrides={
                "topK": 25,
                "similarityThreshold": 0.8,
                "searchMode": "hybrid",
            },
        )
        assert binding is not None
        assert binding["params"]["topK"] == 25
        assert binding["params"]["similarityThreshold"] == 0.8
        assert binding["params"]["searchMode"] == "hybrid"

    def test_kb_record_to_function_binding_threshold_disabled_drops_param(
        self,
    ) -> None:
        """``similarityThresholdEnabled: False`` MUST drop the threshold
        from the binding entirely so the upstream applies no minimum-
        score filter (its own default of 0 = return all)."""
        record = {"id": "kb-1", "name": "rfc-kb"}
        binding = knowledge_base_record_to_function_binding(
            record,
            project_id=VALID_PROJECT_ID,
            rag_overrides={
                "topK": 10,
                "similarityThreshold": 0.5,
                "similarityThresholdEnabled": False,
            },
        )
        assert binding is not None
        assert binding["params"]["topK"] == 10
        assert "similarityThreshold" not in binding["params"], (
            "threshold MUST be omitted when explicitly disabled — even "
            "if a numeric value is also present in the overrides"
        )

    def test_kb_record_to_function_binding_partial_overrides_fall_back(
        self,
    ) -> None:
        """Overrides are key-wise: a missing key uses the helper's
        default, NOT some null/zero value."""
        record = {"id": "kb-1", "name": "rfc-kb"}
        binding = knowledge_base_record_to_function_binding(
            record,
            project_id=VALID_PROJECT_ID,
            rag_overrides={"searchMode": "fts"},
        )
        assert binding is not None
        # No topK override → default 5.
        assert binding["params"]["topK"] == 5
        # No threshold override (and not disabled) → default 0.5.
        assert binding["params"]["similarityThreshold"] == 0.5
        assert binding["params"]["searchMode"] == "fts"

    def test_kb_record_to_function_binding_malformed_overrides_are_safe(
        self,
    ) -> None:
        """Non-dict / wrong-typed override values fall back to defaults
        without raising — the helper is called from the team loader's
        hot path and must never crash on operator typos."""
        record = {"id": "kb-1", "name": "rfc-kb"}
        # bool is an int subclass — must be REJECTED as topK / threshold.
        binding = knowledge_base_record_to_function_binding(
            record,
            project_id=VALID_PROJECT_ID,
            rag_overrides={
                "topK": True,  # bool — reject, fall to default 5
                "similarityThreshold": "high",  # wrong type — fall to 0.5
                "searchMode": "",  # empty string — drop
            },
        )
        assert binding is not None
        assert binding["params"]["topK"] == 5
        assert binding["params"]["similarityThreshold"] == 0.5
        assert "searchMode" not in binding["params"]

        # rag_overrides=None and rag_overrides={} both behave like "no
        # overrides" — identical to the legacy two-arg call.
        for empty in (None, {}):
            b = knowledge_base_record_to_function_binding(
                record, project_id=VALID_PROJECT_ID, rag_overrides=empty
            )
            assert b is not None
            assert b["params"]["topK"] == 5
            assert b["params"]["similarityThreshold"] == 0.5

    # ------------------------------------------------------------------
    # KB tool naming normalisation (kb-retrieval-* prefix)
    # ------------------------------------------------------------------

    def test_kb_name_with_kb_dash_prefix_strips_and_adds_retrieval(self) -> None:
        """``kb-gcnv`` → ``kb-retrieval-gcnv`` (strips ``kb-`` prefix)."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kbpzfxjz02", "name": "kb-gcnv"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        assert binding["name"] == "kb-retrieval-gcnv"

    def test_kb_name_with_kb_underscore_prefix_strips_and_adds_retrieval(self) -> None:
        """``kb_aegis-insurance`` → ``kb-retrieval-aegis-insurance`` (strips ``kb_``)."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kbrjlug6u3", "name": "kb_aegis-insurance"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        assert binding["name"] == "kb-retrieval-aegis-insurance"

    def test_kb_name_without_kb_prefix_prepends_kb_retrieval(self) -> None:
        """A name with no ``kb-`` / ``kb_`` prefix is prefixed as-is."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kb-1", "name": "aegis-shield"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        assert binding["name"] == "kb-retrieval-aegis-shield"

    def test_kb_name_bare_kb_dash_falls_back_to_kb_id(self) -> None:
        """A name that is just ``kb-`` (stripped to empty) falls back to
        ``kb-retrieval-{kb_id}`` so the tool is still addressable."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kbabc123", "name": "kb-"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        assert binding["name"] == "kb-retrieval-kbabc123"

    def test_kb_no_name_field_uses_id_based_fallback(self) -> None:
        """Records with no ``name`` field synthesise ``kb_{id}`` then normalise
        it: ``kb-retrieval-{id_without_kb_prefix}``."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kbxyz999"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        # raw_name = "kb_kbxyz999" → stripped = "kbxyz999" → "kb-retrieval-kbxyz999"
        assert binding["name"] == "kb-retrieval-kbxyz999"

    def test_kb_name_normalisation_never_double_prefixes(self) -> None:
        """Calling the function twice on the same record must not add a second
        ``kb-retrieval-`` segment.  The stripping logic is idempotent because it
        only strips ``kb-`` / ``kb_`` — not the full ``kb-retrieval-`` prefix."""
        binding = knowledge_base_record_to_function_binding(
            {"id": "kb-1", "name": "kb-gcnv"}, project_id=VALID_PROJECT_ID
        )
        assert binding is not None
        assert binding["name"] == "kb-retrieval-gcnv"
        # The prefix appears exactly once.
        assert binding["name"].count("kb-retrieval-") == 1

    def test_synthetic_single_agent_team_uses_orchestration_single(self) -> None:
        payload = synthetic_single_agent_team(
            project_id=VALID_PROJECT_ID,
            agent_id="a1",
            agent_dict={"name": "a1", "instructions": ""},
            source={"name": "a1", "description": "d"},
        )
        assert payload["_team_id"] == "_agent_a1_"
        assert payload["semantic_kernel"]["orchestration"]["type"] == "single"
        assert payload["semantic_kernel"]["agents"][0]["name"] == "a1"


# ---------------------------------------------------------------------------
# 6) FileConfigLoader
# ---------------------------------------------------------------------------


class TestFileConfigLoader:
    @pytest.mark.asyncio
    async def test_file_loader_serves_existing_fixtures(self, tmp_path: Path) -> None:
        team_dir = tmp_path / "teams"
        team_dir.mkdir()
        (team_dir / "team-a.json").write_text(json.dumps(_make_payload()))
        loader = FileConfigLoader(teams_dir=team_dir)
        teams = await loader.list_teams(VALID_PROJECT_ID)
        assert {t["id"] for t in teams} == {"team-x"}
        got = await loader.get_team(VALID_PROJECT_ID, "team-x")
        assert got is not None
        assert got["_team_id"] == "team-x"

    @pytest.mark.asyncio
    async def test_file_loader_404_when_unknown(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert await loader.get_team(VALID_PROJECT_ID, "nope") is None
        assert await loader.list_teams(VALID_PROJECT_ID) == []


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    def test_warm_team_entries_parses_pairs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_WARM_TEAMS", "p1/t1, p2/t2 ,, badnoslash")
        s = Settings()
        assert s.warm_team_entries() == [("p1", "t1"), ("p2", "t2")]

    def test_remote_enabled_requires_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONFIG_SOURCE", "remote")
        monkeypatch.setenv("CONFIG_SERVICE_URL", "")
        assert Settings().remote_enabled is False
        monkeypatch.setenv("CONFIG_SERVICE_URL", "https://x")
        assert Settings().remote_enabled is True
