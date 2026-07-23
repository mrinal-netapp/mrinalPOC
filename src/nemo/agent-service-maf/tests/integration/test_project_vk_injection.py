"""Integration test — per-project VK injection at team-bundle build.

Pins the full wiring: a `LazyTeamRegistry` constructed with a
`ProjectVKResolver` builds a `TeamBundle` whose `LLMGateway` carries
the VK fetched from config-service — NOT the env-sourced
deployment-wide master key.

Also pins the failure mode: when the resolver can't find a VK (404
/ network error / missing field), the bundle goes unhealthy with the
error surfaced on `bundle.startup_error`. There is no silent
fallback to `AGENT_GATEWAY__API_KEY`.

This is the integration-tier proof that the migration from env-var
VK to per-project VK is complete end-to-end.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi.testclient import TestClient

from agent_service_maf.core.team_loader import build_team_bundle
from agent_service_maf.core.team_registry_lazy import LazyTeamRegistry
from agent_service_maf.gateway.project_vk_resolver import (
    MissingProjectVirtualKeyError,
)
from tests.conftest import TEST_PROJECT_ID

TEAM_ID = "vk_team"


def _team_config(default_model: str = "gpt-4o-mini") -> dict[str, Any]:
    return {
        "_schema_version": "2.0.0",
        "project_id": TEST_PROJECT_ID,
        "_team_id": TEAM_ID,
        "_team_name": "VK injection test",
        "_description": "Verifies per-project VK reaches LLMGateway",
        "agent": {
            "framework": "mock",
            "model": default_model,
            "temperature": 0.0,
            "max_tokens": 64,
            "timeout_seconds": 30,
            "metadata": {"project": "test", "version": "0.0.0", "environment": "test"},
        },
        "semantic_kernel": {
            "agents": [
                {
                    "name": "mock",
                    "instructions": "Echo.",
                    "description": "test",
                    "model": default_model,
                    "temperature": 0.0,
                    "max_tokens": 64,
                    "tools": [],
                    "mcp_servers": [],
                    "function_choice_behavior": "auto",
                },
            ],
            "orchestration": {"type": "single"},
        },
        "interface": {
            "host": "0.0.0.0",
            "port": 8000,
            "cors_origins": ["*"],
            "request_timeout_seconds": 30,
            "max_concurrent_requests": 10,
            "auth": {"enabled": False},
        },
        "gateway": {
            # api_key is rejected in JSON config files by design
            # (Secrets-must-come-from-env validation). After VK
            # injection the BifrostClient's api_key reflects the
            # resolver-supplied bearer; without injection it stays
            # empty — both branches asserted below.
            "api_key": "",
            "url": "http://bifrost.test/v1",
            "default_model": default_model,
            "request_timeout_seconds": 10,
            "retry_on_timeout": False,
            "max_retries": 0,
        },
        "guardrails": {"enabled": False, "fail_open": True},
        "mcp": {
            "connection_timeout_seconds": 5,
            "lazy_connect": True,
            "tool_call_timeout_seconds": 5,
            "max_tool_retries": 0,
            "retry_on_timeout": False,
            "discovery_on_connect": False,
            "tool_name_format": "qualified",
            "max_concurrent_tool_calls": 1,
        },
        "mcp_servers": [],
        "memory": {"enabled": False},
        "logging": {"level": "WARNING", "format": "json", "include_timestamp": True},
    }


def _write_team(tmp_path: Path, config: dict[str, Any]) -> Path:
    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    p = teams_dir / f"{TEAM_ID}.json"
    p.write_text(json.dumps(config))
    return p


class _StubVKResolver:
    """A resolver stand-in whose `get_for_project` is fully scripted by
    the test. Lets us inject a VK without standing up an httpx mock."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self._next_vk: str | None = None
        self._next_error: Exception | None = None

    def set_next_vk(self, vk: str) -> None:
        self._next_vk = vk
        self._next_error = None

    def set_next_error(self, exc: Exception) -> None:
        self._next_error = exc
        self._next_vk = None

    async def get_for_project(self, project_id: str, model_id_hint: str) -> str:
        self.calls.append((project_id, model_id_hint))
        if self._next_error is not None:
            raise self._next_error
        if self._next_vk is None:
            raise RuntimeError("StubVKResolver: no VK programmed")
        return self._next_vk

    def invalidate(self, project_id: str) -> None: ...
    def invalidate_all(self) -> None: ...


