"""In-memory LRU+TTL cache for agent configs fetched from config-service."""

import time

import httpx
from cachetools import TTLCache
from observability_client_runtime import get_logger

from .service_auth import ServiceAccountClient

logger = get_logger()

_BANNER = "=" * 72


class AgentConfigCache:
    def __init__(
        self,
        config_service_url: str,
        service_auth: ServiceAccountClient,
        ttl_seconds: int = 60,
        max_size: int = 1000,
    ):
        self._cache: TTLCache = TTLCache(maxsize=max_size, ttl=ttl_seconds)
        self._config_service_url = config_service_url
        self._service_auth = service_auth
        self._ttl_seconds = ttl_seconds

        self._access_count: dict[str, int] = {}
        self._last_access: dict[str, float] = {}
        self._total_hits = 0
        self._total_misses = 0
        self._total_refreshes = 0
        self._team_cache: TTLCache = TTLCache(maxsize=max_size, ttl=ttl_seconds)

    async def get(self, project_id: str, agent_id: str) -> dict:
        key = f"{project_id}:{agent_id}"
        now = time.monotonic()
        self._last_access[key] = now
        self._access_count[key] = self._access_count.get(key, 0) + 1

        if key in self._cache:
            self._total_hits += 1
            logger.info(
                ">>> CONFIG CACHE HIT  | agent=%s | cache_size=%d/%d | "
                "access_count=%d | hit_rate=%.1f%%",
                key, len(self._cache), self._cache.maxsize,
                self._access_count[key],
                self._hit_rate_pct(),
            )
            return self._cache[key]

        self._total_misses += 1
        logger.info(
            ">>> CONFIG CACHE MISS | agent=%s | cache_size=%d/%d | "
            "fetching from config-service | hit_rate=%.1f%%",
            key, len(self._cache), self._cache.maxsize,
            self._hit_rate_pct(),
        )
        config = await self._fetch_from_config_service(project_id, agent_id)
        self._cache[key] = config
        self._total_refreshes += 1
        logger.info(
            ">>> CONFIG CACHE LOAD | agent=%s | name=%s | model=%s | "
            "ttl=%ds | cache_size=%d/%d",
            key,
            config.get("name"),
            config.get("modelAlias") or config.get("modelId"),
            self._ttl_seconds,
            len(self._cache), self._cache.maxsize,
        )
        return config

    def invalidate(self, project_id: str, agent_id: str) -> None:
        key = f"{project_id}:{agent_id}"
        self._cache.pop(key, None)
        logger.info(">>> CONFIG CACHE EVICT | agent=%s | manually invalidated", key)

    async def get_team(self, project_id: str, team_id: str) -> dict:
        key = f"{project_id}:{team_id}"
        if key in self._team_cache:
            logger.info(
                ">>> TEAM CONFIG CACHE HIT  | team=%s | cache_size=%d/%d",
                key, len(self._team_cache), self._team_cache.maxsize,
            )
            return self._team_cache[key]

        logger.info(
            ">>> TEAM CONFIG CACHE MISS | team=%s | cache_size=%d/%d | fetching from config-service",
            key, len(self._team_cache), self._team_cache.maxsize,
        )
        config = await self._fetch_team_from_config_service(project_id, team_id)
        self._team_cache[key] = config
        return config

    def _hit_rate_pct(self) -> float:
        total = self._total_hits + self._total_misses
        return (self._total_hits / total * 100) if total > 0 else 0.0

    def status_snapshot(self) -> dict:
        """Return a snapshot of cache state for the periodic status report."""
        now = time.monotonic()
        cached_agents = []
        for key in list(self._cache):
            cfg = self._cache.get(key)
            if cfg is None:
                continue
            age = now - self._last_access.get(key, now)
            cached_agents.append({
                "key": key,
                "name": cfg.get("name"),
                "model": cfg.get("modelAlias") or cfg.get("modelId"),
                "accesses": self._access_count.get(key, 0),
                "idle_seconds": round(age, 1),
            })
        return {
            "cached_agents": cached_agents,
            "cache_size": len(self._cache),
            "cache_max": self._cache.maxsize,
            "ttl_seconds": self._ttl_seconds,
            "total_hits": self._total_hits,
            "total_misses": self._total_misses,
            "total_refreshes": self._total_refreshes,
            "hit_rate_pct": round(self._hit_rate_pct(), 1),
        }

    async def _fetch_from_config_service(
        self, project_id: str, agent_id: str
    ) -> dict:
        headers = await self._service_auth.auth_headers()
        url = f"{self._config_service_url}/api/v1/projects/{project_id}/agents/{agent_id}"
        logger.info("Fetching agent config from %s", url)
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            logger.info(
                "Fetched agent config: agent=%s name=%s modelId=%s modelAlias=%s "
                "temperature=%s maxTokens=%s memoryType=%s "
                "mcpServers=%d kbs=%d keys=[%s]",
                agent_id,
                data.get("name"),
                data.get("modelId"),
                data.get("modelAlias"),
                data.get("temperature"),
                data.get("maxTokens"),
                data.get("memoryType"),
                len(data.get("mcpServerIds", [])),
                len(data.get("knowledgeBaseIds", [])),
                ", ".join(sorted(data.keys())),
            )
            return data

    async def _fetch_team_from_config_service(
        self, project_id: str, team_id: str
    ) -> dict:
        headers = await self._service_auth.auth_headers()
        url = f"{self._config_service_url}/api/v1/projects/{project_id}/agent-teams/{team_id}"
        logger.info("Fetching team config from %s", url)
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            return resp.json()
