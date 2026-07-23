"""Backward-compatibility re-export of :class:`CamelCaseModel`.

The class moved to :mod:`agent_service_maf.core._base_model` to avoid a
circular import (``core.interfaces`` needs the base, but the
``interface_layer`` package eagerly imports models that depend on
``core.interfaces``). The §5.2.1 plan file path is preserved here so
external imports do not break.
"""

from __future__ import annotations

from agent_service_maf.core._base_model import CamelCaseModel

__all__ = ["CamelCaseModel"]
