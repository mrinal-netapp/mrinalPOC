"""Shared model resolution logic for agent and team factories.

Resolves a model from config (modelId or modelClass) into an effective
model ID and model info dict, using caching to avoid redundant HTTP calls.
"""

from typing import Any

import httpx
from cachetools import TTLCache
from observability_client_runtime import get_logger

from .config import settings
from .service_auth import ServiceAccountClient

logger = get_logger()


class ModelResolver:
    def __init__(
        self,
        http_client: httpx.AsyncClient | None = None,
        config_service_url: str = "",
        service_auth: ServiceAccountClient | None = None,
    ):
        self._http_client = http_client
        self._config_service_url = config_service_url.rstrip("/")
        self._service_auth = service_auth

        self._model_info_cache: TTLCache = TTLCache(
            maxsize=settings.MODEL_INFO_CACHE_MAX,
            ttl=settings.MODEL_INFO_CACHE_TTL,
        )
        self._model_class_cache: TTLCache = TTLCache(
            maxsize=settings.MODEL_INFO_CACHE_MAX,
            ttl=settings.MODEL_INFO_CACHE_TTL,
        )

    async def _auth_headers(self) -> dict[str, str]:
        if self._service_auth:
            try:
                return await self._service_auth.auth_headers()
            except Exception as exc:
                logger.warning("Failed to get auth headers: %s", exc)
        return {}

    async def resolve_model_info(self, project_id: str, model_id: str) -> dict | None:
        """Fetch model metadata from config-service, with TTL cache.

        The returned dict includes both stored Model entity fields and
        provider-catalog enrichment from config-service GET /models/:id:
          - contextWindow: int | None (provider's advertised context window)
          - maxOutputTokens: int | None (per-call output cap)
          - supportsExtendedOutput: bool | None (Claude extended thinking, etc.)
        """
        if not self._http_client or not self._config_service_url:
            return None

        cache_key = f"{project_id}:{model_id}"
        cached = self._model_info_cache.get(cache_key)
        if cached is not None:
            logger.info(
                ">>> MODEL INFO CACHE HIT  | %s | cache_size=%d/%d",
                cache_key, len(self._model_info_cache),
                self._model_info_cache.maxsize,
            )
            return cached

        logger.info(
            ">>> MODEL INFO CACHE MISS | %s | fetching from config-service",
            cache_key,
        )
        try:
            auth_hdrs = await self._auth_headers()
            url = f"{self._config_service_url}/api/v1/projects/{project_id}/models/{model_id}"
            resp = await self._http_client.get(url, headers=auth_hdrs)
            if resp.status_code == 200:
                data = resp.json()
                self._model_info_cache[cache_key] = data
                logger.info(
                    ">>> MODEL INFO CACHED     | %s | displayName=%s ctxWin=%s maxOut=%s",
                    cache_key,
                    data.get("displayName") or data.get("name"),
                    data.get("contextWindow"),
                    data.get("maxOutputTokens"),
                )
                return data
        except Exception as e:
            logger.debug("Model info lookup failed for %s: %s", model_id, e)
        return None

    async def resolve_model_by_class(
        self, project_id: str, model_class: str,
    ) -> dict | None:
        """Query config-service for LLM models matching the given class.

        Returns the most recently created model (createdAt DESC ordering
        from the config-service query). Results are cached with TTL.
        """
        if not self._http_client or not self._config_service_url:
            return None

        cache_key = f"{project_id}:{model_class}"
        cached = self._model_class_cache.get(cache_key)
        if cached is not None:
            logger.info(
                ">>> MODEL CLASS CACHE HIT  | %s | model=%s",
                cache_key, cached.get("id"),
            )
            return cached

        logger.info(
            ">>> MODEL CLASS CACHE MISS | %s | fetching from config-service",
            cache_key,
        )
        try:
            auth_hdrs = await self._auth_headers()
            url = f"{self._config_service_url}/api/v1/projects/{project_id}/models"
            params: dict[str, str] = {
                "modelClass": model_class,
                "modelType": "llm",
            }
            resp = await self._http_client.get(
                url, params=params, headers=auth_hdrs,
            )
            if resp.status_code == 200:
                models = resp.json()
                if models:
                    chosen = models[0]
                    self._model_class_cache[cache_key] = chosen
                    # Also populate the per-id info cache
                    info_key = f"{project_id}:{chosen['id']}"
                    self._model_info_cache[info_key] = chosen
                    logger.info(
                        ">>> MODEL CLASS RESOLVED   | %s | model=%s name=%s",
                        cache_key, chosen.get("id"),
                        chosen.get("displayName") or chosen.get("name"),
                    )
                    return chosen
        except Exception as e:
            logger.debug(
                "Model class lookup failed for %s/%s: %s",
                project_id, model_class, e,
            )
        return None

    async def resolve_effective_model(
        self,
        project_id: str | None,
        model_id: str | None,
        model_class: str | None,
    ) -> tuple[str, dict | None]:
        """Resolve the effective model ID and optional info dict.

        Priority:
        1. Explicit model_id  ->  use it, fetch info
        2. model_class        ->  query by class, error if empty
        3. Neither            ->  fall back to "gpt-4o" (legacy)

        Returns (effective_model_id, model_info_or_none).
        Raises ValueError when model_class yields no results.
        """
        if model_id:
            model_info = None
            if project_id:
                model_info = await self.resolve_model_info(project_id, model_id)
            return model_id, model_info

        if model_class and project_id:
            resolved = await self.resolve_model_by_class(project_id, model_class)
            if resolved:
                return resolved["id"], resolved
            raise ValueError(
                f"No models of class '{model_class}' found in project {project_id}"
            )

        return "gpt-4o", None
