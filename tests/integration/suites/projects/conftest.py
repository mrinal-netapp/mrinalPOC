"""Fixtures for the projects suite — notably the two-user role scenario.

`two_user_project` provisions two throwaway realm users (admin + member) via the
Keycloak Admin API, has the admin create a project (so the admin holds the
project-admin role), and tears everything down (project + both users) afterwards.
"""

from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass

import pytest

from lib.common.auth import KeycloakAuth
from lib.common.keycloak_admin import KeycloakAdmin
from lib.common.platform_client import PlatformClient, make_user_client, unique_name
from lib.common.settings import IntegrationSettings
from lib.utils.waits import wait_for_project_ready


def _project_ready_timeout() -> int:
    return int(os.environ.get("PROJECT_READY_TIMEOUT_SEC") or "300")


def _role_password() -> str:
    # Prefer an explicit override; otherwise generate a random per-run password so
    # the throwaway role-test users never share a predictable/known credential in a
    # shared realm. The complexity prefix satisfies typical Keycloak policies.
    override = (os.environ.get("ROLE_TEST_PASSWORD") or "").strip()
    return override or ("Aa1!" + secrets.token_urlsafe(24))


@dataclass
class RolesContext:
    project_id: str
    admin_email: str
    member_email: str
    admin_client: PlatformClient
    member_client: PlatformClient

    def prefix(self) -> str:
        return f"api/v1/projects/{self.project_id}"


@pytest.fixture
def two_user_project(
    integration_settings: IntegrationSettings,
    keycloak_auth: KeycloakAuth,  # ensures direct-access-grants enabled on the client
) -> RolesContext:
    settings = integration_settings
    kc = KeycloakAdmin(settings)
    # Self-skip (rather than hard-error the gate) when a master-realm admin token
    # can't be obtained: a managed Keycloak that disables the master admin/admin-cli
    # password grant (dev-AKS returns 400), or a missing/incorrect admin password.
    # `keycloak_admin_password` has a non-empty default, so can_authenticate() (which
    # actually attempts the grant) is the real signal here. Without admin we can't
    # provision the two throwaway realm users this suite needs.
    if not kc.can_authenticate():
        kc.close()
        pytest.skip(
            "roles suite skipped — Keycloak master-realm admin token unavailable "
            "(enable the master admin/admin-cli password grant and set a correct "
            "KEYCLOAK_ADMIN_PASSWORD to run the two-user role scenario)"
        )
    password = _role_password()

    admin_email = f"{unique_name('e2e-role-admin')}@example.com"
    member_email = f"{unique_name('e2e-role-member')}@example.com"

    admin_uid = kc.create_user(admin_email, password)
    member_uid = kc.create_user(member_email, password)

    admin_client = make_user_client(settings, admin_email, password)
    member_client = make_user_client(settings, member_email, password)

    # Admin creates the project -> project-init grants the creator the admin role.
    resp = admin_client.config_post(
        "api/v1/projects",
        {"name": unique_name("e2e-roles"), "metadata": {"source": "pytest-roles"}},
    )
    assert resp.status_code == 201, resp.text
    project_id = resp.json()["id"]

    wait_for_project_ready(
        lambda: admin_client.config_get(f"api/v1/projects/{project_id}/models"),
        timeout_sec=_project_ready_timeout(),
    )

    ctx = RolesContext(
        project_id=project_id,
        admin_email=admin_email,
        member_email=member_email,
        admin_client=admin_client,
        member_client=member_client,
    )
    try:
        yield ctx
    finally:
        if settings.integration_cleanup:
            try:
                admin_client.config_delete(f"api/v1/projects/{project_id}")
            except Exception as exc:  # log so leaks are visible in shared envs
                print(
                    f"[roles-teardown] project {project_id} delete failed: {exc}",
                    file=sys.stderr,
                )
            for uid in (admin_uid, member_uid):
                try:
                    kc.delete_user(uid)
                except Exception as exc:
                    print(
                        f"[roles-teardown] keycloak user {uid} delete failed: {exc}",
                        file=sys.stderr,
                    )
        admin_client.close()
        member_client.close()
        kc.close()