# ---------------------------------------------------------------------------
# (1) VK reaches the team's LLMGateway
# ---------------------------------------------------------------------------


async def test_per_project_vk_overrides_gateway_api_key(tmp_path: Path) -> None:
    """The headline assertion: after build_team_bundle returns, the
    team's LLMGateway must hold the VK from the resolver, NOT the
    placeholder from the team config (which represents the env-var
    fallback that we are explicitly NOT using).

    The caller threads ``vk_model_hint`` from the raw agent record;
    the file-mode `build_team_bundle` path doesn't have agent
    records, so we pass the hint explicitly. In production the
    remote `build_team_bundle_from_team_blob` extracts the hint
    from each resolved agent's ``modelId`` automatically."""
    cfg_path = _write_team(tmp_path, _team_config())
    resolver = _StubVKResolver()
    resolver.set_next_vk("vk-from-config-service-bearer-XYZ")

    bundle = await build_team_bundle(cfg_path, vk_resolver=resolver, vk_model_hint="gpt-4o-mini")

    assert bundle.healthy, f"bundle should be healthy, got: {bundle.startup_error}"
    assert resolver.calls == [(TEST_PROJECT_ID, "gpt-4o-mini")], (
        "resolver must be called with the team's project_id and the "
        "model hint the caller supplied; "
        f"got: {resolver.calls}"
    )

    # The LLMGateway's underlying BifrostClient carries the resolved VK.
    gw = bundle.gateway
    assert gw is not None
    # The api_key on the gateway's config object reflects the override.
    assert gw.config.api_key == "vk-from-config-service-bearer-XYZ", (
        f"gateway.config.api_key must be the resolver-supplied VK, got: {gw.config.api_key!r}"
    )
    # And the BifrostClient (which actually sends Authorization headers)
    # carries the same key.
    assert gw._http_client.api_key == "vk-from-config-service-bearer-XYZ", (  # type: ignore[attr-defined]
        f"BifrostClient.api_key must carry the resolver VK, got: {gw._http_client.api_key!r}"  # type: ignore[attr-defined]
    )

    # And the api_key is now non-empty — proves the env-style empty
    # default was replaced by the resolver-supplied VK.
    assert gw.config.api_key != ""


async def test_per_project_vk_stamped_on_mcp_servers(tmp_path: Path) -> None:
    """The same resolved VK must reach the team's MCP server connections.

    Bifrost's aggregated ``/mcp`` proxy authenticates with the per-project
    VK (it has no master key). After build, each Bifrost-routed MCP server
    config must carry ``Authorization: Bearer <vk>`` so ``connect()`` does
    not get a 401. This pins the wiring in ``_build_bundle_common``, not
    just the pure helper.
    """
    cfg = _team_config()
    cfg["mcp_servers"] = [
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost.test/mcp",
            "gateway_server_name": f"{TEST_PROJECT_ID}_weather",
        }
    ]
    cfg_path = _write_team(tmp_path, cfg)
    resolver = _StubVKResolver()
    resolver.set_next_vk("vk-for-mcp-bearer-XYZ")

    bundle = await build_team_bundle(cfg_path, vk_resolver=resolver, vk_model_hint="gpt-4o-mini")

    assert bundle.healthy, f"bundle should be healthy, got: {bundle.startup_error}"
    assert bundle.mcp_manager is not None
    # Reach the loaded server configs (lazy-loaded from the inline list
    # the build path handed to the MCPManager).
    configs = await bundle.mcp_manager._connection_manager._ensure_server_configs()  # type: ignore[attr-defined]
    assert len(configs) == 1
    assert configs[0].headers.get("Authorization") == "Bearer vk-for-mcp-bearer-XYZ", (
        "the Bifrost-routed MCP server must carry the resolver-supplied VK "
        f"as Authorization; got headers: {configs[0].headers!r}"
    )


