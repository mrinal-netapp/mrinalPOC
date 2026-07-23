"""Helpers for credential/resource dependents API responses."""

from __future__ import annotations

from typing import Any


def dependents_count(payload: dict[str, Any]) -> int:
    """Return total dependent count from config-service dependents payload."""
    if "total" in payload and payload["total"] is not None:
        return int(payload["total"])
    total_by_kind = payload.get("totalByKind") or {}
    if total_by_kind:
        return sum(int(v) for v in total_by_kind.values())
    items = payload.get("items") or payload.get("dependents") or []
    return len(items)
