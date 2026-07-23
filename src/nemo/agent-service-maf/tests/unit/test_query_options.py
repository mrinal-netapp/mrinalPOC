"""Unit tests for :mod:`agent_service_maf.core.query_options`."""

from __future__ import annotations

import pytest

from agent_service_maf.core.query_options import QueryOptions


class TestQueryOptionsDefaults:
    def test_default_staging_is_default(self) -> None:
        opts = QueryOptions()
        assert opts.staging == "default"

    def test_frozen(self) -> None:
        opts = QueryOptions()
        with pytest.raises(AttributeError):
            opts.staging = "playground"  # type: ignore[misc]


class TestQueryOptionsFromQueryParams:
    def test_omitted_maps_to_default(self) -> None:
        opts = QueryOptions.from_query_params({})
        assert opts.staging == "default"

    def test_exact_playground(self) -> None:
        opts = QueryOptions.from_query_params({"staging": "playground"})
        assert opts.staging == "playground"

    @pytest.mark.parametrize("raw", ["default", "eval", "Playground", "", "unknown"])
    def test_every_other_value_maps_to_default(self, raw: str) -> None:
        opts = QueryOptions.from_query_params({"staging": raw})
        assert opts.staging == "default"

    def test_explicit_constructor_playground(self) -> None:
        opts = QueryOptions(staging="playground")
        assert opts.staging == "playground"