# ---------------------------------------------------------------------------
# (2) Resolver failure → unhealthy bundle (no env fallback)
# ---------------------------------------------------------------------------


async def test_resolver_failure_yields_unhealthy_bundle(tmp_path: Path) -> None:
    """When the resolver raises MissingProjectVirtualKeyError, the
    bundle MUST go unhealthy. It must NOT silently fall back to the
    placeholder in the team config (env-var path). The error message
    must be operator-readable on `bundle.startup_error`."""
    cfg_path = _write_team(tmp_path, _team_config())
    resolver = _StubVKResolver()
    resolver.set_next_error(
        MissingProjectVirtualKeyError("ProjectInitWorkflow has not completed Step 0")
    )

    bundle = await build_team_bundle(cfg_path, vk_resolver=resolver, vk_model_hint="gpt-4o-mini")

    assert not bundle.healthy, "bundle MUST go unhealthy when VK lookup fails (no env fallback)"
    assert "MissingProjectVirtualKeyError" in bundle.startup_error, (
        f"startup_error must surface the resolver error class, got: {bundle.startup_error!r}"
    )
    assert "ProjectInitWorkflow" in bundle.startup_error, (
        f"resolver error message must be preserved verbatim, got: {bundle.startup_error!r}"
    )


async def test_no_resolver_passed_keeps_env_fallback(tmp_path: Path) -> None:
    """Backwards-compat: when `vk_resolver=None` (the file-mode path),
    the team's gateway.api_key from the config (which is sourced from
    the env var in real deployments) is preserved unchanged. This
    keeps the test/dev escape hatch working."""
    cfg_path = _write_team(tmp_path, _team_config())

    bundle = await build_team_bundle(cfg_path, vk_resolver=None)

    assert bundle.healthy
    # With no resolver the gateway.api_key from config flows through
    # untouched. In production, env-source resolution feeds this field
    # (here it's empty because the JSON config can't carry it).
    assert bundle.gateway is not None
    assert bundle.gateway.config.api_key == ""


# ---------------------------------------------------------------------------
# (3) LazyTeamRegistry threads the resolver into every build path
# ---------------------------------------------------------------------------


async def test_lazy_registry_threads_resolver_to_file_mode_build(
    tmp_path: Path,
) -> None:
    """The lazy registry receives `vk_resolver` at construction and
    must pass it through to the file-mode `build_team_bundle` call.

    File-mode has no agent record to extract a model-id hint from, so
    after removing the cluster-wide ``gateway.default_model`` fallback
    the resolver path goes unhealthy with a
    ``MissingProjectVirtualKeyError`` startup_error. That error is the
    proof of threading: it only appears when ``vk_resolver`` is
    non-None — without threading, the build skips this branch and
    returns a healthy (env-style) bundle. Both directions asserted
    here against the matching ``_no_resolver_passed_keeps_env_fallback``
    test above."""
    cfg_path = _write_team(tmp_path, _team_config())

    # The lazy registry's file-source short-circuit looks up the path
    # via `source.get_team_file_path(project_id, team_id)`.
    class _FileSource:
        def get_team_file_path(self, project_id: str, team_id: str) -> Path | None:
            if project_id == TEST_PROJECT_ID and team_id == TEAM_ID:
                return cfg_path
            return None

    resolver = _StubVKResolver()
    resolver.set_next_vk("vk-via-lazy-registry-123")

    registry = LazyTeamRegistry(
        source=_FileSource(),  # type: ignore[arg-type]
        post_build_hook=None,
        vk_resolver=resolver,
    )

    bundle = await registry.get_or_load_team(TEST_PROJECT_ID, TEAM_ID)
    assert bundle is not None
    # File-mode + resolver-wired: the resolver code path is entered,
    # but with no model-id hint available it short-circuits to
    # unhealthy. That outcome only happens when the resolver was
    # actually threaded — proving the lazy registry passed it through.
    assert not bundle.healthy, (
        "file-mode + resolver but no hint must produce an unhealthy "
        "bundle — that's the proof the resolver branch was entered"
    )
    assert "MissingProjectVirtualKeyError" in (bundle.startup_error or ""), (
        f"startup_error must come from the resolver branch in "
        f"_build_bundle_common; got: {bundle.startup_error!r}"
    )
    # Resolver itself was never called (we never got past the
    # hint-required guard) — file-mode has no agent record to derive
    # a hint from, by design.
    assert resolver.calls == []


