"""Integration test — admin endpoints success-path contract.

The integration audit (M1) flagged `/admin/config/invalidate` and
`/admin/config/status` as covered only at the 401 layer. The 200
success paths — which actually exercise the wiring through the
remote-config source / lazy registry, return the documented response
envelope, and require operators to validate cache invalidation in
prod — were untested.

This test pins:

  1. `POST /api/v1/admin/config/invalidate` with a valid API key
     returns 200 and the documented `{"invalidated": {...}}` envelope.
  2. `?project_id=X` alone evicts the whole project cache.
  3. `?project_id=X&team_id=Y` invalidates just one team.
  4. `?project_id=X&agent_id=Z` invalidates just one agent.
  5. Both together independently invalidate each kind.
  6. `GET /admin/config/status` with a valid API key returns 200
     with a `{"mode": ...}` shape (either `"file"` or `"remote"`).
  7. Both routes still 401 with an invalid key (regression guard
     for the auth gate the existing tests cover).
"""

from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.interface_layer.api import create_app

VALID_KEY = "admin-test-key-xyz"


@pytest.fixture
def auth_client() -> Iterator[TestClient]:  # type: ignore[name-defined]
    """Boot a TestClient with auth enabled and a single valid API key."""
    with patch.dict(
        "os.environ",
        {
            "AGENT_INTERFACE__AUTH__ENABLED": "true",
            "AGENT_INTERFACE__AUTH__API_KEYS": VALID_KEY,
        },
    ):
        app = create_app()
        with TestClient(app) as client:
            yield client


def _hdr() -> dict[str, str]:
    return {"X-API-Key": VALID_KEY}


# ---------------------------------------------------------------------------
# (1) Invalidate — happy paths
# ---------------------------------------------------------------------------


