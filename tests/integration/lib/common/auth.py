"""Obtain Keycloak access tokens for integration tests (password + refresh grants)."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx

from .settings import IntegrationSettings

@dataclass
class TokenBundle:
    access_token: str
    refresh_token: str | None
    expires_at: float

    def is_expiring_soon(self, skew_sec: int = 60) -> bool:
        return time.time() >= (self.expires_at - skew_sec)


class KeycloakAuth:
    def __init__(
        self,
        settings: IntegrationSettings,
        username: str | None = None,
        password: str | None = None,
    ) -> None:
        self._settings = settings
        # Per-identity override (defaults to the configured KEYCLOAK_USERNAME).
        # Lets tests act as additional realm users (e.g. the role suite's two users).
        self._username = username or settings.keycloak_username
        self._password = password or settings.keycloak_password
        self._bundle: TokenBundle | None = None

    def get_access_token(self, client: httpx.Client) -> str:
        if self._bundle is None or self._bundle.is_expiring_soon():
            self._bundle = self._fetch_token(client, grant_type="password")
        return self._bundle.access_token

    def refresh_if_needed(self, client: httpx.Client) -> None:
        if self._bundle is None:
            self._bundle = self._fetch_token(client, grant_type="password")
            return
        if not self._bundle.is_expiring_soon():
            return
        if self._bundle.refresh_token:
            try:
                self._bundle = self._fetch_token(
                    client,
                    grant_type="refresh_token",
                    refresh_token=self._bundle.refresh_token,
                )
                return
            except httpx.HTTPStatusError:
                pass
        self._bundle = self._fetch_token(client, grant_type="password")

    def ensure_password_grant_allowed(self, client: httpx.Client) -> None:
        if not self._settings.enable_password_grant:
            return
        admin_token = self._admin_token(client)
        realm_base = self._settings.keycloak_token_url.replace(
            "/realms/nemo/protocol/openid-connect/token", ""
        )
        list_url = (
            f"{realm_base}/admin/realms/nemo/clients"
            f"?clientId={self._settings.keycloak_password_grant_client_id}"
        )
        listed = client.get(
            list_url, headers={"Authorization": f"Bearer {admin_token}"}
        )
        listed.raise_for_status()
        clients = listed.json()
        if not clients:
            raise RuntimeError(
                f"Keycloak client {self._settings.keycloak_password_grant_client_id!r} not found in nemo realm"
            )
        client_uuid = clients[0]["id"]
        get_url = f"{realm_base}/admin/realms/nemo/clients/{client_uuid}"
        resp = client.get(get_url, headers={"Authorization": f"Bearer {admin_token}"})
        resp.raise_for_status()
        body = resp.json()
        if body.get("directAccessGrantsEnabled"):
            return
        body["directAccessGrantsEnabled"] = True
        put_resp = client.put(
            get_url,
            headers={"Authorization": f"Bearer {admin_token}"},
            json=body,
        )
        put_resp.raise_for_status()

    def _admin_token(self, client: httpx.Client) -> str:
        master_url = self._settings.keycloak_token_url.replace(
            "/realms/nemo/protocol/openid-connect/token",
            "/realms/master/protocol/openid-connect/token",
        )
        resp = client.post(
            master_url,
            data={
                "grant_type": "password",
                "client_id": "admin-cli",
                "username": "admin",
                "password": self._settings.keycloak_admin_password,
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]

    def _fetch_token(
        self,
        client: httpx.Client,
        *,
        grant_type: str,
        refresh_token: str | None = None,
    ) -> TokenBundle:
        data: dict[str, str] = {
            "client_id": self._settings.keycloak_password_grant_client_id
        }
        if grant_type == "password":
            data.update(
                {
                    "grant_type": "password",
                    "username": self._username,
                    "password": self._password,
                }
            )
        elif grant_type == "refresh_token" and refresh_token:
            data.update(
                {
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                }
            )
        else:
            raise ValueError(f"Unsupported grant_type={grant_type}")

        resp = client.post(self._settings.keycloak_token_url, data=data)
        if resp.status_code in (400, 401) and grant_type == "password":
            detail = resp.text
            if "direct access grants" in detail.lower() or "unauthorized_client" in detail:
                raise RuntimeError(
                    "Keycloak rejected password grant. Set KEYCLOAK_ENABLE_PASSWORD_GRANT=1 "
                    "in .env.local (local dev only) or enable Direct access grants on "
                    "agentstudio-gui in the nemo realm."
                ) from None
        if 400 <= resp.status_code < 500:
            # Surface Keycloak's error body on every 4xx (not just 401) so
            # misconfigured client/user/grant failures are diagnosable.
            try:
                payload = resp.json() if resp.text else {}
            except ValueError:
                payload = {}
            error = payload.get("error", "unknown_error")
            description = payload.get("error_description", resp.text)
            raise RuntimeError(
                f"Keycloak {grant_type} grant failed (HTTP {resp.status_code}) "
                f"for client {self._settings.keycloak_password_grant_client_id!r}: "
                f"{error} — {description}"
            ) from None
            if "invalid_grant" in detail.lower() or "invalid user credentials" in detail.lower():
                raise RuntimeError(
                    f"Keycloak rejected login for user {self._settings.keycloak_username!r} "
                    f"(client {self._settings.keycloak_client_id!r}): check KEYCLOAK_USERNAME "
                    "and KEYCLOAK_PASSWORD in .env.local."
                ) from None
        resp.raise_for_status()
        payload: dict[str, Any] = resp.json()
        expires_in = int(payload.get("expires_in", 300))
        return TokenBundle(
            access_token=payload["access_token"],
            refresh_token=payload.get("refresh_token"),
            expires_at=time.time() + expires_in,
        )
