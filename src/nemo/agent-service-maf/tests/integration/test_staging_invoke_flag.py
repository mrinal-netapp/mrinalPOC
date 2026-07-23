"""Integration tests for the ``staging`` query parameter on invoke surfaces.

These tests pin the protocol-layer contract only:

- sync invoke passes ``query_options`` into ``routes._resolve_team``
- SSE invoke/stream passes ``query_options`` into ``routes._resolve_team``

The deeper cache-bypass behaviour itself is covered at the unit layer by
``test_config_service_migration.py`` and ``test_remote_loader.py``.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX


@contextlib.contextmanager
def _boot_app(tmp_path: Any) -> Iterator[TestClient]:
    """Boot a fresh TestClient with the globally-registered MockAgent."""
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader
    from agent_service_maf.interface_layer.api import create_app

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir(parents=True, exist_ok=True)
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
        "AGENT_INTERFACE__AUTH__ENABLED": "false",
        "CONFIG_SOURCE": "file",
    }
    with (
        patch.dict("os.environ", env),
        patch(
            "agent_service_maf.config.settings.settings.CONFIG_SOURCE",
            "file",
        ),
        patch(
            "agent_service_maf.core.team_loader.ConfigLoader",
            return_value=RealConfigLoader(json_config_path=None),
        ),
    ):
        app = create_app()
        with TestClient(app) as client:
            yield client


def _parse_sse(body: str) -> list[dict[str, Any]]:
    body = body.replace("\r\n", "\n")
    records: list[dict[str, Any]] = []
    for raw in body.split("\n\n"):
        event: str | None = None
        data: list[str] = []
        for line in raw.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data.append(line[len("data:") :].lstrip())
        if event is None and not data:
            continue
        joined = "\n".join(data)
        try:
            payload: Any = json.loads(joined)
        except (ValueError, TypeError):
            payload = joined
        records.append({"event": event, "data": payload})
    return records


@pytest.mark.integration
class TestStagingInvokeFlag:
    def test_sync_invoke_threads_exact_playground(self, tmp_path: Any) -> None:
        from agent_service_maf.interface_layer import routes

        seen: list[str] = []
        original = routes._resolve_team

        async def _spy(*args: Any, **kwargs: Any):
            opts = kwargs.get("query_options")
            seen.append(opts.staging if opts is not None else "default")
            return await original(*args, **kwargs)

        with _boot_app(tmp_path) as client, patch.object(routes, "_resolve_team", side_effect=_spy):
            resp = client.post(
                f"{TEST_PROJECT_PREFIX}/agent-teams/default/invoke?staging=playground",
                json={"input": "hello"},
            )

        assert resp.status_code == 200, resp.text
        assert "playground" in seen

    def test_sse_invoke_maps_unknown_value_to_default(self, tmp_path: Any) -> None:
        from agent_service_maf.interface_layer import routes

        seen: list[str] = []
        original = routes._resolve_team

        async def _spy(*args: Any, **kwargs: Any):
            opts = kwargs.get("query_options")
            seen.append(opts.staging if opts is not None else "default")
            return await original(*args, **kwargs)

        with _boot_app(tmp_path) as client, patch.object(routes, "_resolve_team", side_effect=_spy):
            resp = client.post(
                f"{TEST_PROJECT_PREFIX}/agent-teams/default/invoke/stream?staging=eval",
                json={"input": "hello"},
            )

        assert resp.status_code == 200, resp.text
        assert seen and all(value == "default" for value in seen)
        events = [rec["event"] for rec in _parse_sse(resp.text) if rec["event"]]
        assert "thinking" in events
        assert "token" in events
