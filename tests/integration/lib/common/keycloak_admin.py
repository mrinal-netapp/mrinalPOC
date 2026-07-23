"""Keycloak Admin REST helper for provisioning realm users in integration tests.

The role tests need two real realm users that can log in via the password grant.
The add-member workflow only resolve-or-creates a user WITHOUT a password, so we
create users here with a non-temporary password (and no required actions) so the
Direct Access Grant works immediately.

Auth reuses the master-realm admin credentials already in IntegrationSettings
(the same admin/admin-cli pattern as lib/common/auth.py).
"""

from __future__ import annotations

import time

import httpx

from .settings import IntegrationSettings


class KeycloakAdmin:
    def __init__(self, settings: IntegrationSettings) -> None:
        self._settings = settings
        token_url = settings.keycloak_token_url
        # token_url = https://<host>/realms/<realm>/protocol/openid-connect/token
        self._realm_base = token_url.split("/realms/")[0]
        self._realm = token_url.split("/realms/")[1].split("/")[0]
        self._http = httpx.Client(
            verify=settings.verify_tls, timeout=60.0, trust_env=False
        )
        self._admin_token: str | None = None
        self._token_exp: float = 0.0

    def close(self) -> None:
        self._http.close()

    def _token(self) -> str:
        # Refresh when missing or (near) expired. These flows can run longer than
        # the admin token TTL (project-init + Temporal workflows), so a cached
        # token would otherwise 401 on teardown and leak users.
        if self._admin_token is None or time.monotonic() >= self._token_exp:
            resp = self._http.post(
                f"{self._realm_base}/realms/master/protocol/openid-connect/token",
                data={
                    "grant_type": "password",
                    "client_id": "admin-cli",
                    "username": "admin",
                    "password": self._settings.keycloak_admin_password,
                },
            )
            resp.raise_for_status()
            payload = resp.json()
            self._admin_token = payload["access_token"]
            expires_in = int(payload.get("expires_in", 60))
            self._token_exp = time.monotonic() + max(expires_in - 30, 10)
        return self._admin_token

    def can_authenticate(self) -> bool:
        """True when a master-realm admin token can be obtained.

        Suites that provision realm users call this to self-skip (rather than
        hard-error) in environments where admin access isn't wired — e.g. a
        managed Keycloak that disables the master `admin`/`admin-cli` password
        grant, or missing/incorrect admin creds. On success the token is cached,
        so the caller's first admin request reuses it.

        Only 4xx (grant disabled / bad-or-missing creds) and network failures are
        treated as "admin unavailable". A 5xx is a real Keycloak/server outage and
        is re-raised so it surfaces as an error instead of silently skipping.
        """
        try:
            self._token()
            return True
        except httpx.HTTPStatusError as exc:
            if 400 <= exc.response.status_code < 500:
                return False
            raise
        except httpx.RequestError:
            return False

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token()}", "Content-Type": "application/json"}

    def get_user_id(self, email: str) -> str | None:
        resp = self._http.get(
            f"{self._realm_base}/admin/realms/{self._realm}/users",
            params={"email": email, "exact": "true"},
            headers=self._headers(),
        )
        resp.raise_for_status()
        users = resp.json()
        return users[0]["id"] if users else None

    def create_user(self, email: str, password: str) -> str:
        """Create an enabled realm user with a non-temporary password. Idempotent.

        Returns the user id. If the user already exists, resets its password so
        the caller can log in deterministically.
        """
        resp = self._http.post(
            f"{self._realm_base}/admin/realms/{self._realm}/users",
            headers=self._headers(),
            json={
                "username": email,
                "email": email,
                "enabled": True,
                "emailVerified": True,
                "requiredActions": [],
                "credentials": [
                    {"type": "password", "value": password, "temporary": False}
                ],
            },
        )
        if resp.status_code == 409:
            # Already exists (e.g. a prior add-member created it password-less).
            user_id = self.get_user_id(email)
            assert user_id, f"user {email} reported 409 but not found"
            self.reset_password(user_id, password)
            return user_id
        resp.raise_for_status()
        user_id = self.get_user_id(email)
        assert user_id, f"created user {email} but could not resolve its id"
        return user_id

    def reset_password(self, user_id: str, password: str) -> None:
        resp = self._http.put(
            f"{self._realm_base}/admin/realms/{self._realm}/users/{user_id}/reset-password",
            headers=self._headers(),
            json={"type": "password", "value": password, "temporary": False},
        )
        resp.raise_for_status()

    def delete_user(self, user_id: str) -> None:
        resp = self._http.delete(
            f"{self._realm_base}/admin/realms/{self._realm}/users/{user_id}",
            headers=self._headers(),
        )
        # 404 is fine (already gone).
        if resp.status_code not in (204, 404):
            resp.raise_for_status()
