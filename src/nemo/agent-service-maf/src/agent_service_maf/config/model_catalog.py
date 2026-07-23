"""Model-catalog protocol + implementations.

The legacy AgentStudio service called
``agent_factory.model_resolver.resolve_model_info(project_id, body.modelId)``
(``src/nemo/agent-service/src/main.py:105-129``) to validate per-request
model overrides against the project's allowed model catalog and to map
the catalog UUID into the ``provider/model-name`` form Bifrost requires:

- Reject unknown models with HTTP 404.
- Reject embedding-type models for chat invocations with HTTP 400.
- Return ``ModelInfo`` (provider, capability flags, gateway-routable id).

This module defines the same protocol and ships two implementations:

* :class:`NoopModelCatalog` — accepts any non-empty string and echoes it
  back unchanged. Used in file mode and unit tests.
* :class:`ConfigServiceModelCatalog` — calls config-service's
  ``GET /api/v1/projects/{pid}/models/{model_id}`` and returns the
  resolved ``gatewayModelId``. Wired in the lifespan when
  ``CONFIG_SOURCE=remote``.

See §5.1.4 / §5.1.7 / §5.1.8 verification item #3 of the migration
plan.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

import structlog

if TYPE_CHECKING:
    from agent_service_maf.config.remote_loader import RemoteConfigCache

logger = structlog.get_logger(__name__)


@dataclass(frozen=True)
class ModelInfo:
    """Minimal model descriptor returned by :class:`ModelCatalog`.

    Mirrors the slice of the legacy ``ModelInfo`` that the override
    path actually used. Additional fields (provider, max_tokens,
    pricing) can be added when the real catalog lands.

    Attributes:
        model_id: Fully-qualified model identifier
            (e.g. ``anthropic/claude-sonnet-4-20250514``).
        is_embedding: ``True`` for embedding-only models -- the route
            handler rejects these for chat invocations.
        allowed: ``True`` when the model is available to the requesting
            project. Stub impl returns ``True`` for any non-empty id.
    """

    model_id: str
    is_embedding: bool = False
    allowed: bool = True


class ModelCatalog(Protocol):
    """Protocol the route-handler uses to validate per-request model
    overrides.

    Production implementations will be backed by the config-service
    bridge (§7 open item #3). The protocol is intentionally narrow so
    that swapping implementations is mechanical -- the route handler
    only needs ``resolve_model_info``.
    """

    async def resolve_model_info(
        self,
        project_id: str,
        model_id: str,
    ) -> ModelInfo | None:
        """Return a :class:`ModelInfo` for the requested model, or
        ``None`` when the model is not in the project's catalog.

        Args:
            project_id: Project that owns the catalog. The catalog may
                expose different model sets per project (subscription
                tier, feature gating, etc.).
            model_id: Model identifier from the request body.

        Returns:
            :class:`ModelInfo` on success; ``None`` when the model is
            unknown to this project. Implementations should NOT raise
            for unknown models -- ``None`` lets the route handler emit
            a clean 404 with structured detail.
        """
        ...


class NoopModelCatalog:
    """No-op catalog -- accepts any non-empty model id.

    Used in file mode and tests. Emits a single INFO-level
    ``model_catalog_stub`` line per call so deployments can grep for
    "still using the stub" when investigating override behavior.
    """

    async def resolve_model_info(
        self,
        project_id: str,
        model_id: str,
    ) -> ModelInfo | None:
        if not model_id:
            return None
        logger.info(
            "model_catalog_stub",
            project_id=project_id,
            model_id=model_id,
            note=(
                "NoopModelCatalog accepts any non-empty model id. "
                "Wire a real ModelCatalog implementation to enforce "
                "per-project allowlists and embedding-model rejection."
            ),
        )
        return ModelInfo(model_id=model_id, is_embedding=False, allowed=True)


def _looks_like_gateway_id(model_id: str) -> bool:
    """``True`` when ``model_id`` is already in ``provider/model-name`` form.

    Bifrost requires this shape; agent records arrive already-resolved
    via :mod:`remote_adapter`. The per-request override path is the
    only caller that may still send a catalog UUID, so the catalog
    short-circuits when the string clearly is not a UUID.
    """
    # Conservative heuristic: anything containing "/" is treated as a
    # gateway-routable id (e.g. "anthropic/claude-sonnet-4-20250514",
    # "azure/projXX_credYY_gpt-4"). Catalog UUIDs are 36 chars with
    # five dashes and no slashes.
    return "/" in model_id


class ConfigServiceModelCatalog:
    """Config-service-backed catalog.

    Resolves catalog UUIDs to ``gatewayModelId`` by hitting
    ``GET /api/v1/projects/{project_id}/models/{model_id}`` via the
    process-wide :class:`RemoteConfigCache` (so the lookup hits the
    same TTL cache the agent / team / KB fetches use).

    Strings that already look like ``provider/model-name`` are
    returned unchanged — the UI playground and eval-worker pass the
    catalog UUID, but tests and direct callers may pass the routable
    form, and that should still work.

    Args:
        remote_cache: Shared remote cache instance. Must outlive every
            request that uses this catalog (lifespan-scoped).
    """

    def __init__(self, remote_cache: RemoteConfigCache) -> None:
        self._cache = remote_cache

    async def resolve_model_info(
        self,
        project_id: str,
        model_id: str,
    ) -> ModelInfo | None:
        if not model_id:
            return None

        # Already routable? Echo back so the override applier writes
        # the same string. This keeps the catalog idempotent and lets
        # callers send either UUID or routable form interchangeably.
        if _looks_like_gateway_id(model_id):
            return ModelInfo(model_id=model_id, is_embedding=False, allowed=True)

        record = await self._cache.get_model(project_id, model_id)
        if record is None:
            logger.warning(
                "model_catalog_unknown",
                project_id=project_id,
                model_id=model_id,
            )
            return None

        gateway_id = record.get("gatewayModelId") or record.get("gateway_model_id")
        if not gateway_id:
            # Match remote_adapter.py's loud-failure stance: a model
            # record without gatewayModelId is a config-service bug
            # (model not registered with Bifrost yet). Returning None
            # here gives the route handler a path to surface a clean
            # 404 once the validator is wired to fail-loud, instead of
            # silently sending the UUID downstream and getting a
            # cryptic "Invalid model string" from Bifrost.
            logger.error(
                "model_catalog_missing_gateway_id",
                project_id=project_id,
                model_id=model_id,
                provider=record.get("provider"),
                provider_model_id=record.get("providerModelId"),
            )
            return None

        is_embedding = bool(
            record.get("isEmbedding")
            or record.get("is_embedding")
            or str(record.get("modelClass", "")).lower() == "embedding",
        )
        return ModelInfo(
            model_id=str(gateway_id),
            is_embedding=is_embedding,
            allowed=True,
        )
