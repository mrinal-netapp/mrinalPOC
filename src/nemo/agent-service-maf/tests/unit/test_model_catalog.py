"""Unit tests for :mod:`agent_service_maf.config.model_catalog`.

Both implementations of ``ModelCatalog`` are exercised:

* :class:`NoopModelCatalog` — used in file mode and tests; accepts any
  non-empty string and echoes it.
* :class:`ConfigServiceModelCatalog` — config-service backed; resolves
  catalog UUIDs to ``gatewayModelId`` via the shared ``RemoteConfigCache``.

The legacy production behavior these tests pin (per migration plan
§5.1.4 / §5.1.7 / §5.1.8 verification item #3):

* Empty / missing ``model_id`` → ``None``.
* Already-routable ``provider/name`` strings short-circuit (no cache
  fetch, idempotent — UI playground and eval-worker may send either
  shape).
* Cache miss → ``None`` (route handler maps to 404, never crashes).
* Record missing ``gatewayModelId`` → ``None`` (loud-failure stance:
  refuse to silently send the UUID downstream and let Bifrost surface a
  cryptic error).
* ``is_embedding`` is read from ``isEmbedding`` / ``is_embedding`` /
  ``modelClass=='embedding'`` (case-insensitive) so the route handler
  can reject embedding models for chat invocations.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_service_maf.config.model_catalog import (
    ConfigServiceModelCatalog,
    ModelInfo,
    NoopModelCatalog,
    _looks_like_gateway_id,
)

# ---------------------------------------------------------------------------
# _looks_like_gateway_id helper
# ---------------------------------------------------------------------------


class TestLooksLikeGatewayId:
    @pytest.mark.parametrize(
        "model_id",
        [
            "anthropic/claude-sonnet-4-20250514",
            "azure/projXX_credYY_gpt-4",
            "openai/gpt-4o-mini",
        ],
    )
    def test_provider_slash_name_is_gateway_shape(self, model_id: str) -> None:
        assert _looks_like_gateway_id(model_id) is True

    @pytest.mark.parametrize(
        "model_id",
        [
            "096120b4-9dee-4f70-afc3-cd7a5a82e602",  # catalog UUID
            "gpt-5.4",
            "",
            "no-slash-here",
        ],
    )
    def test_no_slash_is_not_gateway_shape(self, model_id: str) -> None:
        assert _looks_like_gateway_id(model_id) is False


# ---------------------------------------------------------------------------
# NoopModelCatalog
# ---------------------------------------------------------------------------


class TestNoopModelCatalog:
    @pytest.mark.asyncio
    async def test_empty_model_id_returns_none(self) -> None:
        cat = NoopModelCatalog()
        assert await cat.resolve_model_info("proj-1", "") is None

    @pytest.mark.asyncio
    async def test_non_empty_model_id_echoes_back(self) -> None:
        cat = NoopModelCatalog()
        info = await cat.resolve_model_info("proj-1", "anthropic/claude-sonnet")
        assert info == ModelInfo(
            model_id="anthropic/claude-sonnet",
            is_embedding=False,
            allowed=True,
        )

    @pytest.mark.asyncio
    async def test_uuid_form_also_echoes(self) -> None:
        # The stub doesn't transform — that's the whole point. A real
        # ConfigServiceModelCatalog would translate UUID → gateway id;
        # this stub passes both shapes through unchanged.
        cat = NoopModelCatalog()
        info = await cat.resolve_model_info(
            "proj-1",
            "096120b4-9dee-4f70-afc3-cd7a5a82e602",
        )
        assert info is not None
        assert info.model_id == "096120b4-9dee-4f70-afc3-cd7a5a82e602"


# ---------------------------------------------------------------------------
# ConfigServiceModelCatalog
# ---------------------------------------------------------------------------


class _StubRemoteCache:
    """Minimal stand-in for ``RemoteConfigCache``.

    Only ``get_model`` is exercised by the catalog; the rest of the cache
    surface (agents, teams, KBs) is irrelevant here. Stores a single
    ``project_id × model_id → record`` map keyed by tuple, returning
    None for any unconfigured pair.
    """

    def __init__(self, records: dict[tuple[str, str], dict[str, Any] | None]) -> None:
        self._records = records
        self.calls: list[tuple[str, str]] = []

    async def get_model(self, project_id: str, model_id: str) -> dict[str, Any] | None:
        self.calls.append((project_id, model_id))
        return self._records.get((project_id, model_id))


class TestConfigServiceModelCatalog:
    @pytest.mark.asyncio
    async def test_empty_model_id_returns_none(self) -> None:
        cache = _StubRemoteCache({})
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        assert await cat.resolve_model_info("proj-1", "") is None
        # Empty short-circuit must NOT hit the cache.
        assert cache.calls == []

    @pytest.mark.asyncio
    async def test_already_routable_shape_is_returned_unchanged(self) -> None:
        # Strings containing "/" are presumed already gateway-routable.
        # The catalog must not consult the cache (idempotency contract).
        cache = _StubRemoteCache({})
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "anthropic/claude-sonnet")
        assert info == ModelInfo(
            model_id="anthropic/claude-sonnet",
            is_embedding=False,
            allowed=True,
        )
        assert cache.calls == []

    @pytest.mark.asyncio
    async def test_uuid_resolved_to_gateway_model_id(self) -> None:
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-1"): {
                    "id": "uuid-1",
                    "gatewayModelId": "azure/proj1_xyz_gpt-5",
                    "providerModelId": "gpt-5",
                    "provider": "azure",
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "uuid-1")
        assert info == ModelInfo(
            model_id="azure/proj1_xyz_gpt-5",
            is_embedding=False,
            allowed=True,
        )
        assert cache.calls == [("proj-1", "uuid-1")]

    @pytest.mark.asyncio
    async def test_snake_case_gateway_model_id_field_accepted(self) -> None:
        # Defensive: some non-typescript callers serialise the field as
        # snake_case. The catalog accepts either spelling.
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-snake"): {
                    "gateway_model_id": "azure/proj1_xyz_gpt-5",
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "uuid-snake")
        assert info is not None
        assert info.model_id == "azure/proj1_xyz_gpt-5"

    @pytest.mark.asyncio
    async def test_cache_miss_returns_none(self) -> None:
        # Project / model not in catalog → cache returns None → catalog
        # returns None. Route handler maps to 404; no exception bubbles.
        cache = _StubRemoteCache({})
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        assert await cat.resolve_model_info("proj-1", "uuid-unknown") is None

    @pytest.mark.asyncio
    async def test_record_missing_gateway_id_returns_none(self) -> None:
        # Loud-failure: a model record that has NO gatewayModelId means
        # config-service hasn't registered the model with Bifrost. The
        # catalog returns None rather than silently sending the UUID
        # downstream and getting a cryptic Bifrost error.
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-no-gw"): {
                    "id": "uuid-no-gw",
                    "provider": "azure",
                    "providerModelId": "gpt-5",
                    # gatewayModelId DELIBERATELY ABSENT
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        assert await cat.resolve_model_info("proj-1", "uuid-no-gw") is None

    @pytest.mark.asyncio
    async def test_empty_gateway_id_treated_as_missing(self) -> None:
        # An empty string is the same failure mode as a missing field —
        # an explicit `gatewayModelId: ""` could mask the registration
        # bug just as effectively. Reject the same way.
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-empty-gw"): {"gatewayModelId": ""},
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        assert await cat.resolve_model_info("proj-1", "uuid-empty-gw") is None

    @pytest.mark.asyncio
    async def test_is_embedding_via_isEmbedding_flag(self) -> None:
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-emb"): {
                    "gatewayModelId": "openai/text-embedding-3-small",
                    "isEmbedding": True,
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "uuid-emb")
        assert info is not None
        assert info.is_embedding is True

    @pytest.mark.asyncio
    async def test_is_embedding_via_snake_case_flag(self) -> None:
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-emb"): {
                    "gatewayModelId": "openai/text-embedding-3-small",
                    "is_embedding": True,
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "uuid-emb")
        assert info is not None
        assert info.is_embedding is True

    @pytest.mark.asyncio
    async def test_is_embedding_via_modelClass(self) -> None:
        # Case-insensitive: "Embedding", "EMBEDDING", "embedding" all
        # flip the flag. Anything else (chat, completion, …) stays False.
        for class_value in ("embedding", "EMBEDDING", "Embedding"):
            cache = _StubRemoteCache(
                {
                    ("proj-1", "uuid-emb"): {
                        "gatewayModelId": "openai/text-embedding-3-small",
                        "modelClass": class_value,
                    },
                }
            )
            cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
            info = await cat.resolve_model_info("proj-1", "uuid-emb")
            assert info is not None
            assert info.is_embedding is True, f"modelClass={class_value!r}"

    @pytest.mark.asyncio
    async def test_non_embedding_modelClass_leaves_flag_false(self) -> None:
        cache = _StubRemoteCache(
            {
                ("proj-1", "uuid-chat"): {
                    "gatewayModelId": "openai/gpt-4o-mini",
                    "modelClass": "chat",
                },
            }
        )
        cat = ConfigServiceModelCatalog(remote_cache=cache)  # type: ignore[arg-type]
        info = await cat.resolve_model_info("proj-1", "uuid-chat")
        assert info is not None
        assert info.is_embedding is False
