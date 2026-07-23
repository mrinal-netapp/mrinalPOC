"""Shared fixtures for the evals E2E suites.

Scope: only tests under ``suites/evals/``. The session-scoped
``integration_settings`` fixture comes from the repo-root ``conftest.py``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from lib.agent_service.client import AgentServiceClient
from lib.agent_service.env import AgentServiceConfig, load_env
from lib.agent_service.health import probe_services
from lib.common.logger import (
    configure_logging,
    copy_run_artifacts,
    log,
    log_banner,
    run_footer_lines,
)
from lib.common.settings import IntegrationSettings

_suite_headers_printed: set[str] = set()


def pytest_configure(config: pytest.Config) -> None:
    """Configure the shared logger once per session (before collection)."""
    ctx = configure_logging()
    config._evals_log_ctx = ctx  # type: ignore[attr-defined]
    if ctx.enabled and ctx.log_file is not None:
        log.info(f"RUN: {ctx.log_file.stem} -> {ctx.log_file}")
        allure_dir = getattr(config.option, "alluredir", None)
        if allure_dir:
            shutil.rmtree(Path(allure_dir), ignore_errors=True)


@pytest.fixture(scope="session")
def agent_service_config() -> AgentServiceConfig:
    """Load config from ``.env.local``; skip the suite if unset."""
    config = load_env()
    if not config.is_configured():
        pytest.skip(
            "Evals suite skipped — set "
            f"{', '.join(config.missing_keys())} in tests/integration/.env.local"
        )
    return config


@pytest.fixture(scope="session", autouse=True)
def evals_health_gate(
    agent_service_config: AgentServiceConfig,
    integration_settings: IntegrationSettings,
) -> None:
    """Before-class gate: probe config-service + agent-service health/readiness."""
    client = AgentServiceClient(agent_service_config, integration_settings)
    try:
        probe_services(client, agent_service_config)
    finally:
        client.close()


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Emit suite banner (once) and test sub-header before each test."""
    marker = "evals/"
    if marker in item.nodeid:
        rest = item.nodeid.split(marker, 1)[1]
        suite = rest.split("/", 1)[0]
        if (
            suite
            and not suite.endswith(".py")
            and suite not in _suite_headers_printed
        ):
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
    """Print a bold-green footer pointing the user to the per-run log file."""
    ctx = getattr(config, "_evals_log_ctx", None)
    if ctx is None:
        return
    lines = run_footer_lines(ctx)
    if not lines:
        return
    terminalreporter.write_sep("=", "evals run log", green=True, bold=True)
    for line in lines:
        terminalreporter.write_line(line, green=True, bold=True)


def pytest_unconfigure(config: pytest.Config) -> None:
    """Copy the run reports (HTML/JUnit/Allure) into the per-run work dir."""
    ctx = getattr(config, "_evals_log_ctx", None)
    if ctx is None:
        return
    paths = [
        getattr(config.option, "htmlpath", None),
        getattr(config.option, "xmlpath", None),
        getattr(config.option, "alluredir", None),
    ]
    copy_run_artifacts(ctx, paths)
