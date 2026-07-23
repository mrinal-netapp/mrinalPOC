"""Smoke test — full remote-mode boot exercises the VK resolver.

The other VK tests use `build_team_bundle` directly with a stub
resolver. This file goes one level higher: boot the FastAPI app
under `CONFIG_SOURCE=remote` with `CONFIG_SERVICE_URL` pointing at
an in-process stub, then verify:

  1. Lifespan startup wires the resolver and stashes it on
     `app.state.project_vk_resolver`.
  2. `GET /admin/config/status` surfaces both the remote-cache and
     VK cache snapshots — proving the resolver is reachable end-to-end.
  3. `POST /admin/config/invalidate?project_id=X` invalidates the
     real (not stubbed) resolver's cache, so a VK rotation
     propagates without a service restart.

The stub config-service is a tiny FastAPI app that serves the
minimum routes MAF's `RemoteConfigCache` + `ProjectVKResolver` ever
call. This catches lifespan-wiring bugs the lower-level tests can't.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _restore_settings_singleton() -> Iterator[None]:
    """Each smoke test mutates the runtime_settings singleton to pick
    up env-var changes. Snapshot and restore so the mutation does not
    leak into later integration tests that share the same module-level
    singleton."""
    import importlib

    settings_mod = importlib.import_module("agent_service_maf.config.settings")
    original = settings_mod.settings
    try:
        yield
    finally:
        settings_mod.settings = original


# ---------------------------------------------------------------------------
# In-process stub config-service
# ---------------------------------------------------------------------------


def _build_stub_config_service(
    project_id: str,
    vk_token: str,
) -> FastAPI:
    """Tiny FastAPI app serving the minimum config-service surface MAF
    actually hits when remote mode is enabled."""
    app = FastAPI()
    call_log: dict[str, int] = {"models_get": 0, "teams_get": 0, "agents_get": 0}
    app.state.calls = call_log
    app.state.vk_token = vk_token

    @app.get("/api/v1/projects/{pid}/models/{mid}")
    async def get_model(pid: str, mid: str) -> JSONResponse:
        call_log["models_get"] += 1
        if pid != project_id:
            return JSONResponse(status_code=404, content={"error": "unknown project"})
        return JSONResponse(
            content={
                "id": mid,
                "providerModelId": mid,
                "gatewayModelId": f"openai/{mid}",
                "gatewayApiKey": app.state.vk_token,
            }
        )

    @app.get("/api/v1/projects/{pid}/agent-teams/{tid}")
    async def get_team(pid: str, tid: str) -> JSONResponse:
        call_log["teams_get"] += 1
        return JSONResponse(status_code=404, content={"error": "no teams (smoke)"})

    @app.get("/api/v1/projects/{pid}/agents/{aid}")
    async def get_agent(pid: str, aid: str) -> JSONResponse:
        call_log["agents_get"] += 1
        return JSONResponse(status_code=404, content={"error": "no agents (smoke)"})

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True}

    return app


@contextmanager
def _serve_stub(app: FastAPI, port: int) -> Iterator[str]:
    """Run the stub FastAPI app in a background thread on the chosen
    port. Yields the base URL once it's healthy."""
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{port}"
    # Wait for /health.
    deadline = time.time() + 5.0
    while time.time() < deadline:
        try:
            with httpx.Client(timeout=1.0) as c:
                r = c.get(f"{base}/health")
                if r.status_code == 200:
                    break
        except Exception:
            pass
        time.sleep(0.05)
    else:
        server.should_exit = True
        thread.join(timeout=2)
        pytest.fail(f"Stub config-service didn't become healthy on {base}")
    try:
        yield base
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def _free_port() -> int:
    import socket

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


PROJECT_ID = "00000000-0000-0000-0000-000000000001"
VK_TOKEN = "vk-smoke-test-bearer-abc123"


# ---------------------------------------------------------------------------
# Smoke tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_remote_mode_lifespan_wires_vk_resolver() -> None:
    """Booting MAF with CONFIG_SOURCE=remote + a reachable config-service
    must wire a ProjectVKResolver onto app.state."""
    from agent_service_maf.interface_layer.api import create_app

    port = _free_port()
    stub = _build_stub_config_service(PROJECT_ID, VK_TOKEN)

    with _serve_stub(stub, port) as base:
        env = {
            "CONFIG_SOURCE": "remote",
            "CONFIG_SERVICE_URL": base,
            "KEYCLOAK_INTERNAL_ISSUER": "",  # disable real Keycloak; service_auth still constructs
            "KEYCLOAK_CLIENT_ID": "",
            "KEYCLOAK_CLIENT_SECRET": "",
            "CONFIG_HTTP_TIMEOUT": "5.0",
            "CONFIG_CACHE_TTL": "30",
            "AGENT_INTERFACE__AUTH__ENABLED": "false",
        }
        with patch.dict("os.environ", env, clear=False):
            # Force the runtime_settings singleton to re-read env.
            import importlib

            _settings_mod = importlib.import_module("agent_service_maf.config.settings")
            _settings_mod.settings = _settings_mod.Settings()

            app = create_app()
            with TestClient(app) as client:
                # Resolver must be on app.state.
                resolver = getattr(client.app.state, "project_vk_resolver", None)
                assert resolver is not None, (
                    "ProjectVKResolver must be wired on app.state in remote mode"
                )
                # And it must be the real class, not a stub.
                from agent_service_maf.gateway.project_vk_resolver import (
                    ProjectVKResolver,
                )

                assert isinstance(resolver, ProjectVKResolver)


