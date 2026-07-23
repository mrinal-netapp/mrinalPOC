"""Per-project Bifrost virtual-key (VK) resolution.

Mirrors the legacy agent-service flow at
``agent-service/src/llmproxy_gateway_settings.py::llmproxy_gateway_api_key_for_model``:
the Bifrost virtual key that authenticates a request is **per-project**,
fetched from config-service, and never falls back to the cluster master
key for per-project chat-completion paths.

Wire shape (matches legacy):
    GET {CONFIG_SERVICE_URL}/api/v1/projects/{project_id}/models/{model_id_hint}
        → { "gatewayApiKey": "<bearer>", "gatewayModelId": "...", ... }

The VK is per-project, not per-model — any model that belongs to the
project returns the same VK. ``model_id_hint`` only exists because
config-service already exposes the VK on the model-detail route; a
future ``GET /projects/{pid}/gateway-vk`` would let callers drop the
hint entirely.

Cache: TTLCache keyed on ``project_id`` (not on the model hint, since
the VK is project-scoped). 60s TTL by default, configurable via env.

Failure mode: ``MissingProjectVirtualKeyError`` on any of:
    * config-service unreachable / 5xx
    * 404 (project has no models — likely incomplete project init)
    * 200 but ``gatewayApiKey`` field absent / empty

Mirrors the legacy ``llmproxy_gateway_settings`` decision: NEVER fall
back to a deployment-wide master key on a per-project chat-completion
path. A silent fallback would bypass team-scoped routing on Bifrost and
defeat per-project rate-limits / budgets. The bundle goes unhealthy
with a clear operator-readable error instead.
"""

from __future__ import annotations

from typing import Any

import httpx
import structlog
from cachetools import TTLCache

logger = structlog.get_logger(__name__)


class MissingProjectVirtualKeyError(RuntimeError):
    """Raised when a project's Bifrost VK is not available.

    Indicates one of:
      * ``ProjectInitWorkflow`` Step 0 (Bifrost team + VK setup) has
        not finished yet.
      * The K8s Secret holding the VK token was deleted out of band.
      * The project's model catalog is empty (no model to look up).
      * config-service is unreachable.

    Surfaced loudly so operators / users know to retry project init
    rather than silently fall back to a deployment-wide key.
    """


class ProjectVKResolver:
    """Fetches and caches per-project Bifrost VK bearers from config-service.

    Args:
        config_service_url: Base URL of config-service (no trailing slash
            required; stripped if present).
        http_client: Shared ``httpx.AsyncClient``. Caller owns the lifecycle
            (constructs at startup, closes at shutdown).
        ttl_seconds: Cache TTL for resolved VKs. Default 60s matches the
            legacy ``ModelResolver`` cache TTL.
        max_size: Maximum cache size. Default 200 = ~one entry per project
            for a moderately-sized cluster.
        service_auth: Optional service-account client whose
            ``auth_headers()`` is awaited and merged into each request.
            ``None`` is valid for dev / no-auth deployments.

    Example::

        resolver = ProjectVKResolver(
            config_service_url=os.environ["CONFIG_SERVICE_URL"],
            http_client=http_client,
            service_auth=service_auth,
        )
        vk = await resolver.get_for_project(project_id, model_id_hint)
    """

    def __init__(
        self,
        *,
        config_service_url: str,
        http_client: httpx.AsyncClient,
        ttl_seconds: int = 60,
        max_size: int = 200,
        service_auth: Any = None,  # noqa: ANN401 - ServiceAccountClient (loose-typed to avoid import cycle)
    ) -> None:
        self._url = config_service_url.rstrip("/")
        self._http = http_client
        self._cache: TTLCache[str, str] = TTLCache(maxsize=max_size, ttl=ttl_seconds)
        self._service_auth = service_auth

    async def _auth_headers(self) -> dict[str, str]:
        if self._service_auth is None:
            return {}
        try:
            return await self._service_auth.auth_headers()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "project_vk_resolver_auth_headers_failed",
                error=str(exc),
            )
            return {}

    async def get_for_project(self, project_id: str, model_id_hint: str) -> str:
        """Return the per-project Bifrost VK bearer.

        Args:
            project_id: Project to resolve the VK for.
            model_id_hint: Any model_id known to belong to the project.
                Used to drive the ``GET /models/:id`` lookup;
                config-service inlines the VK on every model row, so
                which model the hint points at doesn't matter.

        Returns:
            The bearer string to send as ``Authorization: Bearer <vk>``
            on chat-completion requests to Bifrost.

        Raises:
            MissingProjectVirtualKeyError: If the VK cannot be resolved
                from any source. Callers should propagate this so the
                team bundle goes unhealthy with a clear error.
        """
        if not project_id:
            raise MissingProjectVirtualKeyError("ProjectVKResolver: project_id is required")
        if not model_id_hint:
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: model_id_hint required for project "
                f"{project_id!r}. Set a non-empty `gateway.default_model` "
                "on the team config or the model catalog will not be "
                "reachable via /models/:id."
            )

        cached = self._cache.get(project_id)
        if cached is not None:
            return cached

        url = f"{self._url}/api/v1/projects/{project_id}/models/{model_id_hint}"
        try:
            headers = await self._auth_headers()
            resp = await self._http.get(url, headers=headers)
        except httpx.HTTPError as exc:
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: config-service unreachable at {url}: "
                f"{type(exc).__name__}: {exc}. Cannot resolve Bifrost VK "
                f"for project {project_id}."
            ) from exc

        if resp.status_code == 404:
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: model {model_id_hint!r} not found in "
                f"project {project_id} (404). Either the model is not "
                f"registered or ProjectInitWorkflow has not completed "
                f"Step 0 (Bifrost team + VK setup) for this project."
            )
        if resp.status_code != 200:
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: config-service returned "
                f"{resp.status_code} for {url}. Body: {resp.text[:200]!r}"
            )

        try:
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: invalid JSON from {url}: {exc}"
            ) from exc

        vk = data.get("gatewayApiKey") or data.get("gateway_api_key")
        if not vk or not isinstance(vk, str):
            raise MissingProjectVirtualKeyError(
                f"ProjectVKResolver: config-service returned model "
                f"{model_id_hint} for project {project_id} but "
                f"`gatewayApiKey` is missing or empty. The project's "
                f"Bifrost virtual-key Secret "
                f"(as-proj-{project_id}-vk) is likely missing — has "
                f"ProjectInitWorkflow completed Step 0?"
            )

        self._cache[project_id] = vk
        logger.info(
            "project_vk_resolved",
            project_id=project_id,
            cache_size=len(self._cache),
            cache_max=self._cache.maxsize,
        )
        return vk

    def invalidate(self, project_id: str) -> None:
        """Drop the cached VK for a project so the next lookup re-fetches.

        Called from the admin invalidate hook so a VK rotation in
        config-service propagates without requiring a service restart.
        """
        if self._cache.pop(project_id, None) is not None:
            logger.info("project_vk_invalidated", project_id=project_id)

    def invalidate_all(self) -> None:
        """Drop every cached VK. Called on a global config invalidate."""
        size = len(self._cache)
        self._cache.clear()
        if size:
            logger.info("project_vk_cache_cleared", entries=size)

    def status_snapshot(self) -> dict[str, Any]:
        """Operator snapshot of the cache state."""
        return {
            "size": len(self._cache),
            "max_size": self._cache.maxsize,
            "ttl_seconds": int(self._cache.ttl),
        }
