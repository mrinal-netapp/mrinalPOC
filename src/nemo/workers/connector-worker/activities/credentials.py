"""Credential resolution via config-service secret-data endpoint."""
from observability_client_runtime import get_logger
import os
import time
from typing import Dict, Optional

import requests

logger = get_logger()

_token_cache: Dict[str, any] = {"token": None, "expires_at": 0}


def _get_service_account_token() -> Optional[str]:
    client_id = os.environ.get("KEYCLOAK_CLIENT_ID")
    client_secret = os.environ.get("KEYCLOAK_CLIENT_SECRET")
    token_url = os.environ.get("KEYCLOAK_TOKEN_URL")

    if not all([client_id, client_secret, token_url]):
        logger.warning("Keycloak client credentials not configured; calling secret-data without auth")
        return None

    now = time.time()
    if _token_cache["token"] and _token_cache["expires_at"] > now + 30:
        return _token_cache["token"]

    resp = requests.post(
        token_url,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=15,
    )
    if resp.status_code == 401:
        # Most common cause: the connector-worker Keycloak client wasn't created
        # by the keycloak-setup hook, or its secret in `keycloak-oidc-secrets`
        # is still the placeholder ("changeme-..."). Surface a hint instead of
        # a bare HTTPError stack so the operator knows what to fix.
        body_excerpt = (resp.text or "")[:300]
        secret_is_placeholder = bool(client_secret) and client_secret.startswith("changeme-")
        hint = (
            "connector-worker Keycloak client_secret is still the placeholder "
            "(changeme-*); re-run the keycloak-setup hook (helm upgrade) and "
            "restart the connector-worker pod"
            if secret_is_placeholder
            else (
                f"Keycloak rejected client_credentials grant for client_id="
                f"{client_id!r}; verify the client exists in realm and that its "
                f"secret in `keycloak-oidc-secrets` matches Keycloak's value"
            )
        )
        raise RuntimeError(f"Keycloak token request failed (401): {hint}. Response: {body_excerpt}")
    resp.raise_for_status()
    data = resp.json()
    _token_cache["token"] = data["access_token"]
    _token_cache["expires_at"] = now + data.get("expires_in", 300)
    return _token_cache["token"]


def resolve_credential(config_service_url: str, project_id: str, credential_id: str) -> Dict[str, str]:
    base = (config_service_url or "").strip()
    # Reject path-only or invalid base: we need a full base URL (scheme + host)
    if not base or base.startswith("/") or ("://" not in base):
        base = os.environ.get("CONFIG_SERVICE_URL") or "http://config-service:3000"
        base = (base or "").strip() or "http://config-service:3000"
    if not base.startswith("http://") and not base.startswith("https://"):
        base = f"http://{base}"
    url = f"{base.rstrip('/')}/api/v1/projects/{project_id}/credentials/{credential_id}/secret-data"
    logger.debug("resolve_credential url=%s", url.split("?", 1)[0])
    headers = {"Content-Type": "application/json"}
    token = _get_service_account_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    resp = requests.post(url, headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()