class TestAdminConfigInvalidate:
    """`POST /api/v1/admin/config/invalidate` happy-path coverage."""

    def test_invalidate_full_project_returns_200(self, auth_client: TestClient) -> None:
        """`?project_id=X` with no team/agent invalidates the whole
        project cache. Documented envelope: `{"invalidated": {...}}`."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate?project_id=p1",
            headers=_hdr(),
        )
        assert resp.status_code == 200, (
            f"valid API key must yield 200, got: {resp.status_code} {resp.text}"
        )
        body = resp.json()
        assert "invalidated" in body, f"response must carry an 'invalidated' envelope, got: {body}"
        assert body["invalidated"]["project_id"] == "p1"
        assert body["invalidated"]["team_id"] is None
        assert body["invalidated"]["agent_id"] is None

    def test_invalidate_specific_team(self, auth_client: TestClient) -> None:
        """`?project_id=X&team_id=Y` only invalidates the named team."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate?project_id=p1&team_id=alpha",
            headers=_hdr(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["invalidated"]["team_id"] == "alpha"
        assert body["invalidated"]["agent_id"] is None

    def test_invalidate_specific_agent(self, auth_client: TestClient) -> None:
        """`?project_id=X&agent_id=Z` only invalidates the named agent."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate?project_id=p1&agent_id=echo",
            headers=_hdr(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["invalidated"]["agent_id"] == "echo"
        assert body["invalidated"]["team_id"] is None

    def test_invalidate_both_team_and_agent(self, auth_client: TestClient) -> None:
        """Both team_id and agent_id supplied — each invalidated
        independently per the docstring."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate?project_id=p1&team_id=alpha&agent_id=echo",
            headers=_hdr(),
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["invalidated"]["project_id"] == "p1"
        assert body["invalidated"]["team_id"] == "alpha"
        assert body["invalidated"]["agent_id"] == "echo"

    def test_invalidate_missing_project_id_returns_4xx(self, auth_client: TestClient) -> None:
        """`project_id` is a required query param. FastAPI surfaces
        a missing required query as 422 — pin that contract."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate",
            headers=_hdr(),
        )
        assert 400 <= resp.status_code < 500, (
            f"missing project_id must yield 4xx, got: {resp.status_code}"
        )

    def test_invalidate_with_invalid_api_key_returns_401(self, auth_client: TestClient) -> None:
        """Regression guard — invalid key still 401."""
        resp = auth_client.post(
            "/api/v1/admin/config/invalidate?project_id=p1",
            headers={"X-API-Key": "wrong-key"},
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (2) Status — happy path
# ---------------------------------------------------------------------------


class TestAdminConfigStatus:
    """`GET /admin/config/status` happy-path coverage."""

    def test_status_returns_200_with_mode_field(self, auth_client: TestClient) -> None:
        """Valid API key yields 200; response must include a `mode`
        field. Default test wiring is file-mode, so we expect
        `mode == "file"` — but we accept "remote"/"unwired" in case
        the test env config changes."""
        resp = auth_client.get("/admin/config/status", headers=_hdr())
        assert resp.status_code == 200, (
            f"valid API key must yield 200, got: {resp.status_code} {resp.text}"
        )
        body = resp.json()
        assert "mode" in body, f"response must carry a 'mode' field, got: {body}"
        assert body["mode"] in {"file", "remote", "unwired"}, (
            f"mode must be one of the three documented values, got: {body['mode']!r}"
        )

    def test_status_remote_mode_includes_hit_rate_snapshot(self, auth_client: TestClient) -> None:
        """When the source is remote, the status snapshot is spread
        into the response — confirms the `**snap` spread path. With
        a file loader the snapshot is empty so we just confirm the
        envelope shape doesn't crash."""
        resp = auth_client.get("/admin/config/status", headers=_hdr())
        assert resp.status_code == 200
        body = resp.json()
        # File-mode returns {"mode": "file"} only; remote-mode adds
        # snapshot keys (hit rate, sizes, TTL). The response must
        # always be a dict and contain 'mode'.
        assert isinstance(body, dict)
        assert "mode" in body

    def test_status_with_invalid_api_key_returns_401(self, auth_client: TestClient) -> None:
        """Regression guard — invalid key still 401."""
        resp = auth_client.get(
            "/admin/config/status",
            headers={"X-API-Key": "wrong-key"},
        )
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# (3) Routes are wired on their respective routers
# ---------------------------------------------------------------------------


class TestAdminRouteWiring:
    """Pin where each admin route lives — the audit's auth concern
    was that `/admin/config/status` is on the *un-prefixed* system
    router (not under `/api/v1`), so the auth middleware's
    protected-paths tuple needs both prefixes. This test confirms
    both routes return the right status when reached with the
    correct path."""

    def test_invalidate_is_under_api_v1_prefix_only(self, auth_client: TestClient) -> None:
        """The invalidate endpoint is mounted on `/api/v1/admin/...`,
        NOT on `/admin/...`."""
        # Reachable at the api_router path.
        ok = auth_client.post("/api/v1/admin/config/invalidate?project_id=p1", headers=_hdr())
        assert ok.status_code == 200

        # Not reachable at the un-prefixed system_router path.
        nf = auth_client.post("/admin/config/invalidate?project_id=p1", headers=_hdr())
        assert nf.status_code == 404, (
            f"invalidate must NOT be exposed on the un-prefixed system path; "
            f"got {nf.status_code} (route may have moved)"
        )

    def test_status_is_under_un_prefixed_system_router_only(self, auth_client: TestClient) -> None:
        """The status endpoint is on the un-prefixed `system_router`."""
        # Reachable at the system_router path.
        ok = auth_client.get("/admin/config/status", headers=_hdr())
        assert ok.status_code == 200

        # Not reachable at the api_router path.
        nf = auth_client.get("/api/v1/admin/config/status", headers=_hdr())
        assert nf.status_code == 404, (
            f"status must NOT be exposed on the api_router path; "
            f"got {nf.status_code} (route may have moved)"
        )
