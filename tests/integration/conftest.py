"""Pytest fixtures for AgentStudio API integration tests."""

from __future__ import annotations

import os
import sys
from pathlib import Path

_INTEGRATION_ROOT = Path(__file__).resolve().parent
if str(_INTEGRATION_ROOT) not in sys.path:
    sys.path.insert(0, str(_INTEGRATION_ROOT))

import allure
import httpx
import pytest

from lib.common.auth import KeycloakAuth
from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.cleanup import PipelineResources, cleanup_pipeline
from lib.utils.waits import wait_for_platform_project_ready

os.environ.setdefault("NO_PROXY", "*")
os.environ.setdefault("no_proxy", "*")

REPORTS_DIR = _INTEGRATION_ROOT / "reports"


def pytest_sessionstart(session: pytest.Session) -> None:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    """Drop tests marked ``disabled`` so they are never collected or counted."""
    kept: list[pytest.Item] = []
    deselected: list[pytest.Item] = []
    for item in items:
        if item.get_closest_marker("disabled"):
            deselected.append(item)
        else:
            kept.append(item)
    if deselected:
        config.hook.pytest_deselected(items=deselected)
        items[:] = kept


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    html = REPORTS_DIR / "pytest-report.html"
    junit = REPORTS_DIR / "junit.xml"
    allure_dir = REPORTS_DIR / "allure-results"
    print("\n--- Integration test reports ---")
    print(f"  HTML:   {html}")
    print(f"  JUnit:  {junit}")
    print(f"  Allure: {allure_dir}")
    if html.is_file():
        print("  Open HTML: open reports/pytest-report.html in a browser")
    if any(allure_dir.glob("*.json")):
        print("  Open Allure: allure serve reports/allure-results")


# --- Session-scoped (suite setup) ---


@pytest.fixture(scope="session")
def integration_settings() -> IntegrationSettings:
    return IntegrationSettings.from_env()


@pytest.fixture(scope="session")
def keycloak_auth(integration_settings: IntegrationSettings) -> KeycloakAuth:
    auth = KeycloakAuth(integration_settings)
    probe = httpx.Client(
        verify=integration_settings.verify_tls, timeout=60.0, trust_env=False
    )
    try:
        auth.ensure_password_grant_allowed(probe)
    finally:
        probe.close()
    return auth


# --- Per-test HTTP client (setup + teardown) ---


@pytest.fixture
def platform_client(
    integration_settings: IntegrationSettings, keycloak_auth: KeycloakAuth
) -> PlatformClient:
    client = PlatformClient(integration_settings, keycloak_auth)
    yield client
    client.close()


@pytest.fixture
def config_api(platform_client: PlatformClient) -> PlatformClient:
    """Alias for platform_client."""
    return platform_client


# --- Per-test resource bag + pytest teardown (addfinalizer) ---


@pytest.fixture
def e2e_resources(
    platform_client: PlatformClient,
    integration_settings: IntegrationSettings,
    request: pytest.FixtureRequest,
) -> PipelineResources:
    """
    Empty resource tracker for one test.

    Registers teardown via request.addfinalizer (runs after the test, pass or fail).
    """
    resources = PipelineResources()

    def _teardown() -> None:
        if resources.project_id:
            summary = (
                f"project={resources.project_id} "
                f"credential={resources.credential_id} "
                f"datasource={resources.datasource_id} "
                f"dataset={resources.dataset_id} "
                f"kb={resources.knowledge_base_id} "
                f"mcp={resources.mcp_server_id}"
            )
            allure.dynamic.description(summary)
            if not integration_settings.integration_cleanup:
                print(
                    f"\n[integration] resources left in place (INTEGRATION_CLEANUP=0): {summary}"
                )
        step = (
            "Teardown: skip delete (INTEGRATION_CLEANUP=0)"
            if not integration_settings.integration_cleanup
            else "Teardown: delete KB, dataset, connector, project"
        )
        with allure.step(step):
            cleanup_pipeline(platform_client, integration_settings, resources)

    request.addfinalizer(_teardown)
    return resources


@pytest.fixture
def created_project(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
) -> PipelineResources:
    """Setup: create project. Teardown: e2e_resources finalizer deletes everything."""
    project_name = unique_name("e2e-pytest")
    response = platform_client.config_post(
        "api/v1/projects",
        {"name": project_name, "metadata": {"source": "pytest-integration"}},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    e2e_resources.project_id = body["id"]
    e2e_resources.project_home_dir = body.get("home_dir")
    # `POST /projects` returns 201 immediately, but project-init runs async and
    # registers the per-project Keycloak resource + admin policy. Until that
    # lands, the gateway's UMA-RPT swap can't mint a project-scoped token and
    # fails closed with 502. Gate on models + service-account readiness so every
    # suite that creates a project via this fixture never races project-init.
    wait_for_platform_project_ready(
        platform_client,
        body["id"],
        timeout_sec=int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300"),
    )
    return e2e_resources

