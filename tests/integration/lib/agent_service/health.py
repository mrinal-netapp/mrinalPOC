"""Pre-suite health/readiness gate for config-service and agent-service.

Probes the `/health` and `/ready` endpoints of both services and
aborts the whole pytest session (via `pytest.exit`) with an actionable message
when any check fails, so agent-service suites never run against a broken
local environment.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import pytest

from .client import AgentServiceClient
from .env import AgentServiceConfig

_TRUTHY = {"1", "true", "yes", "on"}


def _skip_agent_service_probe() -> bool:
    """Whether to skip the agent-service liveness/readiness preflight checks.

    The deployed ``/agents-maf`` edge route only exposes maf's ``/api/v1``
    surface, while maf serves ``/health`` and ``/ready`` at the service root —
    so those probes are unreachable through the gateway. Set
    ``SKIP_AGENT_SERVICE_HEALTH_PROBE=1`` to gate on config-service only (the
    invoke tests still exercise agent-service directly).
    """
    return os.getenv("SKIP_AGENT_SERVICE_HEALTH_PROBE", "").strip().lower() in _TRUTHY


def _validate(body: dict[str, Any], expected: dict[str, str]) -> str | None:
    """Return a human-readable reason when `body` does not match `expected`."""
    for key, want in expected.items():
        got = body.get(key)
        if got != want:
            return f"expected {key}={want!r}, got {got!r}"
    return None


def probe_services(client: AgentServiceClient, config: AgentServiceConfig) -> None:
    """Probe both services; `pytest.exit` on the first failing check.

    Function use:
        Runs the pre-suite health/readiness gate for config-service and
        agent-service, aborting the whole pytest session with an actionable
        message when any probe is unreachable, non-200, non-JSON, or unhealthy.

    Input:
        client (AgentServiceClient): Client used to issue the probes.
        config (AgentServiceConfig): Resolved config with the service URLs.

    Output:
        None
    """
    checks: list[tuple[str, str, str, dict[str, str]]] = [
        ("config-service", config.config_service_url, "/health", {"status": "healthy"}),
        (
            "config-service",
            config.config_service_url,
            "/ready",
            {"status": "ready", "database": "connected"},
        ),
    ]
    if not _skip_agent_service_probe():
        checks += [
            ("agent-service", config.agent_service_url, "/health", {"status": "ok"}),
            ("agent-service", config.agent_service_url, "/ready", {"status": "ready"}),
        ]

    for name, base, path, expected in checks:
        try:
            resp = client.probe(base, path)
        except httpx.HTTPError as exc:
            pytest.exit(
                f"[agent-service env] {name} {path} unreachable at {base}: {exc}. "
                "Is the local AgentStudio deployment running?",
                returncode=2,
            )

        if resp.status_code != 200:
            pytest.exit(
                f"[agent-service env] {name} {path} returned HTTP "
                f"{resp.status_code} (expected 200): {resp.text[:300]}",
                returncode=2,
            )

        try:
            body = resp.json()
        except ValueError:
            pytest.exit(
                f"[agent-service env] {name} {path} returned non-JSON body: "
                f"{resp.text[:300]}",
                returncode=2,
            )

        reason = _validate(body, expected)
        if reason:
            pytest.exit(
                f"[agent-service env] {name} {path} unhealthy: {reason} "
                f"(body={body})",
                returncode=2,
            )
