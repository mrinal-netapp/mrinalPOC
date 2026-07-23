"""
Project lifecycle happy path — mirrors the agent-studio-ui /projects flow:
create -> get -> list (caller-scoped, with role) -> rename -> dashboard metrics
-> delete (via the e2e_resources teardown).

Endpoints: config-service routes/projectRoutes.ts. No external config required,
so this doubles as the `smoke` suite.
"""

from __future__ import annotations

import os
import time

import allure
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_project_ready

pytestmark = [
    pytest.mark.projects,
    pytest.mark.smoke,
    allure.feature("Project lifecycle"),
]


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


def _find_project(body: dict | list, project_id: str) -> dict | None:
    projects = body.get("projects") if isinstance(body, dict) else body
    for project in projects or []:
        if project.get("id") == project_id:
            return project
    return None


@allure.title("Project lifecycle: create -> get -> list-with-role -> rename -> metrics -> delete")
def test_project_lifecycle(
    e2e_resources: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    # 1. Create.
    project_name = unique_name("e2e-project")
    with allure.step("Create project"):
        resp = platform_client.config_post(
            "api/v1/projects",
            {"name": project_name, "metadata": {"source": "pytest-integration"}},
        )
        assert resp.status_code == 201, resp.text
        created = resp.json()
        e2e_resources.project_id = created["id"]
        e2e_resources.project_home_dir = created.get("home_dir")
        assert created["name"] == project_name
    project_id = e2e_resources.project_id

    # 2. Wait for async project-init BEFORE any project-scoped call. project-init
    # registers the per-project Keycloak resource + admin policy; until it lands
    # the gateway's UMA-RPT swap fails closed with 502 on every /projects/:id/*
    # request. Gating first turns that race into a deterministic wait.
    with allure.step("Wait for project-init (built-in models seeded)"):
        wait_for_project_ready(
            lambda: platform_client.config_get(f"api/v1/projects/{project_id}/models"),
            timeout_sec=_project_ready_timeout(),
        )

    # 3. Get.
    with allure.step("Get project by id"):
        get_resp = platform_client.config_get(f"api/v1/projects/{project_id}")
        assert get_resp.status_code == 200, get_resp.text
        assert get_resp.json()["name"] == project_name

    with allure.step("List projects; created project present with role=admin"):
        # The creator's admin policy is granted during project-init; retry briefly
        # in case the models seed lands just before the authz grant.
        member_project = None
        for _ in range(12):
            list_resp = platform_client.config_get("api/v1/projects")
            assert list_resp.status_code == 200, list_resp.text
            member_project = _find_project(list_resp.json(), project_id)
            if member_project and member_project.get("role") == "admin":
                break
            time.sleep(5)
        assert member_project is not None, "created project not in caller's project list"
        assert member_project.get("role") == "admin", member_project

    # 4. Rename.
    new_name = f"{project_name}-renamed"
    with allure.step("Rename project"):
        put_resp = platform_client.config_put(
            f"api/v1/projects/{project_id}", {"name": new_name}
        )
        assert put_resp.status_code == 200, put_resp.text
        assert put_resp.json()["name"] == new_name

    # 5. Dashboard metrics (the /projects overview call the UI issues).
    with allure.step("Get overview dataset metrics"):
        metrics_resp = platform_client.config_get(
            f"api/v1/projects/{project_id}/overview-dataset-metrics"
        )
        assert metrics_resp.status_code == 200, metrics_resp.text
        metrics = metrics_resp.json()
        assert isinstance(metrics, dict), metrics
        # Fresh project has no datasets.
        assert metrics.get("datasetsTotal", 0) == 0, metrics

    # 6. Delete is asserted implicitly by the e2e_resources teardown.
