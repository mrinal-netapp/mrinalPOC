"""Request-scoped query options for invoke surfaces.

Centralises parsing of URL query parameters so new flags can be added
without threading individual parameters through every resolve/registry layer.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

_STAGING_PLAYGROUND = "playground"
_STAGING_DEFAULT = "default"


@dataclass(frozen=True)
class QueryOptions:
    """Parsed invoke query parameters for one HTTP or WebSocket request.

    Attributes:
        staging: Normalised staging mode. Only exact, case-sensitive
            ``playground`` enables the config-cache bypass; every other
            wire value maps to ``default``.
    """

    staging: str = _STAGING_DEFAULT

    @classmethod
    def from_query_params(cls, params: Mapping[str, str]) -> QueryOptions:
        """Build options from Starlette ``query_params`` (or any mapping).

        Unknown or invalid ``staging`` values map to ``default``; never
        raises.
        """
        raw = params.get("staging")
        staging = _STAGING_PLAYGROUND if raw == _STAGING_PLAYGROUND else _STAGING_DEFAULT
        return cls(staging=staging)
