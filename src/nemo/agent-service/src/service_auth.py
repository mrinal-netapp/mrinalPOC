"""Keycloak client credentials auth for service-to-service calls.
Same pattern as job-kb-update/utils/auth.py and workflow-engine/internal/clients/auth.go."""

import asyncio
import time

import httpx
from observability_client_runtime import get_logger

logger = get_logger()


class ServiceAccountClient:
    def __init__(self, issuer: str, client_id: str, client_secret: str):
        self._issuer = issuer
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._expires_at: float = 0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        if self._token and time.time() < self._expires_at:
            return self._token

        async with self._lock:
            if self._token and time.time() < self._expires_at:
                return self._token

            token_url = f"{self._issuer}/protocol/openid-connect/token"
            logger.info("Requesting service account token from %s", token_url)
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(
                    token_url,
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self._client_id,
                        "client_secret": self._client_secret,
                        "scope": "openid profile email",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                self._token = data["access_token"]
                expires_in = data.get("expires_in", 3600)
                self._expires_at = time.time() + expires_in - 60
                logger.info("Service account token obtained, expires in %ds", expires_in)
                return self._token

    async def auth_headers(self) -> dict[str, str]:
        token = await self.get_token()
        return {"Authorization": f"Bearer {token}"}