# ---------------------------------------------------------------------------
# (4) Admin invalidate hook drops the VK cache entry
# ---------------------------------------------------------------------------


def test_admin_invalidate_drops_project_vk(tmp_path: Path) -> None:
    """`POST /admin/config/invalidate?project_id=X` must call
    `resolver.invalidate(X)` so a VK rotation in config-service
    propagates without restarting MAF."""
    from agent_service_maf.interface_layer.api import create_app

    # Use the real resolver class but with a recording stub `invalidate`.
    invalidations: list[str] = []

    class _RecordingResolver:
        def invalidate(self, project_id: str) -> None:
            invalidations.append(project_id)

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    # Minimal team config so create_app boots cleanly in file mode.
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": "mock"},
            }
        )
    )

    env = {
        "AGENT_AGENT__FRAMEWORK": "mock",
        "AGENT_TEAMS_DIR": str(teams_dir),
        "AGENT_INTERFACE__AUTH__ENABLED": "true",
        "AGENT_INTERFACE__AUTH__API_KEYS": "vk-admin-test-key",
    }
    with patch.dict("os.environ", env):
        app = create_app()
        # Inject the recording resolver after lifespan startup — file
        # mode doesn't wire one by default, so we attach manually.
        with TestClient(app) as client:
            client.app.state.project_vk_resolver = _RecordingResolver()
            resp = client.post(
                "/api/v1/admin/config/invalidate?project_id=p1",
                headers={"X-API-Key": "vk-admin-test-key"},
            )
            assert resp.status_code == 200
            assert invalidations == ["p1"], (
                f"invalidate hook must call resolver.invalidate(project_id); got: {invalidations}"
            )


# ---------------------------------------------------------------------------
# (5) status endpoint surfaces VK cache snapshot
# ---------------------------------------------------------------------------


def test_admin_status_includes_project_vk_snapshot(tmp_path: Path) -> None:
    """`GET /admin/config/status` must include a `project_vk` field
    when the resolver is wired — gives operators a single endpoint
    for both config-source and VK cache state."""
    from agent_service_maf.interface_layer.api import create_app

    class _SnapshotResolver:
        def status_snapshot(self) -> dict[str, Any]:
            return {"size": 7, "max_size": 200, "ttl_seconds": 60}

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": "mock"},
            }
        )
    )
    env = {
        "AGENT_AGENT__FRAMEWORK": "mock",
        "AGENT_TEAMS_DIR": str(teams_dir),
        "AGENT_INTERFACE__AUTH__ENABLED": "true",
        "AGENT_INTERFACE__AUTH__API_KEYS": "vk-status-test-key",
    }
    with patch.dict("os.environ", env):
        app = create_app()
        with TestClient(app) as client:
            client.app.state.project_vk_resolver = _SnapshotResolver()
            resp = client.get(
                "/admin/config/status",
                headers={"X-API-Key": "vk-status-test-key"},
            )
            assert resp.status_code == 200
            body = resp.json()
            assert "project_vk" in body, (
                f"status response must surface the VK cache snapshot; got: {body}"
            )
            assert body["project_vk"] == {
                "size": 7,
                "max_size": 200,
                "ttl_seconds": 60,
            }
