"""Shared fixtures for the MCP tools E2E suites.

Scope: only tests under `suites/tools/`. The session-scoped
`integration_settings` fixture comes from the repo-root `conftest.py`. These
suites exercise config-service MCP endpoints directly (no agent-service
invoke), so the health gate probes config-service only.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import pytest

from lib.agent_service.env import AgentServiceConfig, load_env
from lib.common.logger import (
    configure_logging,
    copy_run_artifacts,
    log,
    log_banner,
    run_footer_lines,
)
from lib.common.settings import IntegrationSettings
from lib.config_service.client import ConfigServiceClient

_suite_headers_printed: set[str] = set()

_CONFIG_HEALTH_CHECKS: list[tuple[str, dict[str, str]]] = [
    ("/health", {"status": "healthy"}),
    ("/ready", {"status": "ready", "database": "connected"}),
]


def pytest_configure(config: pytest.Config) -> None:
    """Configure the shared logger once per session (before collection)."""
    ctx = configure_logging()
    config._tools_log_ctx = ctx  # type: ignore[attr-defined]
    if ctx.enabled and ctx.log_file is not None:
        log.info(f"RUN: {ctx.log_file.stem} -> {ctx.log_file}")
        allure_dir = getattr(config.option, "alluredir", None)
        if allure_dir:
            shutil.rmtree(Path(allure_dir), ignore_errors=True)


@pytest.fixture(scope="session")
def agent_service_config() -> AgentServiceConfig:
    """Load service config from `.env.local`; skip the suite if unset.

    The tools suites need config-service only, so the gate checks
    `CONFIG_SERVICE_URL` (not `AGENT_SERVICE_URL`).
    """
    config = load_env()
    if not config.config_service_url:
        pytest.skip(
            "Tools suite skipped — set CONFIG_SERVICE_URL in "
            "tests/integration/.env.local"
        )
    return config


@pytest.fixture(scope="session", autouse=True)
def tools_health_gate(
    agent_service_config: AgentServiceConfig,
    integration_settings: IntegrationSettings,
) -> None:
    """Before-class gate: probe config-service health/readiness once per session.

    Aborts the session (via `pytest.exit`) when config-service is unreachable
    or unhealthy, so the tools suites never run against a broken environment.
    """
    client = ConfigServiceClient(agent_service_config, integration_settings)
    base = agent_service_config.config_service_url
    try:
        for path, expected in _CONFIG_HEALTH_CHECKS:
            try:
                resp = client.probe(path)
            except Exception as exc:  # noqa: BLE001 — surface as an abort
                pytest.exit(
                    f"[tools env] config-service {path} unreachable at {base}: "
                    f"{exc}. Is the local AgentStudio deployment running?",
                    returncode=2,
                )
            if resp.status_code != 200:
                pytest.exit(
                    f"[tools env] config-service {path} returned HTTP "
                    f"{resp.status_code} (expected 200): {resp.text[:300]}",
                    returncode=2,
                )
            reason = _validate_health(resp.json(), expected)
            if reason:
                pytest.exit(
                    f"[tools env] config-service {path} unhealthy: {reason}",
                    returncode=2,
                )
    finally:
        client.close()


def _validate_health(body: dict[str, Any], expected: dict[str, str]) -> str | None:
    """Return a human-readable reason when `body` does not match `expected`."""
    for key, want in expected.items():
        got = body.get(key)
        if got != want:
            return f"expected {key}={want!r}, got {got!r}"
    return None


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Emit suite banner (once) and test sub-header before each test."""
    marker = "tools/"
    if marker in item.nodeid:
        rest = item.nodeid.split(marker, 1)[1]
        suite = rest.split("/", 1)[0]
        if suite and not suite.endswith(".py") and suite not in _suite_headers_printed:
            _suite_headers_printed.add(suite)
            log_banner(f"SUITE: {suite}", char="=", width=72)

    log_banner(f"TEST: {item.name}")


def pytest_runtest_logreport(report: pytest.TestReport) -> None:
    """Log a PASSED/FAILED status line after each test case completes."""
    is_setup_teardown_error = report.when in ("setup", "teardown") and report.failed
    if report.when == "call" or is_setup_teardown_error:
        name = report.location[2] if report.location else report.nodeid
        log.info(f"{name} {report.outcome.upper()}")


def pytest_terminal_summary(
    terminalreporter: pytest.TerminalReporter,
    exitstatus: int,
    config: pytest.Config,
) -> None:
    """Print a footer pointing the user to the per-run log file."""
    ctx = getattr(config, "_tools_log_ctx", None)
    if ctx is None:
        return
    lines = run_footer_lines(ctx)
    if not lines:
        return
    terminalreporter.write_sep("=", "tools run log", green=True, bold=True)
    for line in lines:
        terminalreporter.write_line(line, green=True, bold=True)


def pytest_unconfigure(config: pytest.Config) -> None:
    """Copy the run reports (HTML/JUnit/Allure) into the per-run work dir."""
    ctx = getattr(config, "_tools_log_ctx", None)
    if ctx is None:
        return
    paths = [
        getattr(config.option, "htmlpath", None),
        getattr(config.option, "xmlpath", None),
        getattr(config.option, "alluredir", None),
    ]
    copy_run_artifacts(ctx, paths)
