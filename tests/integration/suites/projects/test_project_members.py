"""
User-management (project membership) happy path — mirrors the agent-studio-ui
project Access/members section: list -> add -> change role -> remove, all by
email.

Reads go to config-service (GET .../members); writes are async Temporal
workflows in workflow-engine (POST/DELETE .../members, PUT .../members/role)
returning 202 + workflowId. Roles are admin | member | viewer (no "owner").

Requires MEMBER_TEST_EMAIL in .env.local — the add path is resolve-or-create,
so it provisions a Keycloak user; the suite SKIPS when unset to avoid polluting
shared realms. The logged-in user must be project admin (granted at init).
"""

from __future__ import annotations

import os

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.utils.cleanup import PipelineResources
from lib.utils.waits import wait_for_project_ready, wait_for_workflow_terminal

pytestmark = [
    pytest.mark.members,
    pytest.mark.projects,
    allure.feature("Project user management (members)"),
]


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


def _member_workflow_timeout() -> int:
    return int(os.environ.get("MEMBER_WORKFLOW_TIMEOUT_SEC") or "180")


@pytest.fixture
def member_email() -> str:
    email = (os.environ.get("MEMBER_TEST_EMAIL") or "").strip()
    if not email:
        pytest.skip(
            "members suite skipped — set MEMBER_TEST_EMAIL in tests/integration/.env.local "
            "(add is resolve-or-create; it provisions a Keycloak user)"
        )
    return email


def _members(platform_client: PlatformClient, project_id: str) -> list[dict]:
    resp = platform_client.list_members(project_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("projectId") == project_id, body
    return body.get("members") or []


def _wait_member_workflow(
    platform_client: PlatformClient, resp, action: str
) -> None:
    assert resp.status_code == 202, f"{action}: expected 202, got {resp.status_code}: {resp.text}"
    workflow_id = resp.json().get("workflowId")
    assert workflow_id, f"{action}: response missing workflowId: {resp.text}"
    wait_for_workflow_terminal(
        lambda: platform_client.workflow_get(f"api/v1/workflows/{workflow_id}/status"),
        timeout_sec=_member_workflow_timeout(),
        poll_interval_sec=3,
    )


@allure.title("Members: list -> add (viewer) -> change role (member) -> remove")
def test_project_member_management(
    member_email: str,
    created_project: PipelineResources,
    platform_client: PlatformClient,
) -> None:
    project_id = created_project.project_id

    # Caller must be admin before member writes are authorized (403 otherwise).
    with allure.step("Wait for project-init (caller becomes admin)"):
        wait_for_project_ready(
            lambda: platform_client.config_get(f"api/v1/projects/{project_id}/models"),
            timeout_sec=_project_ready_timeout(),
        )

    with allure.step("List members: caller is present as admin"):
        baseline = _members(platform_client, project_id)
        baseline_user_ids = {m.get("userId") for m in baseline if m.get("userId")}
        admins = [m for m in baseline if m.get("role") == "admin"]
        assert admins, f"expected the creator to be an admin member: {baseline}"

    with allure.step(f"Add member {member_email} as viewer"):
        add_resp = platform_client.add_member(project_id, member_email, "viewer")
        _wait_member_workflow(platform_client, add_resp, "add member")

    with allure.step("List members: new member present as viewer"):
        after_add = _members(platform_client, project_id)
        new_members = [m for m in after_add if m.get("userId") not in baseline_user_ids]
        assert len(new_members) == 1, f"expected exactly one new member: {after_add}"
        added = new_members[0]
        assert added.get("role") == "viewer", added
        if added.get("email"):
            assert added["email"].lower() == member_email.lower(), added
        added_user_id = added.get("userId")

    with allure.step("Change member role viewer -> member"):
        change_resp = platform_client.change_member_role(project_id, member_email, "member")
        _wait_member_workflow(platform_client, change_resp, "change role")

    with allure.step("List members: role is now member"):
        after_change = _members(platform_client, project_id)
        updated = next(
            (m for m in after_change if m.get("userId") == added_user_id), None
        )
        assert updated is not None, f"member disappeared after role change: {after_change}"
        assert updated.get("role") == "member", updated

    with allure.step("Remove member"):
        remove_resp = platform_client.remove_member(project_id, member_email)
        _wait_member_workflow(platform_client, remove_resp, "remove member")

    with allure.step("List members: removed member is gone"):
        after_remove = _members(platform_client, project_id)
        remaining = {m.get("userId") for m in after_remove}
        assert added_user_id not in remaining, f"member still present after removal: {after_remove}"

    # Teardown (e2e_resources finalizer) deletes the project, dropping any
    # residual per-project Keycloak policies for the added user.