@pytest.mark.integration
def test_admin_status_surfaces_vk_cache_under_remote_mode() -> None:
    """`GET /admin/config/status` returns both remote-cache and
    project_vk snapshots when remote mode is wired."""
    from agent_service_maf.interface_layer.api import create_app

    port = _free_port()
    stub = _build_stub_config_service(PROJECT_ID, VK_TOKEN)

    with _serve_stub(stub, port) as base:
        env = {
            "CONFIG_SOURCE": "remote",
            "CONFIG_SERVICE_URL": base,
            "KEYCLOAK_INTERNAL_ISSUER": "",
            "KEYCLOAK_CLIENT_ID": "",
            "KEYCLOAK_CLIENT_SECRET": "",
            "AGENT_INTERFACE__AUTH__ENABLED": "false",
        }
        with patch.dict("os.environ", env, clear=False):
            import importlib

            _settings_mod = importlib.import_module("agent_service_maf.config.settings")
            _settings_mod.settings = _settings_mod.Settings()

            app = create_app()
            with TestClient(app) as client:
                resp = client.get("/admin/config/status")
                assert resp.status_code == 200, (
                    f"status must succeed in remote mode (auth disabled), "
                    f"got: {resp.status_code} {resp.text}"
                )
                body = resp.json()
                assert body["mode"] == "remote", (
                    f"mode must be 'remote' when CONFIG_SERVICE_URL is set; got: {body}"
                )
                assert "project_vk" in body, f"status must surface project_vk snapshot; got: {body}"
                vk = body["project_vk"]
                # Cold-start cache state. TTL matches CONFIG_CACHE_TTL
                # (default 60s) — the singleton in api.py imports
                # runtime_settings at module load so a per-test env
                # override may not propagate; we accept the default.
                assert vk["size"] == 0
                assert vk["max_size"] == 200
                assert vk["ttl_seconds"] >= 1


@pytest.mark.integration
def test_admin_invalidate_triggers_vk_cache_drop_under_remote_mode() -> None:
    """The invalidate route must reach the real resolver's `invalidate`
    in remote mode. We exercise this by seeding a VK into the cache,
    confirming the cache size is 1, calling invalidate, and confirming
    the size is back to 0."""
    from agent_service_maf.interface_layer.api import create_app

    port = _free_port()
    stub = _build_stub_config_service(PROJECT_ID, VK_TOKEN)

    with _serve_stub(stub, port) as base:
        env = {
            "CONFIG_SOURCE": "remote",
            "CONFIG_SERVICE_URL": base,
            "KEYCLOAK_INTERNAL_ISSUER": "",
            "KEYCLOAK_CLIENT_ID": "",
            "KEYCLOAK_CLIENT_SECRET": "",
            "AGENT_INTERFACE__AUTH__ENABLED": "false",
        }
        with patch.dict("os.environ", env, clear=False):
            import importlib

            _settings_mod = importlib.import_module("agent_service_maf.config.settings")
            _settings_mod.settings = _settings_mod.Settings()

            app = create_app()
            with TestClient(app) as client:
                resolver = client.app.state.project_vk_resolver

                # Seed the cache by calling get_for_project directly via
                # the portal so we share the lifespan's loop.
                async def _seed() -> str:
                    return await resolver.get_for_project(PROJECT_ID, "gpt-4o-mini")

                vk = client.portal.call(_seed)
                assert vk == VK_TOKEN
                assert resolver.status_snapshot()["size"] == 1

                # Invalidate via the admin route.
                resp = client.post(f"/api/v1/admin/config/invalidate?project_id={PROJECT_ID}")
                assert resp.status_code == 200, (
                    f"invalidate must succeed, got: {resp.status_code} {resp.text}"
                )
                # Cache must be empty after invalidation.
                assert resolver.status_snapshot()["size"] == 0, (
                    "Admin invalidate must drop the project's VK cache entry"
                )

                # Stub call counter confirms we actually hit it.
                assert stub.state.calls["models_get"] >= 1


@pytest.mark.integration
def test_resolver_fetches_real_vk_from_stub() -> None:
    """End-to-end: the resolver actually performs an HTTP call to the
    stub config-service and pulls the gatewayApiKey out. Proves the
    URL shape + JSON field name + httpx wiring are all correct."""
    from agent_service_maf.interface_layer.api import create_app

    port = _free_port()
    stub = _build_stub_config_service(PROJECT_ID, VK_TOKEN)

    with _serve_stub(stub, port) as base:
        env = {
            "CONFIG_SOURCE": "remote",
            "CONFIG_SERVICE_URL": base,
            "KEYCLOAK_INTERNAL_ISSUER": "",
            "KEYCLOAK_CLIENT_ID": "",
            "KEYCLOAK_CLIENT_SECRET": "",
            "AGENT_INTERFACE__AUTH__ENABLED": "false",
        }
        with patch.dict("os.environ", env, clear=False):
            import importlib

            _settings_mod = importlib.import_module("agent_service_maf.config.settings")
            _settings_mod.settings = _settings_mod.Settings()

            app = create_app()
            with TestClient(app) as client:
                resolver = client.app.state.project_vk_resolver

                async def _fetch() -> str:
                    return await resolver.get_for_project(PROJECT_ID, "any-model")

                vk = client.portal.call(_fetch)
                assert vk == VK_TOKEN, (
                    f"Resolver must return the VK the stub config-service emitted; got: {vk!r}"
                )
                # Second call must hit the cache (no second HTTP request).
                client.portal.call(_fetch)
                assert stub.state.calls["models_get"] == 1, (
                    f"Second call must hit the cache; "
                    f"stub saw {stub.state.calls['models_get']} requests"
                )
