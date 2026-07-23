"""
Project role enforcement — two real Keycloak users (admin + member/viewer).

Asserts ONLY what the platform actually enforces today:
  - Membership writes (add/remove/change-role) require the caller to be a
    project admin; member/viewer/non-admin -> 403; unauthenticated -> 401.
    (workflow-engine requireProjectAdmin.)

And DOCUMENTS the current (non-)enforcement in config-service:
  - config-service does NOT gate resource access by project role today, so a
    member/viewer can still read AND write project resources (200/201). These
    assertions capture today's behavior, not the desired end state.
"""

from __future__ import annotations

import os

import allure
import httpx
import pytest

from lib.common.platform_client import PlatformClient, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.waits import wait_for_workflow_terminal

pytestmark = [
    pytest.mark.projects,
    pytest.mark.members,
    allure.feature("Project role enforcement"),
]


def _member_workflow_timeout() -> int:
    return int(os.environ.get("MEMBER_WORKFLOW_TIMEOUT_SEC") or "180")


def _wait_member_workflow(client: PlatformClient, resp, action: str) -> None:
    assert resp.status_code == 202, f"{action}: expected 202, got {resp.status_code}: {resp.text}"
    workflow_id = resp.json().get("workflowId")
    assert workflow_id, f"{action}: missing workflowId: {resp.text}"
    wait_for_workflow_terminal(
        lambda: client.workflow_get(f"api/v1/workflows/{workflow_id}/status"),
        timeout_sec=_member_workflow_timeout(),
        poll_interval_sec=3,
    )


def _members(client: PlatformClient, project_id: str) -> list[dict]:
    resp = client.list_members(project_id)
    assert resp.status_code == 200, resp.text
    return resp.json().get("members") or []


def _role_of(members: list[dict], email: str) -> str | None:
    for m in members:
        if (m.get("email") or "").lower() == email.lower():
            return m.get("role")
    return None


@allure.title("Roles: admin manages members; member/viewer denied admin ops; resource access documented")
def test_project_role_enforcement(
    two_user_project,
    integration_settings: IntegrationSettings,
) -> None:
    ctx = two_user_project
    admin = ctx.admin_client
    member = ctx.member_client
    project_id = ctx.project_id

    with allure.step("Creator is admin in the caller-scoped project list"):
        listing = admin.config_get("api/v1/projects")
        assert listing.status_code == 200, listing.text
        proj = next(
            (p for p in listing.json().get("projects", []) if p.get("id") == project_id), None
        )
        assert proj is not None, "admin's project not in their project list"
        assert proj.get("role") == "admin", proj

    with allure.step("Admin adds the second user as member"):
        _wait_member_workflow(
            admin, admin.add_member(project_id, ctx.member_email, "member"), "add member"
        )
        assert _role_of(_members(admin, project_id), ctx.member_email) == "member"

    with allure.step("Member is denied all admin (membership-write) operations -> 403"):
        r_add = member.add_member(project_id, "someone-else@example.com", "viewer")
        assert r_add.status_code == 403, f"member add: {r_add.status_code} {r_add.text}"
        assert "admin scope required" in r_add.text.lower(), r_add.text
        r_role = member.change_member_role(project_id, ctx.member_email, "admin")
        assert r_role.status_code == 403, f"member change-role: {r_role.status_code} {r_role.text}"
        r_rm = member.remove_member(project_id, ctx.member_email)
        assert r_rm.status_code == 403, f"member remove: {r_rm.status_code} {r_rm.text}"

    with allure.step("Admin changes the member to viewer"):
        _wait_member_workflow(
            admin, admin.change_member_role(project_id, ctx.member_email, "viewer"), "change role"
        )
        assert _role_of(_members(admin, project_id), ctx.member_email) == "viewer"

    with allure.step("Viewer is also denied admin (membership-write) operations -> 403"):
        r = member.add_member(project_id, "another@example.com", "viewer")
        assert r.status_code == 403, f"viewer add: {r.status_code} {r.text}"

    with allure.step("Unauthenticated request -> 401"):
        with httpx.Client(verify=integration_settings.verify_tls, trust_env=False, timeout=30.0) as raw:
            unauth = raw.get(f"{integration_settings.api_base_url}/api/v1/projects")
        assert unauth.status_code == 401, f"expected 401, got {unauth.status_code}: {unauth.text[:200]}"

    # --- Documented current behavior: config-service is NOT role-gated today ---
    # A viewer can still READ and WRITE project resources. These assertions
    # capture the present (missing) enforcement so a future guard layer that
    # denies viewers will flip them intentionally.
    with allure.step("Documented: viewer can READ project resources (200)"):
        assert member.config_get(ctx.prefix()).status_code == 200
        assert member.config_get(f"{ctx.prefix()}/models").status_code == 200
        assert member.config_get(f"{ctx.prefix()}/knowledgebases").status_code == 200

    with allure.step("Documented: viewer can WRITE a project resource (201) — not role-gated"):
        cred = member.config_post(
            f"{ctx.prefix()}/credentials",
            {
                "name": unique_name("e2e-viewer-cred"),
                "description": "documents that viewer writes are not blocked today",
                "provider": "s3",
                "secretData": {"access_key_id": "dummy", "secret_access_key": "dummy"},
            },
        )
        assert cred.status_code == 201, (
            f"expected viewer credential-create to currently succeed (no role gate): "
            f"{cred.status_code} {cred.text}"
        )
