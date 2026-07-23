"""Bootstrap Keycloak UMA resources when project-init workflow is slow or blocked."""

from __future__ import annotations

import base64
import json
from typing import Any
from urllib.parse import quote

import httpx

from .settings import IntegrationSettings

_AUTHZ_CLIENT_ID = "agent-studio-api"


def jwt_sub(access_token: str) -> str:
    """Return the Keycloak ``sub`` claim without verifying the JWT (test helper)."""
    segment = access_token.split(".")[1]
    segment += "=" * (-len(segment) % 4)
    payload = json.loads(base64.urlsafe_b64decode(segment))
    sub = payload.get("sub")
    if not sub:
        raise ValueError("access token missing sub claim")
    return str(sub)


def _realm_admin_base(settings: IntegrationSettings) -> str:
    return settings.keycloak_token_url.replace(
        "/realms/nemo/protocol/openid-connect/token", ""
    )


def _master_token(client: httpx.Client, settings: IntegrationSettings) -> str:
    master_url = settings.keycloak_token_url.replace(
        "/realms/nemo/protocol/openid-connect/token",
        "/realms/master/protocol/openid-connect/token",
    )
    resp = client.post(
        master_url,
        data={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": "admin",
            "password": settings.keycloak_admin_password,
        },
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def _resource_server_uuid(
    client: httpx.Client, settings: IntegrationSettings, admin_token: str
) -> str:
    realm_base = _realm_admin_base(settings)
    resp = client.get(
        f"{realm_base}/admin/realms/nemo/clients",
        params={"clientId": _AUTHZ_CLIENT_ID},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    resp.raise_for_status()
    clients = resp.json()
    if not clients:
        raise RuntimeError(f"Keycloak client {_AUTHZ_CLIENT_ID!r} not found in nemo realm")
    return clients[0]["id"]


def _authz_base(settings: IntegrationSettings, resource_server_uuid: str) -> str:
    return (
        f"{_realm_admin_base(settings)}/admin/realms/nemo/clients/"
        f"{resource_server_uuid}/authz/resource-server"
    )


def _post_idempotent(
    client: httpx.Client,
    url: str,
    admin_token: str,
    body: dict[str, Any],
    *,
    lookup_url: str | None = None,
    id_key: str = "id",
) -> str:
    headers = {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}
    resp = client.post(url, headers=headers, json=body)
    if resp.status_code in (200, 201):
        if resp.text.strip():
            data = resp.json()
            found = data.get(id_key) or data.get("_id")
            if found:
                return str(found)
        if lookup_url:
            got = client.get(lookup_url, headers={"Authorization": f"Bearer {admin_token}"})
            got.raise_for_status()
            rows = got.json()
            if isinstance(rows, list):
                for row in rows:
                    if row.get("name") == body.get("name"):
                        return str(row.get(id_key) or row.get("_id"))
        return ""
    if resp.status_code == 409 and lookup_url:
        got = client.get(lookup_url, headers={"Authorization": f"Bearer {admin_token}"})
        got.raise_for_status()
        for row in got.json():
            if row.get("name") == body.get("name"):
                return str(row.get(id_key) or row.get("_id"))
    raise RuntimeError(f"Keycloak authz POST {url} failed: {resp.status_code} {resp.text[:300]}")


def ensure_project_keycloak_authz(
    settings: IntegrationSettings,
    *,
    project_id: str,
    owner_user_id: str,
    http: httpx.Client | None = None,
) -> None:
    """
    Register ``project:{project_id}`` and grant the owner admin scope.

    Mirrors workflow-engine ``RegisterProjectResourceActivity`` +
    ``GrantInitialAdminActivity`` so project-scoped APIs work even when
    project-init is blocked (e.g. lakekeeper scaled to zero on a constrained
    local cluster).
    """
    owns_client = http is None
    client = http or httpx.Client(verify=settings.verify_tls, timeout=60.0, trust_env=False)
    try:
        admin_token = _master_token(client, settings)
        rs_uuid = _resource_server_uuid(client, settings, admin_token)
        base = _authz_base(settings, rs_uuid)
        resource_name = f"project:{project_id}"

        _post_idempotent(
            client,
            f"{base}/resource",
            admin_token,
            {
                "name": resource_name,
                "type": "urn:agent-studio:resource-types:project",
                "uris": [f"/projects/{project_id}"],
                "scopes": [{"name": "admin"}, {"name": "member"}, {"name": "viewer"}],
                "ownerManagedAccess": False,
            },
            lookup_url=f"{base}/resource?name={quote(resource_name)}&exactName=true",
            id_key="_id",
        )

        policy_name = f"usr-{owner_user_id}-proj-{project_id}-admin"
        _post_idempotent(
            client,
            f"{base}/policy/user",
            admin_token,
            {
                "name": policy_name,
                "logic": "POSITIVE",
                "decisionStrategy": "UNANIMOUS",
                "users": [owner_user_id],
            },
            lookup_url=f"{base}/policy?name={quote(policy_name)}",
        )

        perm_name = f"perm-proj-{project_id}-admin"
        _post_idempotent(
            client,
            f"{base}/permission/scope",
            admin_token,
            {
                "name": perm_name,
                "logic": "POSITIVE",
                "decisionStrategy": "AFFIRMATIVE",
                "resources": [resource_name],
                "scopes": ["admin"],
                "policies": [policy_name],
            },
            lookup_url=f"{base}/permission?name={quote(perm_name)}",
        )
    finally:
        if owns_client:
            client.close()
